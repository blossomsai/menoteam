import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export type WorkState = "current" | "completed";
export type Confidence = "high" | "medium" | "low" | "unknown";

export interface PersonRef {
  id: string;
  displayName: string;
}

export interface CommitRecord {
  sha: string;
  subject: string;
  author?: PersonRef;
  date?: string;
  files?: string[];
}

export interface PullRequestRecord {
  number: number;
  title: string;
  state: string;
  author?: PersonRef | null;
  headRef?: string;
  baseRef?: string;
  url?: string;
  mergedAt?: string | null;
  mergeCommit?: string | null;
}

export interface BranchRecord {
  name: string;
  sha: string;
  mergedIntoMain?: boolean;
  commits?: string[];
}

export interface TagRecord {
  name: string;
  sha: string;
}

export interface SafeDriverSnapshot {
  repository: string;
  ref: string;
  commit: string;
  generatedAt: string;
  remoteUrl?: string;
  authors?: Array<PersonRef & { commits: number }>;
  pullRequests?: PullRequestRecord[];
  commits: CommitRecord[];
  branches?: BranchRecord[];
  tags?: TagRecord[];
  files: string[];
  warnings?: string[];
}

export interface EvidenceRef {
  kind: "commit" | "pull_request" | "branch" | "tree" | "tag" | "history";
  ref: string;
  label: string;
  detail?: string;
  url?: string;
}

export interface OwnerCandidate {
  status: "candidate" | "unresolved";
  provenance: "inferred" | "unresolved";
  person: PersonRef | null;
  confirmed: false;
  confidence: Confidence;
  rationale: string;
  evidence: EvidenceRef[];
  alternatives: Array<{
    person: PersonRef;
    confidence: Confidence;
    score: number;
  }>;
}

export interface LivingDoc {
  id: string;
  title: string;
  content: string;
  references: EvidenceRef[];
}

export interface WorkNode {
  id: string;
  title: string;
  state: WorkState;
  stateConfirmed: false;
  stateBasis: "present_on_latest_main" | "project_root";
  owner: OwnerCandidate;
  parentId: string | null;
  dependencyIds: string[];
  currentSummary: string;
  livingDoc: LivingDoc;
  evidence: EvidenceRef[];
}

export interface WorkMapImport {
  schema: "menoteam.work-map.v1";
  importer: "safedriver-plan";
  source: {
    repository: string;
    ref: string;
    commit: string;
    generatedAt: string;
    remoteUrl?: string;
    history: {
      commitCount: number;
      branchCount: number;
      tagCount: number;
      pullRequestCount: number;
      pullRequestsAvailable: boolean;
    };
  };
  workNodes: WorkNode[];
  teammateMemories: Array<{
    person: PersonRef;
    content: string;
    wordCount: number;
    evidence: EvidenceRef[];
  }>;
  unmergedBranches: Array<{
    name: string;
    sha: string;
    evidence: EvidenceRef;
  }>;
  warnings: string[];
}

interface FeatureRule {
  id: string;
  title: string;
  summary: string;
  pathPatterns: RegExp[];
  textPatterns: RegExp[];
  parentId?: string;
}

interface FeatureMatches {
  rule: FeatureRule;
  files: string[];
  commits: CommitRecord[];
  pullRequests: PullRequestRecord[];
  branches: BranchRecord[];
}

interface CandidateScore {
  person: PersonRef;
  score: number;
  evidence: EvidenceRef[];
  hasMergedPullRequest: boolean;
  matchingCommitCount: number;
}

const PROJECT_NODE_ID = "sdp:platform";
const EVIDENCE_LIMIT = 12;

// This is a small, source-backed catalog rather than one Work per file or commit.
// Each boundary uses current route/component/domain names; history only enriches
// evidence and owner inference after the capability is present on latest main.
const FEATURE_RULES: FeatureRule[] = [
  {
    id: "sdp:employee-foundation",
    title: "Employee roster and identity foundation",
    summary:
      "The tenant-scoped Employee record, roster imports, references, and employee-facing operational views.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Drivers|DriverDetail)Page\.jsx$/i,
      /frontend\/src\/components\/(?:DriverImportWorkspace|Employee(?:AdditionalInformation|FieldCatalog|ImportSetupReview|JobRoleManager|ProfileField|ReferenceReview|ViewCustomizeDrawer))\.jsx$/i,
      /src\/(?:drivers-api|driver-(?:bulk-import|import|list-read|store)|employee-(?:identity|import|operational-search|record-id|reference-resolution|roster-sync|view(?:-.*)?))\.mjs$/i,
      /supabase\/migrations\/20260605_safe_driver_plan_core_tables\.sql$/i,
    ],
    textPatterns: [
      /employee (?:roster|identity|reference|search)/i,
      /driver roster/i,
      /roster import/i,
    ],
  },
  {
    id: "sdp:employee-qr-login",
    title: "Employee QR login",
    parentId: "sdp:employee-foundation",
    summary:
      "Profile-linked QR credential issuance and camera/manual-code Employee sign-in with hash-only bearer storage.",
    pathPatterns: [
      /frontend\/src\/components\/QrLoginScanner\.jsx$/i,
      /src\/(?:employee-qr-login|server-qr-login-api)\.mjs$/i,
      /supabase\/migrations\/20260815_02_employee_qr_login\.sql$/i,
    ],
    textPatterns: [/qr login/i, /qr credential/i, /employee qr/i],
  },
  {
    id: "sdp:vehicle-roster",
    title: "Vehicle roster",
    summary:
      "The tenant-owned Vehicle roster with stable Vehicle IDs, imported descriptive fields, and editable records.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Vehicles|VehicleDetail)Page\.jsx$/i,
      /frontend\/src\/components\/Vehicle(?!ImportWorkspace)\.jsx$/i,
      /src\/(?:vehicles-api|vehicle-api-context|vehicle-record-mutations|vehicle-records|vehicle-store|district-postgres-vehicle-store)\.mjs$/i,
      /supabase\/migrations\/20260812_vehicle_module\.sql$/i,
    ],
    textPatterns: [/vehicle (?:record|roster|fields?)/i, /fleet roster/i],
  },
  {
    id: "sdp:vehicle-imports",
    title: "Vehicle imports",
    parentId: "sdp:vehicle-roster",
    summary:
      "Reviewable Vehicle CSV/import workflows that preserve source values and use stable Vehicle IDs.",
    pathPatterns: [
      /frontend\/src\/components\/VehicleImportWorkspace\.jsx$/i,
      /src\/vehicle-import(?:-.*)?\.mjs$/i,
      /supabase\/migrations\/20260812_vehicle_module\.sql$/i,
    ],
    textPatterns: [/vehicle (?:roster )?imports?/i, /import vehicle/i],
  },
  {
    id: "sdp:crash-investigation",
    title: "Crash cases and investigation procedures",
    summary:
      "Crash Investigation Cases, configurable procedures, case evidence, outcomes, and investigation history.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Cases|CaseDetail|CaseProcedure|CaseBulk|NewCase)Page\.jsx$/i,
      /frontend\/src\/components\/(?:Case(?!RetrainingPanel|StartChoices|VehicleSelector|EmployeeSelect).+|Crash(?:Procedure|Investigation).+)\.jsx$/i,
      /src\/(?:cases-api|case-(?:api|artifact|bulk|evidence|event|material|outcome|record|reanalysis|review|status|source)|crash-investigation(?:-.*)?|domain-(?:case|operational-case-file)|district-postgres-(?:case|core-case|crash-investigation).*)\.mjs$/i,
      /supabase\/migrations\/(?:20260812_02_crash_investigation_procedure|202608230900_case_record_model_v2)\.sql$/i,
    ],
    textPatterns: [/crash investigation/i, /crash case/i, /case record model/i, /investigation procedure/i],
  },
  {
    id: "sdp:crash-participants-statements",
    title: "Crash participants and statements",
    summary:
      "Multi-Employee and multi-Vehicle case participants with scoped Employee Statements and editable factual case setup.",
    parentId: "sdp:crash-investigation",
    pathPatterns: [
      /frontend\/src\/components\/(?:CaseStartChoices|CaseVehicleSelector|EmployeeMultiSelect|CrashInvestigationHandoffResource)\.jsx$/i,
      /src\/(?:case-assignment-options|case-investigator-permissions|case-record-graph|crash-investigation-handoff-api|district-postgres-case-participants)\.mjs$/i,
      /supabase\/migrations\/20260813_crash_investigation_vehicles\.sql$/i,
    ],
    textPatterns: [/case participants?/i, /employee statements?/i, /participant selection/i],
  },
  {
    id: "sdp:crash-retraining",
    title: "Crash-to-training retraining loop",
    summary:
      "The durable link from a Crash Investigation Case to one or more independent Training Occurrences.",
    parentId: "sdp:crash-investigation",
    pathPatterns: [
      /frontend\/src\/components\/CaseRetrainingPanel\.jsx$/i,
      /src\/crash-retraining-api\.mjs$/i,
      /supabase\/migrations\/202608150900_crash_retraining(?:_multiple)?\.sql$/i,
    ],
    textPatterns: [/crash retraining/i, /retraining session/i],
  },
  {
    id: "sdp:training-operations",
    title: "Training setups and occurrences",
    summary:
      "Reusable Training Setups, Training Occurrences, participant records, evidence, completion, and trainer operations.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Training|TrainingSignup)Page\.jsx$/i,
      /frontend\/src\/components\/(?:Training(?:Home|Nav|EmployeeSelector|OccurrenceParticipantAdder|OccurrenceRoster|ParticipantStatus|AttendanceCheckIn|SetupWorkspace|RecordLink)|TrainingHistoryFields)\.jsx$/i,
      /src\/(?:training-(?:api|domain|import|store(?:-.*)?|upload-matching)|district-postgres-training-(?:list|operations|overview|store))\.mjs$/i,
      /supabase\/migrations\/20260804_training_operations\.sql$/i,
    ],
    textPatterns: [/training setup/i, /training occurrence/i, /training operations/i],
  },
  {
    id: "sdp:training-scheduling",
    title: "Training class scheduling",
    summary:
      "Capacity-limited Training Classes, recurring schedules, invitations, signup, and attendance-ready rosters.",
    parentId: "sdp:training-operations",
    pathPatterns: [
      /frontend\/src\/components\/Training(?:SchedulingWorkspace|ClassFields|Signup(?:Detail|Form))\.jsx$/i,
      /src\/(?:training-scheduling-api|training-scheduling-domain|district-postgres-training-scheduling)\.mjs$/i,
      /supabase\/migrations\/20260813_training_scheduling\.sql$/i,
    ],
    textPatterns: [/training (?:class|schedule|scheduling)/i, /refresher scheduling/i],
  },
  {
    id: "sdp:training-materials-handoff",
    title: "Training materials and secure handoff",
    summary:
      "Filename-only Training Materials, protected previews, and same-device trainer/trainee handoff resources.",
    parentId: "sdp:training-operations",
    pathPatterns: [
      /frontend\/src\/components\/TrainingMaterials(?:Library|Manager|HandoffAction|HandoffResource)\.jsx$/i,
      /frontend\/src\/components\/(?:DeviceHandoffPage|DeviceHandoffSetupForm|FillableFormHandoffResource)\.jsx$/i,
      /src\/(?:training-materials-api|training-materials|training-source-material|device-handoff(?:-.*)?|local-device-handoff-store)\.mjs$/i,
      /supabase\/migrations\/20260814_training_materials\.sql$/i,
    ],
    textPatterns: [/training materials?/i, /shared-device handoff/i, /secure handoff/i],
  },
  {
    id: "sdp:training-forms-quizzes",
    title: "Training forms and quizzes",
    summary:
      "Fillable Training forms, quiz-enabled evidence, immutable attempts, autograding, and trainer review.",
    parentId: "sdp:training-operations",
    pathPatterns: [
      /frontend\/src\/components\/(?:TraineeTraining(?:Form|QuizForm)|TrainingQuiz.+|TrainingFormNavigator)\.jsx$/i,
      /src\/(?:training-form-participant|training-quiz(?:-.*)?|district-postgres-training-quiz(?:-.*)?)\.mjs$/i,
      /supabase\/migrations\/(?:202608121200_training_quiz_autograding|20260813_training_quiz_template_enabled)\.sql$/i,
    ],
    textPatterns: [/training quiz/i, /quiz autograding/i, /fillable training form/i],
  },
  {
    id: "sdp:hiring",
    title: "Transportation hiring",
    summary:
      "Tenant-scoped Applicants, Applications, configurable Hiring Processes, source uploads, and explicit Hiring Handoff into Training.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Hiring|HiringApplication|HiringHistory|HiringImport|NewHiringApplication)Page\.jsx$/i,
      /frontend\/src\/components\/Hiring.+\.jsx$/i,
      /src\/(?:hiring(?:-.*)?|confidential-hiring-.+|district-postgres-hiring-.+)\.mjs$/i,
      /supabase\/migrations\/20260812_transportation_hiring\.sql$/i,
    ],
    textPatterns: [/transportation hiring/i, /hiring (?:workflow|history|handoff)/i, /applicant record/i],
  },
  {
    id: "sdp:discipline",
    title: "Discipline records and policy",
    summary:
      "Operational Discipline records, points/rules, policy configuration, bulk imports, review, and Employee history.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Discipline|DisciplineDetail|DisciplineBulk|DisciplinePolicy|NewDiscipline)Page\.jsx$/i,
      /frontend\/src\/components\/Discipline.+\.jsx$/i,
      /src\/(?:discipline(?:-.*)?|district-postgres-discipline-.+)\.mjs$/i,
      /supabase\/migrations\/20260728_behavior_discipline\.sql$/i,
    ],
    textPatterns: [/discipline (?:record|policy|workflow)/i, /behavior discipline/i],
  },
  {
    id: "sdp:attendance",
    title: "Attendance records and policy",
    summary:
      "Operational Attendance occurrences, records, policy configuration, bulk imports, and Employee-linked review.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Attendance|AttendanceDetail|AttendanceBulk|AttendancePolicy|NewAttendance)Page\.jsx$/i,
      /frontend\/src\/components\/Attendance.+\.jsx$/i,
      /src\/(?:attendance(?:-.*)?|district-postgres-attendance-.+)\.mjs$/i,
      /supabase\/migrations\/202608181000_attendance_occurrences_reviews\.sql$/i,
    ],
    textPatterns: [/attendance (?:record|policy|occurrence)/i, /attendance domain/i],
  },
  {
    id: "sdp:policy",
    title: "Policy management",
    summary:
      "Versioned tenant policy documents, rules, effective periods, source materials, drafts, and reviewable extraction.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Policy|PolicyMaterial)Page\.jsx$/i,
      /frontend\/src\/components\/(?:Policy|ArchivedPolicy).+\.jsx$/i,
      /src\/(?:policy(?:-.*)?|district-postgres-policy-.+)\.mjs$/i,
      /supabase\/migrations\/(?:20260810_unified_scoped_policy|20260725_policy_version_archive_fields)\.sql$/i,
    ],
    textPatterns: [/policy (?:management|draft|version|rules?)/i, /policy uploads?/i],
  },
  {
    id: "sdp:documents",
    title: "Documents and source intake",
    summary:
      "Tenant-scoped Documents, Source Uploads, intake review, previews, retained provenance, and record-linked files.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Documents|DocumentIntake)Page\.jsx$/i,
      /frontend\/src\/components\/(?:Documents|Document|Source).+\.jsx$/i,
      /src\/(?:document(?:s)?(?:-.*)?|documents-api|source-material(?:-.*)?|direct-upload-api|office-document-preview-extractors)\.mjs$/i,
      /supabase\/migrations\/20260626_tenant_documents\.sql$/i,
    ],
    textPatterns: [/document workspace/i, /source (?:upload|intake)/i, /document intake/i],
  },
  {
    id: "sdp:confidential-documents",
    title: "Confidential document controls",
    parentId: "sdp:documents",
    summary:
      "Server-side classification, password/session gates, disclosure audit, protected previews, and confidential Hiring source access.",
    pathPatterns: [
      /frontend\/src\/components\/ConfidentialDocument.+\.jsx$/i,
      /src\/(?:confidential-.+|document-intake-confidential-presentation|confidential-hiring-.+)\.mjs$/i,
      /supabase\/migrations\/(?:20260812_strictly_confidential_documents|20260813_hiring_source_confidentiality)\.sql$/i,
    ],
    textPatterns: [/strictly confidential/i, /confidential document/i, /source confidentiality/i],
  },
  {
    id: "sdp:credential-tracking",
    title: "Employee credential tracking",
    parentId: "sdp:employee-foundation",
    summary:
      "Employee credential types, protected evidence intake, expiration status, reminders, and release verification.",
    pathPatterns: [
      /frontend\/src\/components\/(?:EmployeeCredentials|Credential.+)\.jsx$/i,
      /src\/(?:credential-.+|employee-credentials-api|confidential-driver-api)\.mjs$/i,
      /supabase\/migrations\/20260728_driver_credential_tracking\.sql$/i,
    ],
    textPatterns: [/driver credential/i, /credential tracking/i, /credential intake/i],
  },
  {
    id: "sdp:assistant",
    title: "Access-aware Assistant",
    summary:
      "Read-only Assistant conversations, scoped tools, citations, actions, and transient evidence projections.",
    pathPatterns: [
      /frontend\/src\/pages\/ChatPage\.jsx$/i,
      /frontend\/src\/components\/Assistant.+\.jsx$/i,
      /src\/(?:assistant-.+|chat-.+|ask-the-bus-.+|agent-.+|vertex-assistant-provider)\.mjs$/i,
      /supabase\/migrations\/2026062[01]_chat_.+\.sql$/i,
    ],
    textPatterns: [/access-aware assistant/i, /assistant tool/i, /ask the bus/i],
  },
  {
    id: "sdp:audit",
    title: "Audit history",
    summary:
      "Immutable record and disclosure audit history with redaction, chain integrity, and review presentation.",
    pathPatterns: [
      /frontend\/src\/pages\/AuditLogPage\.jsx$/i,
      /frontend\/src\/components\/(?:Audit|RecordActivity).+\.jsx$/i,
      /src\/(?:audit-.+|compliance-export-audit|intake-audit|document-intake-audit|forms-audit|training-audit)\.mjs$/i,
      /supabase\/migrations\/20260803_.+audit.+\.sql$/i,
    ],
    textPatterns: [/audit history/i, /audit release/i, /disclosure audit/i],
  },
  {
    id: "sdp:settings",
    title: "Account and tenant settings",
    summary:
      "Tenant module configuration, school years, roles, platform fields, account access, and settings release validation.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Account|PlatformSettings)Page\.jsx$/i,
      /frontend\/src\/components\/(?:Account|Platform|RoleAccess|Settings).+\.jsx$/i,
      /src\/(?:auth-.+|module-settings(?:-.*)?|account-.+|district-(?:isolation|db-runtime|backup)-.+)\.mjs$/i,
      /supabase\/migrations\/20260801_01_school_year_current\.sql$/i,
    ],
    textPatterns: [/platform settings/i, /tenant configuration/i, /settings release/i],
  },
  {
    id: "sdp:forms",
    title: "Module-owned forms",
    summary:
      "Module-owned fillable forms, templates, calculations, immutable finalization, and record-linked form history.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Forms|FormDetail|FormTemplate)Page\.jsx$/i,
      /frontend\/src\/components\/(?:Form|Forms).+\.jsx$/i,
      /src\/(?:form(?:s)?-.+|forms-.+|district-postgres-forms-.+)\.mjs$/i,
      /supabase\/migrations\/20260701_forms_phase1\.sql$/i,
    ],
    textPatterns: [/module-owned forms?/i, /form template/i, /immutable finalization/i],
  },
  {
    id: "sdp:reports",
    title: "Reports and output templates",
    summary:
      "Report drafts, templates, exports, generated files, and evidence-backed template learning.",
    pathPatterns: [
      /frontend\/src\/pages\/(?:Reports|ReportDraft|ReportTemplate|GenerateReportDraft|NewReportTemplate|ReportTemplateLearning)Page\.jsx$/i,
      /frontend\/src\/components\/(?:OutputTemplate|Report).+\.jsx$/i,
      /src\/(?:report(?:s)?-.+|reports-.+|output-template-.+)\.mjs$/i,
      /supabase\/migrations\/20260624_report_app_ids\.sql$/i,
    ],
    textPatterns: [/report (?:draft|template|generation)/i, /output template/i, /report learning/i],
  },
];

const SENSITIVE_PATH = /(^|\/)(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx|crt|secret)$)/i;
const TOKEN_LIKE =
  /(gh[pousr]_[A-Za-z0-9_\-]{12,}|github_pat_[A-Za-z0-9_\-]{12,}|sk-[A-Za-z0-9_\-]{12,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._\-]{12,}|(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+)/gi;

function redact(value: string): string {
  return value.replace(TOKEN_LIKE, "[redacted]");
}

function safePath(value: string): string | null {
  const path = redact(value.trim());
  return SENSITIVE_PATH.test(path) || path.includes("[redacted]") ? null : path;
}

function safeText(value: string | undefined | null): string {
  return redact(String(value ?? "")).trim();
}

function safeUrl(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function repositoryUrl(
  snapshot: SafeDriverSnapshot,
  kind: "commit" | "blob" | "tree",
  ref: string,
  path?: string
): string | undefined {
  const remote = safeUrl(snapshot.remoteUrl)?.replace(/\/$/u, "");
  if (!remote) return undefined;
  const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
  const encodedPath = path?.split("/").map(encodeURIComponent).join("/");
  return safeUrl(`${remote}/${kind}/${encodedRef}${encodedPath ? `/${encodedPath}` : ""}`);
}

function personId(author: PersonRef | undefined | null): string | null {
  return author?.id?.trim() || null;
}

function identityKey(author: PersonRef): string {
  const displayName = author.displayName.trim().toLocaleLowerCase();
  if (displayName) return displayName;
  return author.id.replace(/^(?:git|github):/i, "").toLocaleLowerCase();
}

function normalizePerson(author: PersonRef | undefined | null): PersonRef | null {
  if (!author?.id?.trim()) return null;
  return {
    id: safeText(author.id),
    displayName: safeText(author.displayName || author.id),
  };
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

function limitedEvidence(values: EvidenceRef[]): EvidenceRef[] {
  return unique(values, (item) => `${item.kind}:${item.ref}`).slice(0, EVIDENCE_LIMIT);
}

function limitedOwnerEvidence(values: EvidenceRef[]): EvidenceRef[] {
  const uniqueValues = unique(values, (item) => `${item.kind}:${item.ref}`);
  if (uniqueValues.length <= EVIDENCE_LIMIT) return uniqueValues;
  const selected = ["pull_request", "commit", "branch", "tree", "tag", "history"]
    .flatMap((kind) => uniqueValues.find((item) => item.kind === kind) ?? []);
  return [...selected, ...uniqueValues.filter((item) => !selected.includes(item))].slice(0, EVIDENCE_LIMIT);
}

function confidenceFor(score: CandidateScore, runnerUp: CandidateScore | undefined): Confidence {
  if (score.matchingCommitCount >= 1 && score.hasMergedPullRequest && (!runnerUp || score.score >= runnerUp.score * 2)) {
    return "high";
  }
  if (score.score >= 3 && (!runnerUp || score.score > runnerUp.score)) return "medium";
  if (score.score > 0) return "low";
  return "unknown";
}

function featureTextMatches(rule: FeatureRule, value: string): boolean {
  return matchesAny(value, rule.textPatterns);
}

function findMatches(snapshot: SafeDriverSnapshot, rule: FeatureRule): FeatureMatches {
  const files = snapshot.files
    .map(safePath)
    .filter((file): file is string => Boolean(file))
    .filter((file) => matchesAny(file, rule.pathPatterns));
  const commits = snapshot.commits.filter((commit) => {
    const subjectMatch = featureTextMatches(rule, commit.subject);
    const fileMatch = (commit.files ?? []).some((file) =>
      matchesAny(file, rule.pathPatterns)
    );
    return subjectMatch || fileMatch;
  });
  const matchingCommitShas = new Set(commits.map((commit) => commit.sha));
  const pullRequests = (snapshot.pullRequests ?? []).filter((pr) => {
    return (
      featureTextMatches(rule, pr.title) ||
      featureTextMatches(rule, pr.headRef ?? "") ||
      (pr.mergeCommit !== undefined &&
        pr.mergeCommit !== null &&
        matchingCommitShas.has(pr.mergeCommit))
    );
  });
  const branches = (snapshot.branches ?? []).filter((branch) => {
    return (
      featureTextMatches(rule, branch.name) ||
      (branch.commits ?? []).some((sha) => matchingCommitShas.has(sha))
    );
  });
  return { rule, files, commits, pullRequests, branches };
}

function evidenceForMatches(matches: FeatureMatches, snapshot: SafeDriverSnapshot): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  const pathLimit = matches.rule.id === PROJECT_NODE_ID ? 0 : 4;
  for (const file of matches.files.slice(0, pathLimit)) {
    refs.push({
      kind: "tree",
      ref: `${snapshot.commit}:${file}`,
      label: `Latest main contains ${file}`,
      url: repositoryUrl(snapshot, "blob", snapshot.commit, file),
      detail: "Path exists on the imported ref; presence is not deployment proof.",
    });
  }
  for (const commit of matches.commits.slice(0, 4)) {
    refs.push({
      kind: "commit",
      ref: commit.sha,
      label: safeText(commit.subject) || `Commit ${commit.sha.slice(0, 8)}`,
      url: repositoryUrl(snapshot, "commit", commit.sha),
      detail: "Historical commit matched the feature boundary.",
    });
  }
  for (const pr of matches.pullRequests.slice(0, 4)) {
    refs.push({
      kind: "pull_request",
      ref: `#${pr.number}`,
      label: safeText(pr.title) || `Pull request #${pr.number}`,
      url: safeUrl(pr.url),
      detail: `${safeText(pr.state)} PR metadata; merge proves code integration, not deployment.`,
    });
  }
  for (const branch of matches.branches.slice(0, 2)) {
    refs.push({
      kind: "branch",
      ref: safeText(branch.name),
      label: `Historical branch ${safeText(branch.name)}`,
      url: repositoryUrl(snapshot, "tree", branch.name),
      detail: branch.mergedIntoMain
        ? "Branch tip is an ancestor of latest main."
        : "Branch is not an ancestor of latest main and was not imported as durable Work.",
    });
  }
  return limitedEvidence(refs);
}

function candidateScores(matches: FeatureMatches, snapshot: SafeDriverSnapshot): CandidateScore[] {
  const byPerson = new Map<string, CandidateScore>();
  const add = (
    author: PersonRef | undefined | null,
    score: number,
    evidence: EvidenceRef,
    commit = false,
    mergedPr = false
  ) => {
    const person = normalizePerson(author);
    const id = personId(person ?? undefined);
    if (!person || !id) return;
    const key = identityKey(person);
    const current = byPerson.get(key) ?? {
      person,
      score: 0,
      evidence: [],
      hasMergedPullRequest: false,
      matchingCommitCount: 0,
    };
    if (current.person.id.startsWith("git:") && person.id.startsWith("github:")) {
      current.person = person;
    }
    current.score += score;
    current.evidence.push(evidence);
    if (commit) current.matchingCommitCount += 1;
    if (mergedPr) current.hasMergedPullRequest = true;
    byPerson.set(key, current);
  };

  for (const commit of matches.commits) {
    add(
      commit.author,
      1,
      {
        kind: "commit",
        ref: commit.sha,
        label: safeText(commit.subject) || `Commit ${commit.sha.slice(0, 8)}`,
      },
      true
    );
  }
  for (const pr of matches.pullRequests) {
    add(
      pr.author,
      4,
      {
        kind: "pull_request",
        ref: `#${pr.number}`,
        label: safeText(pr.title) || `Pull request #${pr.number}`,
        url: safeUrl(pr.url),
      },
      false,
      String(pr.state).toUpperCase() === "MERGED" || Boolean(pr.mergedAt)
    );
  }
  const matchingCommitShas = new Set(matches.commits.map((commit) => commit.sha));
  for (const branch of matches.branches) {
    const branchEvidence: EvidenceRef = {
      kind: "branch",
      ref: safeText(branch.name),
      label: `Historical branch ${safeText(branch.name)}`,
    };
    for (const commit of matches.commits) {
      if ((branch.commits ?? []).includes(commit.sha) && matchingCommitShas.has(commit.sha)) {
        add(commit.author, 2, branchEvidence);
      }
    }
  }
  if (!byPerson.size && matches.rule.id === PROJECT_NODE_ID) {
    for (const author of snapshot.authors ?? []) {
      add(
        author,
        author.commits,
        {
          kind: "history",
          ref: snapshot.ref,
          label: `${author.commits} commits on ${snapshot.ref}`,
        },
        true
      );
    }
  }
  return [...byPerson.values()].sort((a, b) => b.score - a.score || a.person.id.localeCompare(b.person.id));
}

function inferOwner(matches: FeatureMatches, snapshot: SafeDriverSnapshot): OwnerCandidate {
  const scores = candidateScores(matches, snapshot);
  const best = scores[0];
  if (!best) {
    return {
      status: "unresolved",
      provenance: "unresolved",
      person: null,
      confirmed: false,
      confidence: "unknown",
      rationale:
        "No author, merged pull request, or branch evidence matched this Work. A human owner must be confirmed separately.",
      evidence: [],
      alternatives: [],
    };
  }
  const runnerUp = scores[1];
  const confidence = confidenceFor(best, runnerUp);
  const allEvidence = limitedOwnerEvidence(best.evidence);
  const alternatives = scores.slice(1, 4).map((candidate) => ({
    person: candidate.person,
    confidence: confidenceFor(candidate, best),
    score: candidate.score,
  }));
  return {
    status: "candidate",
    provenance: "inferred",
    person: best.person,
    confirmed: false,
    confidence,
    rationale:
      `${best.person.displayName} is a candidate based on ${best.matchingCommitCount} matching commit(s)` +
      `${best.hasMergedPullRequest ? " and merged pull-request authorship" : ""}. ` +
      "This is repository evidence, not confirmed human ownership; confirm or override before creating Work.",
    evidence: allEvidence,
    alternatives,
  };
}

function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function markdownText(value: string): string {
  return value.replace(/[\\[\]]/gu, "\\$&");
}

function evidenceLine(item: EvidenceRef): string {
  const label = markdownText(item.label);
  const source = item.url ? `[${label}](${item.url})` : label;
  return `- ${source} (${item.kind}:${item.ref})`;
}

function makeLivingDoc(
  nodeTitle: string,
  summary: string,
  evidence: EvidenceRef[],
  snapshot: SafeDriverSnapshot
): LivingDoc {
  const evidenceLines = evidence.length
    ? evidence.map(evidenceLine).join("\n")
    : "- No direct repository evidence was found.";
  const snapshotLabel = `${snapshot.ref} @ ${snapshot.commit}`;
  const snapshotUrl = repositoryUrl(snapshot, "commit", snapshot.commit);
  const snapshotSource = snapshotUrl
    ? `[${markdownText(snapshotLabel)}](${snapshotUrl})`
    : snapshotLabel;
  const content = [
    `# ${nodeTitle}`,
    "",
    "## Current understanding",
    summary,
    "",
    "## Source snapshot",
    `- ${snapshotSource}`,
    "",
    "## Provenance and limits",
    "This document is an import from Safe Driver Plan repository evidence. It describes durable context suggested by the latest main tree and historical changes; it does not prove deployment, current activity, product adoption, or confirmed ownership.",
    "",
    "## Evidence",
    evidenceLines,
  ].join("\n");
  return {
    id: `living-doc:${nodeTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    title: `${nodeTitle} — Living Doc`,
    content,
    references: evidence,
  };
}

function makeProjectMatches(snapshot: SafeDriverSnapshot): FeatureMatches {
  const rule: FeatureRule = {
    id: PROJECT_NODE_ID,
    title: "Safe Driver Plan",
    summary:
      "A tenant-scoped transportation safety platform centered on the Employee record and module-owned operational workflows.",
    pathPatterns: [/.*/],
    textPatterns: [/.*/],
  };
  return {
    rule,
    files: snapshot.files.map(safePath).filter((file): file is string => Boolean(file)),
    commits: snapshot.commits,
    pullRequests: snapshot.pullRequests ?? [],
    branches: snapshot.branches ?? [],
  };
}

function createNode(matches: FeatureMatches, snapshot: SafeDriverSnapshot): WorkNode {
  const evidence = evidenceForMatches(matches, snapshot);
  const owner = inferOwner(matches, snapshot);
  const title = matches.rule.title;
  const matchingFiles = matches.files.length;
  const matchingCommits = matches.commits.length;
  const currentSummary = `${matches.rule.summary} Latest-main evidence includes ${matchingFiles} matching path(s) and ${matchingCommits} historical commit(s). The importer keeps this as current context because the capability is represented on ${snapshot.ref}; source evidence alone cannot establish release or completion status.`;
  return {
    id: matches.rule.id,
    title,
    state: "current",
    stateConfirmed: false,
    stateBasis: matches.rule.id === PROJECT_NODE_ID ? "project_root" : "present_on_latest_main",
    owner,
    parentId: matches.rule.parentId ?? (matches.rule.id === PROJECT_NODE_ID ? null : PROJECT_NODE_ID),
    dependencyIds: [],
    currentSummary,
    livingDoc: makeLivingDoc(title, currentSummary, evidence, snapshot),
    evidence,
  };
}

function nodeOwnerKey(node: WorkNode): string | null {
  return node.owner.person ? identityKey(node.owner.person) : null;
}

function makeTeammateMemories(nodes: WorkNode[]): WorkMapImport["teammateMemories"] {
  const grouped = new Map<string, { person: PersonRef; titles: string[]; evidence: EvidenceRef[] }>();
  for (const node of nodes) {
    const person = node.owner.person;
    const key = nodeOwnerKey(node);
    if (!person || !key) continue;
    const group = grouped.get(key) ?? { person, titles: [], evidence: [] };
    if (group.person.id.startsWith("git:") && person.id.startsWith("github:")) {
      group.person = person;
    }
    if (node.id !== PROJECT_NODE_ID) group.titles.push(node.title);
    group.evidence.push(...node.owner.evidence.slice(0, 2));
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => {
    const titles = group.titles.length ? group.titles.slice(0, 5).join(", ") : "the project history";
    const content = `${group.person.displayName} appears in repository evidence associated with ${titles}. This Teammate Memory is a routing hint only: it is derived from commits and pull requests, does not assert employment or ownership, and must be corrected by a human when context differs.`;
    return {
      person: group.person,
      content,
      wordCount: wordCount(content),
      evidence: limitedEvidence(group.evidence),
    };
  });
}

export function importSafeDriverPlan(snapshot: SafeDriverSnapshot): WorkMapImport {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("A repository snapshot is required.");
  if (!snapshot.repository?.trim()) throw new TypeError("snapshot.repository is required.");
  if (!snapshot.ref?.trim()) throw new TypeError("snapshot.ref is required.");
  if (!snapshot.commit?.trim()) throw new TypeError("snapshot.commit is required.");
  if (!Array.isArray(snapshot.commits)) throw new TypeError("snapshot.commits must be an array.");
  if (!Array.isArray(snapshot.files)) throw new TypeError("snapshot.files must be an array.");

  const sanitized: SafeDriverSnapshot = {
    ...snapshot,
    repository: safeText(snapshot.repository),
    ref: safeText(snapshot.ref),
    commit: safeText(snapshot.commit),
    files: snapshot.files.map(safePath).filter((file): file is string => Boolean(file)),
    commits: snapshot.commits.map((commit) => ({
      ...commit,
      sha: safeText(commit.sha),
      subject: safeText(commit.subject),
      author: normalizePerson(commit.author) ?? undefined,
      files: (commit.files ?? []).map(safePath).filter((file): file is string => Boolean(file)),
    })),
    pullRequests: (snapshot.pullRequests ?? []).map((pr) => ({
      ...pr,
      title: safeText(pr.title),
      headRef: safeText(pr.headRef),
      baseRef: safeText(pr.baseRef),
      url: safeUrl(pr.url),
      author: normalizePerson(pr.author),
    })),
  };

  const project = createNode(makeProjectMatches(sanitized), sanitized);
  const featureNodes = FEATURE_RULES
    .map((rule) => findMatches(sanitized, rule))
    .filter((matches) => matches.files.length > 0 || matches.commits.length > 0 || matches.pullRequests.length > 0)
    .map((matches) => createNode(matches, sanitized));
  const workNodes = [project, ...featureNodes];
  const warnings = [
    "Ownership is a candidate inference only: owner.confirmed is always false and must be confirmed or overridden by a human.",
    "State is a conservative latest-main presence signal, not proof of deployment, adoption, completion, or active effort.",
    "No dependency edges were synthesized because repository history does not provide an authoritative dependency mapping; parent/child edges are limited to the importer’s explicit feature hierarchy.",
    ...(snapshot.warnings ?? []).map(safeText).filter(Boolean),
  ];
  const branches = sanitized.branches ?? [];
  const unmergedBranches = branches
    .filter((branch) => branch.name !== sanitized.ref && branch.name !== "origin/main" && branch.mergedIntoMain !== true)
    .map((branch) => ({
      name: safeText(branch.name),
      sha: safeText(branch.sha),
      evidence: {
        kind: "branch" as const,
        ref: safeText(branch.name),
        label: `Unmerged branch ${safeText(branch.name)} was excluded from Work`,
        detail: "Branch evidence may inform later human review but does not establish a durable capability on latest main.",
      },
    }));
  if (unmergedBranches.length) {
    warnings.push(`${unmergedBranches.length} branch(es) were not imported as Work because they are not merged into latest main.`);
  }

  return {
    schema: "menoteam.work-map.v1",
    importer: "safedriver-plan",
    source: {
      repository: sanitized.repository,
      ref: sanitized.ref,
      commit: sanitized.commit,
      generatedAt: sanitized.generatedAt,
      remoteUrl: safeUrl(sanitized.remoteUrl),
      history: {
        commitCount: sanitized.commits.length,
        branchCount: branches.length,
        tagCount: (sanitized.tags ?? []).length,
        pullRequestCount: (sanitized.pullRequests ?? []).length,
        pullRequestsAvailable: Array.isArray(snapshot.pullRequests),
      },
    },
    workNodes,
    teammateMemories: makeTeammateMemories(workNodes),
    unmergedBranches,
    warnings: unique(warnings, (warning) => warning),
  };
}

export interface WorkMapToolClient {
  list(input: Record<string, unknown>): Promise<unknown>;
  search(input: Record<string, unknown>): Promise<unknown>;
  read(input: Record<string, unknown>): Promise<unknown>;
  create_work(input: Record<string, unknown>): Promise<unknown>;
  update_work(input: Record<string, unknown>): Promise<unknown>;
  update_teammate(input: Record<string, unknown>): Promise<unknown>;
}

export interface McpToolCaller {
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<{
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

/**
 * Adapter for an existing MCP client. This intentionally targets only the six
 * V1 tools; it does not add an HTTP/REST client or persist a bearer credential.
 */
export function createWorkMapToolClient(caller: McpToolCaller): WorkMapToolClient {
  const call = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    const result = await caller.callTool({ name, arguments: input });
    if (result.isError) throw new Error(`Work Map ${name} call failed.`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (!text) return result;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { text };
    }
  };
  return {
    list: (input) => call("list", input),
    search: (input) => call("search", input),
    read: (input) => call("read", input),
    create_work: (input) => call("create_work", input),
    update_work: (input) => call("update_work", input),
    update_teammate: (input) => call("update_teammate", input),
  };
}

export interface ConfirmedOwner {
  teammateRef: string;
  displayName: string;
}

export interface WriteImportOptions {
  /** Every selected Work must be explicitly mapped to a human teammate. */
  confirmedOwners: Record<string, ConfirmedOwner>;
  /** Every selected Work must have an explicit human-confirmed state. */
  confirmedStates: Record<string, WorkState>;
  /** Keep repository-derived ownership inferred instead of promoting it to confirmed. */
  ownerSource?: "confirmed" | "inferred";
  /** Include only these stable importer IDs; parents are included automatically. */
  nodeIds?: string[];
  dryRun?: boolean;
}

export interface ExplicitBootstrapConfirmation {
  teammateRef: string;
  displayName: string;
  state: WorkState;
  ownerSource?: "confirmed" | "inferred";
}

export interface WriteImportResult {
  teammateRefs: Record<string, string>;
  workRefs: Record<string, string>;
  createdWorkIds: string[];
  updatedWorkIds: string[];
  unchangedWorkIds: string[];
  plannedOperations: string[];
}

/**
 * Convenience for a deliberate bootstrap decision such as "map every imported
 * node to teammate_e2023 and mark it current". There is no default owner/state;
 * the caller must supply both values explicitly before invoking the writer.
 */
export function makeExplicitBootstrapOptions(
  imported: WorkMapImport,
  confirmation: ExplicitBootstrapConfirmation
): WriteImportOptions {
  if (!confirmation.teammateRef.trim() || !confirmation.displayName.trim()) {
    throw new TypeError("A teammate reference and display name are required for bootstrap confirmation.");
  }
  if (confirmation.state !== "current" && confirmation.state !== "completed") {
    throw new TypeError("A valid Work state is required for bootstrap confirmation.");
  }
  return {
    confirmedOwners: Object.fromEntries(imported.workNodes.map((node) => [node.id, {
      teammateRef: confirmation.teammateRef,
      displayName: confirmation.displayName,
    }])),
    confirmedStates: Object.fromEntries(imported.workNodes.map((node) => [node.id, confirmation.state])),
    ownerSource: confirmation.ownerSource ?? "confirmed",
  };
}

function resultObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function resultItems(value: unknown): Array<Record<string, unknown>> {
  const object = resultObject(value);
  return Array.isArray(object.items)
    ? object.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
}

function resultEntity(value: unknown): Record<string, unknown> {
  const object = resultObject(value);
  const entity = object.entity ?? object.work ?? object.teammate;
  return resultObject(entity);
}

function workSelection(imported: WorkMapImport, nodeIds: string[] | undefined): WorkNode[] {
  if (!nodeIds?.length) return imported.workNodes;
  const selected = new Set(nodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of imported.workNodes) {
      if (node.parentId && selected.has(node.id) && !selected.has(node.parentId)) {
        selected.add(node.parentId);
        changed = true;
      }
    }
  }
  const nodes = imported.workNodes.filter((node) => selected.has(node.id));
  if (nodes.length !== selected.size) {
    throw new Error("The import selection contains an unknown Work node.");
  }
  return nodes;
}

function sortParentFirst(nodes: WorkNode[]): WorkNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const output: WorkNode[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: WorkNode) => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) throw new Error("The import contains a parent cycle.");
    visiting.add(node.id);
    if (node.parentId && byId.has(node.parentId)) visit(byId.get(node.parentId)!);
    visiting.delete(node.id);
    visited.add(node.id);
    output.push(node);
  };
  for (const node of nodes) visit(node);
  return output;
}

function exactWorkMatch(items: Array<Record<string, unknown>>, title: string): Record<string, unknown> | null {
  // `list(kind: "work")` already scopes the page; unlike `search`, compact
  // list rows intentionally do not repeat a `kind` discriminator.
  const matches = items.filter((item) => item.title === title && typeof item.ref === "string");
  if (matches.length > 1) throw new Error(`More than one existing Work matches ${title}.`);
  return matches[0] ?? null;
}

async function listAll(
  tools: WorkMapToolClient,
  kind: "work" | "teammate"
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = resultObject(await tools.list({
      kind,
      filters: kind === "work" ? {} : {},
      limit: 100,
      ...(cursor ? { cursor } : {}),
    }));
    items.push(...resultItems(page));
    const next = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : null;
    if (!next || seenCursors.has(next)) return items;
    seenCursors.add(next);
    cursor = next;
  }
}

/**
 * Applies an import through the shared six-tool MCP seam. The owner field still
 * requires explicit human mapping; the optional inferred mode preserves the
 * repository candidate as unconfirmed supporting evidence.
 */
export async function writeSafeDriverImport(
  imported: WorkMapImport,
  tools: WorkMapToolClient,
  options: WriteImportOptions
): Promise<WriteImportResult> {
  const nodes = sortParentFirst(workSelection(imported, options.nodeIds));
  const ownerSource = options.ownerSource ?? "confirmed";
  if (ownerSource !== "confirmed" && ownerSource !== "inferred") {
    throw new Error("ownerSource must be confirmed or inferred.");
  }
  if (ownerSource === "inferred") {
    const missingCandidates = nodes
      .filter((node) => node.owner.provenance !== "inferred" || !node.owner.person)
      .map((node) => node.id);
    if (missingCandidates.length) {
      throw new Error(`Inferred owner preservation requires repository candidates for: ${missingCandidates.join(", ")}`);
    }
  }
  const missingOwners = nodes
    .filter((node) => !options.confirmedOwners[node.id]?.teammateRef)
    .map((node) => node.id);
  if (missingOwners.length) {
    throw new Error(`Explicit human confirmation is required for: ${missingOwners.join(", ")}`);
  }
  const missingStates = nodes
    .filter((node) => !["current", "completed"].includes(options.confirmedStates[node.id] ?? ""))
    .map((node) => node.id);
  if (missingStates.length) {
    throw new Error(`Explicit state confirmation is required for: ${missingStates.join(", ")}`);
  }

  const plannedOperations: string[] = [];
  const teammateRefs: Record<string, string> = {};
  const workRefs: Record<string, string> = {};
  const createdWorkIds: string[] = [];
  const updatedWorkIds: string[] = [];
  const unchangedWorkIds: string[] = [];
  const ownerDetails = new Map<string, ConfirmedOwner>();
  for (const node of nodes) {
    const owner = options.confirmedOwners[node.id]!;
    ownerDetails.set(owner.teammateRef, owner);
  }

  const existingTeammates = new Map(
    (await listAll(tools, "teammate"))
      .filter((item) => typeof item.ref === "string")
      .map((item) => [String(item.ref), item])
  );
  for (const [ref, owner] of ownerDetails) {
    const existing = existingTeammates.get(ref);
    if (!existing) {
      plannedOperations.push(`update_teammate ${ref} expected_revision=0`);
      if (!options.dryRun) {
        await tools.update_teammate({
          ref,
          expected_revision: 0,
          changes: { display_name: owner.displayName, default_agent_addresses: {}, memory: memoryForOwner(imported, ref, owner, options.confirmedOwners, ownerSource) },
        });
      }
      teammateRefs[ref] = ref;
      continue;
    }
    const complete = await tools.read({ ref });
    const entity = resultEntity(complete);
    const revision = Number(entity.revision ?? existing.revision);
    const currentName = String(entity.display_name ?? existing.display_name ?? "");
    const currentMemory = String(entity.memory ?? "");
    const desiredMemory = memoryForOwner(imported, ref, owner, options.confirmedOwners, ownerSource);
    if (currentName !== owner.displayName || currentMemory !== desiredMemory) {
      plannedOperations.push(`update_teammate ${ref} expected_revision=${revision}`);
      if (!options.dryRun) {
        await tools.update_teammate({
          ref,
          expected_revision: revision,
          changes: { display_name: owner.displayName, memory: desiredMemory },
        });
      }
    }
    teammateRefs[ref] = ref;
  }

  const allWorkItems = await listAll(tools, "work");
  for (const node of nodes) {
    const owner = options.confirmedOwners[node.id]!;
    const existing = exactWorkMatch(allWorkItems, node.title);
    const parentRef = node.parentId ? workRefs[node.parentId] ?? null : null;
    if (existing) {
      const ref = String(existing.ref);
      const complete = await tools.read({ ref });
      const entity = resultEntity(complete);
      const revision = Number(entity.revision);
      const changes: Record<string, unknown> = {};
      if (entity.owner !== owner.teammateRef) changes.owner = owner.teammateRef;
      if (entity.owner_source !== ownerSource) changes.owner_source = ownerSource;
      if (!isDeepStrictEqual(entity.owner_evidence ?? [], node.owner.evidence)) changes.owner_evidence = node.owner.evidence;
      if (entity.state !== options.confirmedStates[node.id]) changes.state = options.confirmedStates[node.id];
      if ((entity.parent ?? null) !== parentRef) changes.parent = parentRef;
      if (JSON.stringify(entity.dependencies ?? []) !== JSON.stringify(node.dependencyIds)) changes.dependencies = [];
      if (entity.current_summary !== node.currentSummary) changes.current_summary = node.currentSummary;
      if (entity.living_doc_markdown !== node.livingDoc.content) changes.living_doc_markdown = node.livingDoc.content;
      workRefs[node.id] = ref;
      if (!Object.keys(changes).length) {
        unchangedWorkIds.push(node.id);
        continue;
      }
      plannedOperations.push(`update_work ${ref} expected_revision=${revision}`);
      updatedWorkIds.push(node.id);
      if (!options.dryRun) {
        await tools.update_work({ ref, expected_revision: revision, changes });
      }
      continue;
    }
    const input = {
      title: node.title,
      owner: owner.teammateRef,
      owner_source: ownerSource,
      owner_evidence: node.owner.evidence,
      state: options.confirmedStates[node.id],
      parent: parentRef,
      dependencies: [],
      current_summary: node.currentSummary,
      living_doc_markdown: node.livingDoc.content,
    };
    plannedOperations.push(`create_work ${node.id}`);
    if (!options.dryRun) {
      const created = resultEntity(await tools.create_work(input));
      if (typeof created.ref !== "string") throw new Error(`create_work returned no ref for ${node.id}.`);
      workRefs[node.id] = created.ref;
      allWorkItems.push({ ref: created.ref, kind: "work", title: node.title });
    } else {
      workRefs[node.id] = `planned:${node.id}`;
    }
    createdWorkIds.push(node.id);
  }
  return { teammateRefs, workRefs, createdWorkIds, updatedWorkIds, unchangedWorkIds, plannedOperations };
}

function memoryForOwner(
  imported: WorkMapImport,
  teammateRef: string,
  owner: ConfirmedOwner,
  confirmedOwners: Record<string, ConfirmedOwner>,
  ownerSource: "confirmed" | "inferred",
): string {
  const nodes = imported.workNodes.filter((node) => confirmedOwners[node.id]?.teammateRef === teammateRef);
  const labels = nodes.slice(0, 5).map((node) => node.title).join(", ") || "the imported project";
  const ownership = ownerSource === "inferred"
    ? "The current Work owner remains inferred from repository evidence and is not confirmed by a human"
    : "The current Work owner was explicitly confirmed by the operator";
  const memory = `Repository history links ${owner.displayName} to ${labels} as supporting evidence. ${ownership}; repository activity alone is not proof of accountability. This is team-visible routing context; correct it when better team context becomes available.`;
  return memory;
}

function runGit(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Unable to read the Safe Driver Plan Git repository.");
  }
}

function optionalCommand(command: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function parseCommits(raw: string): CommitRecord[] {
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const lines = record.split("\n");
      const [sha, date, authorName, subject] = (lines.shift() ?? "").split("\x1f");
      return {
        sha: safeText(sha),
        date: safeText(date),
        subject: safeText(subject),
        author: authorName
          ? { id: `git:${safeText(authorName)}`, displayName: safeText(authorName) }
          : undefined,
        files: lines.map(safePath).filter((file): file is string => Boolean(file)),
      };
    })
    .filter((commit) => Boolean(commit.sha));
}

function parseRefs(raw: string): Array<{ name: string; sha: string }> {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, sha] = line.split("\t");
      return { name: safeText(name), sha: safeText(sha) };
    })
    .filter((item) => item.name && item.sha);
}

function remoteInfo(remote: string): { repository: string; remoteUrl: string } {
  const value = remote.trim().replace(/\.git$/i, "");
  const githubPath = value.match(/github\.com[:/]([^/]+\/[^/]+)$/i)?.[1];
  if (githubPath) {
    return { repository: githubPath, remoteUrl: `https://github.com/${githubPath}` };
  }
  try {
    const url = new URL(value);
    return {
      repository: url.pathname.replace(/^\//, "") || "safe-driver-plan",
      remoteUrl: `${url.protocol}//${url.host}${url.pathname}`,
    };
  } catch {
    return { repository: "safe-driver-plan", remoteUrl: "" };
  }
}

function parsePullRequests(raw: string): PullRequestRecord[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed.map((pr) => {
      const author = pr.author && typeof pr.author === "object"
        ? pr.author as Record<string, unknown>
        : null;
      return {
        number: Number(pr.number),
        title: safeText(String(pr.title ?? "")),
        state: safeText(String(pr.state ?? "")),
        author: author?.login
          ? { id: `github:${safeText(String(author.login))}`, displayName: safeText(String(author.name || author.login)) }
          : null,
        headRef: safeText(String(pr.headRefName ?? "")),
        baseRef: safeText(String(pr.baseRefName ?? "")),
        url: typeof pr.url === "string" ? safeUrl(pr.url) : undefined,
        mergedAt: typeof pr.mergedAt === "string" ? pr.mergedAt : null,
        mergeCommit: pr.mergeCommit && typeof pr.mergeCommit === "object"
          ? safeText(String((pr.mergeCommit as Record<string, unknown>).oid ?? "")) || null
          : null,
      };
    }).filter((pr) => Number.isFinite(pr.number) && pr.number > 0);
  } catch {
    return undefined;
  }
}

export interface CollectOptions {
  ref?: string;
  repository?: string;
  includePullRequests?: boolean;
}

export function collectSafeDriverSnapshot(repoPath: string, options: CollectOptions = {}): SafeDriverSnapshot {
  const ref = options.ref ?? "origin/main";
  runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  const commit = runGit(repoPath, ["rev-parse", ref]).trim();
  const remote = optionalCommand("git", ["remote", "get-url", "origin"], repoPath) ?? "";
  const remoteData = remoteInfo(remote);
  const repository = options.repository ?? remoteData.repository;
  const commitRaw = runGit(repoPath, [
    "log",
    ref,
    "--format=%x1e%H%x1f%aI%x1f%an%x1f%s",
    "--name-only",
  ]);
  const commits = parseCommits(commitRaw);
  const authorCounts = new Map<string, { person: PersonRef; commits: number }>();
  for (const item of commits) {
    if (!item.author) continue;
    const current = authorCounts.get(item.author.id) ?? { person: item.author, commits: 0 };
    current.commits += 1;
    authorCounts.set(item.author.id, current);
  }
  const branchRefs = parseRefs(runGit(repoPath, [
    "for-each-ref",
    "refs/heads",
    "refs/remotes/origin",
    "--format=%(refname:short)\t%(objectname)",
  ]));
  const branches = branchRefs
    .filter((item) => item.name !== "origin" && item.name !== "origin/HEAD")
    .map((item) => ({
      name: item.name,
      sha: item.sha,
      mergedIntoMain: item.name === ref || (() => {
        try {
          runGit(repoPath, ["merge-base", "--is-ancestor", item.sha, commit]);
          return true;
        } catch {
          return false;
        }
      })(),
      commits: optionalCommand("git", ["log", item.name, "--format=%H"], repoPath)
        ?.split("\n")
        .map((sha) => sha.trim())
        .filter(Boolean),
    }));
  const tagRefs = parseRefs(runGit(repoPath, [
    "for-each-ref",
    "refs/tags",
    "--format=%(refname:short)\t%(objectname)",
  ]));
  const files = runGit(repoPath, ["ls-tree", "-r", "--name-only", ref])
    .split("\n")
    .map(safePath)
    .filter((file): file is string => Boolean(file));
  const pullRequests = options.includePullRequests === false
    ? undefined
    : parsePullRequests(optionalCommand("gh", [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,state,author,headRefName,baseRefName,mergedAt,url,mergeCommit",
    ], repoPath) ?? "");
  const warnings = [] as string[];
  if (options.includePullRequests !== false && !pullRequests) {
    warnings.push("GitHub PR metadata was unavailable; owner inference uses commit and branch evidence only.");
  }
  return {
    repository,
    ref,
    commit,
    generatedAt: new Date().toISOString(),
    remoteUrl: remoteData.remoteUrl || undefined,
    authors: [...authorCounts.values()].map(({ person, commits: count }) => ({ ...person, commits: count })),
    pullRequests,
    commits,
    branches,
    tags: tagRefs,
    files,
    warnings,
  };
}

export function collectAndImportSafeDriverPlan(
  repoPath: string,
  options: CollectOptions = {}
): WorkMapImport {
  return importSafeDriverPlan(collectSafeDriverSnapshot(repoPath, options));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const repoPath = process.argv[2] ?? process.cwd();
  const includePullRequests = !process.argv.includes("--no-pr");
  try {
    const result = collectAndImportSafeDriverPlan(repoPath, { includePullRequests });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    process.stderr.write("Safe Driver Plan import failed: repository evidence could not be read.\n");
    process.exitCode = 1;
  }
}
