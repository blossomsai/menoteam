export interface InstructionsDraft {
  draft: string;
  base: string;
}

export const startInstructionsDraft = (latest: string): InstructionsDraft => ({ draft: latest, base: latest });
export const editInstructionsDraft = (state: InstructionsDraft, draft: string): InstructionsDraft => ({ ...state, draft });
export const hasRemoteInstructionsUpdate = (state: InstructionsDraft, latest: string): boolean => latest !== state.base;
export const keepInstructionsDraft = (state: InstructionsDraft, latest: string): InstructionsDraft => ({ draft: state.draft, base: latest });
export const useLatestInstructions = (latest: string): InstructionsDraft => startInstructionsDraft(latest);
export const cancelInstructionsDraft = (latest: string): InstructionsDraft => startInstructionsDraft(latest);
export const completeInstructionsSave = (state: InstructionsDraft, submitted: string): { state: InstructionsDraft; closeEditor: boolean } => ({
  state: { draft: state.draft, base: submitted },
  closeEditor: state.draft === submitted,
});
