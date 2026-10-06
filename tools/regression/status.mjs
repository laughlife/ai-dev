export function summarizeRegressionStatus({ failure, releaseBlocked }) {
  const status = failure ? "FAIL" : releaseBlocked ? "BLOCKED" : "PASS"
  const release_gate = failure || releaseBlocked ? "NOT_READY" : "RELEASE_READY"
  return { status, release_gate }
}
