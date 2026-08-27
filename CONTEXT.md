# Menoteam Work Map

Menoteam Work Map is a shared team context that lets humans and their existing agents understand, route, and maintain durable work without replacing their communication channels or agent harnesses.

## Language

**Work Map**:
The team's single shared graph of durable Work, ownership, hierarchy, and dependencies.
_Avoid_: Feature Map, task board, project database, contract

**Work Node**:
The graph representation of a durable outcome or capability that deserves independent long-term context and exactly one Living Doc.
_Avoid_: Ticket, task, issue, activity

**Living Doc**:
The canonical, continuously maintained, human-readable explanation attached to one Work Node.
_Avoid_: Working notes, supporting document, status log, legacy spec

**Teammate Memory**:
A concise team-readable summary of durable work-related context about one human, used to improve routing and collaboration.
_Avoid_: Personal memory, user model, activity history, workload record

**Owner**:
The one human accountable for a Work Node; ownership never belongs to a model, harness, or agent address.
_Avoid_: Assigned agent, responsible model

**Owner Source**:
The Work field that says whether its human owner was confirmed, inferred from evidence, or remains unresolved. It is provenance, not a separate domain entity.
_Avoid_: Candidate record, automatic truth, expertise score

**Default Team Agent**:
The one logical channel-native agent normally contacted for a human's Work, reachable through platform-specific addresses.
_Avoid_: Delegate agent, spawned agent, worker

**Master**:
The explicit team point of contact that answers from Team Ground Truth or routes a request to relevant teammate agents.
_Avoid_: Manager, orchestrator, supervisor, dispatcher

**Team Ground Truth**:
The team's maintained current understanding in the Work Map, subject to correction when external evidence reveals a conflict.
_Avoid_: Oracle, automatic truth, repository mirror

**Current**:
A Work state meaning active effort or committed remaining scope exists.
_Avoid_: In progress, open

**Completed**:
A Work state meaning the currently committed scope is complete and no active effort remains; the Work may later be reopened.
_Avoid_: Archived, deleted, permanently closed

**Meaningful Progress**:
Effort that changes the current situation or the durable shared understanding of a Work.
_Avoid_: Activity event, time entry, working-note update
