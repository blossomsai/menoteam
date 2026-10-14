import { z } from 'zod';

/** Shared with the actual MCP registration, so explicit choices survive strict parsing. */
export const createWorkSchema = z.object({
  title: z.string().min(1).max(32_000),
  overview: z.string().max(32_000).optional(),
  profileId: z.string().max(200).optional(),
  connectionId: z.string().min(1).max(200).optional(),
  sources: z.array(z.string().max(2000)).max(100).optional(),
}).strict();

const workId = z.string().min(1).max(200);
const text = z.string().min(1).max(32_000);
const reasoning = z.enum(['low', 'medium', 'high', 'xhigh']);
const normalDispatch = z.object({workId, prompt:z.string().min(1).max(12_000), kind:z.enum(['implementation','review']), model:z.enum(['gpt-6-luna','gpt-6.1-sol']), reasoning:reasoning.default('medium')}).strict();
const handoffDispatch = z.object({workId, prompt:normalDispatch.shape.prompt, kind:z.literal('implementation'), handoff:z.object({fromRunId:workId, model:z.string().min(1).max(200), reasoning:z.string().min(1).max(100)}).strict()}).strict();
export const dispatchInputSchema = z.union([normalDispatch, handoffDispatch]);
// The SDK advertises only object schemas. Validate each exclusive branch before any API call.
export const dispatchPublicSchema = normalDispatch.extend({
  model:normalDispatch.shape.model.optional().describe('Required for normal dispatch; omit when handoff is provided.'),
  reasoning:reasoning.optional().describe('Normal dispatch reasoning; defaults to medium. Omit when handoff is provided.'),
  handoff:handoffDispatch.shape.handoff.optional().describe('Explicit implementation handoff; mutually exclusive with top-level model and reasoning.'),
}).strict();
const settingChange = z.object({settingId:workId, expectedUpdatedAt:z.string().min(1), name:text.optional(), data:z.record(z.string(),z.unknown()).optional()}).strict().refine(input=>input.name!==undefined||input.data!==undefined,'Provide a setting name or data change.');
const instructionsChange = z.object({instructions:z.string().max(16_000), expectedInstructions:z.string().max(16_000)}).strict();
export const updateSettingsInputSchema = z.union([settingChange,instructionsChange]);
export const updateSettingsPublicSchema = z.object({
  settingId:settingChange.shape.settingId.optional().describe('Required with expectedUpdatedAt for a setting change; omit for project instructions.'),
  expectedUpdatedAt:settingChange.shape.expectedUpdatedAt.optional(), name:settingChange.shape.name, data:settingChange.shape.data,
  instructions:instructionsChange.shape.instructions.optional().describe('Project instructions change; requires expectedInstructions and excludes setting fields.'),
  expectedInstructions:instructionsChange.shape.expectedInstructions.optional(),
}).strict();
