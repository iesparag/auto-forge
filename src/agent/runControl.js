// In-memory stop signals for active runs. The orchestrator/codeGenerator check
// these at safe checkpoints and abort gracefully when a stop is requested.
const stopSet = new Set();

export function requestStop(runId) {
  stopSet.add(String(runId));
}

export function isStopRequested(runId) {
  return stopSet.has(String(runId));
}

export function clearStop(runId) {
  stopSet.delete(String(runId));
}

// Throw a tagged error if a stop was requested for this run.
export function throwIfStopped(runId) {
  if (isStopRequested(runId)) {
    throw Object.assign(new Error('Run stopped by user.'), { stopped: true });
  }
}
