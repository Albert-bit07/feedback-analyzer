# Engineering decisions

## Submission atomicity

`src/workflow.ts` writes feedback and its processing job in a single D1 batch transaction. A unique idempotency key prevents duplicate rows; a SHA-256 hash of the normalized accepted fields distinguishes a replay from conflicting reuse. The job insert selects only the row matching both key and hash. Concurrent retries produce one feedback/job pair.

The request reader enforces a byte limit while streaming, independently of Content-Length. Field limits and prepared statements constrain storage input. Feedback content remains separate from processing state and append-only resolution history.

## Access and freshness

`src/access.ts` fails closed without a configured secret and protects HTML and API routes with HTTP Basic authentication. Password comparisons hash both values and compare fixed-length bytes. Cross-site browser requests are rejected, and responses prohibit HTTP caching. Use HTTPS outside local development. Shared credentials are intentionally a single-team milestone, not identity management.

SQL summaries no longer use cache-aside KV entries: after ingestion and resolution, stale counts would misrepresent triage state. The optional legacy AI-summary cache remains bounded by a ten-minute TTL and must not be treated as current processing output. A future cache should introduce version-aware freshness only after measurements justify it.

## State and limits

`migrations/0001_ingestion.sql` upgrades the original schema and adds durable jobs and resolution history. D1 migrations record application; direct reruns of its ALTER statements are unsupported. Legacy fixtures have no processing job and are explicitly labeled in the triage page.

Jobs remain pending until a subsequent dispatcher/consumer milestone. There is no claim of queue recovery, classification quality, semantic grouping, tenant isolation or throughput measurement. The current workflow supports submission and human triage without model availability.

## Evidence

CI type-checks application and test files and runs Node security tests plus Workers/D1 integration tests. The latter exercise duplicate submissions, atomic rollback, authentication, input bounds, and resolution freshness with real local D1 bindings. These are automated integration checks, not formal verification or production deployment evidence.
