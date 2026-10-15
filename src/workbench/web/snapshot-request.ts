export function createSnapshotRequestHandler<T>(
  fetchSnapshot: () => Promise<T>,
  getSessionGeneration: () => number,
  applySnapshot: (snapshot: T) => void,
  handleError: (cause: unknown) => void,
  canRequest: () => boolean = () => true,
) {
  let nextRequestId = 0;
  let newestSuccessId = 0;
  return async () => {
    if (!canRequest()) return;
    const requestId = ++nextRequestId;
    const sessionGeneration = getSessionGeneration();
    try {
      const snapshot = await fetchSnapshot();
      if (canRequest() && sessionGeneration === getSessionGeneration() && requestId >= newestSuccessId) {
        newestSuccessId = requestId;
        applySnapshot(snapshot);
      }
      return snapshot;
    } catch (cause) {
      if (canRequest() && sessionGeneration === getSessionGeneration() && requestId >= newestSuccessId) {
        handleError(cause);
        throw cause;
      }
    }
  };
}
