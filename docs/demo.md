# Local workflow demonstration

1. Follow the README setup, apply the local migration and configure a unique password.
2. Open `/triage`, authenticate as `analyst`, submit a synthetic report, and observe its pending processing state.
3. Use the README curl request twice with the same key. Both responses identify the same feedback; changing content with that key returns 409.
4. Resolve the report, verify the unresolved count at `/api/stats`, then reopen it. The count changes without waiting for cache expiration.
5. Explain the transaction boundary: both the feedback row and pending processing job must commit. The integration test deliberately removes the job table and verifies that failed job insertion rolls back feedback.

This is a demo procedure, not a recording. No remote inference, deployment, browser screenshot or performance claim is implied. The processor is covered by injected-response integration tests. Show retry/replay and lease-recovery tests separately from real model behavior; do not present synthetic test output as a live inference result.
