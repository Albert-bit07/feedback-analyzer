# Engineering overview

## Decisions worth discussing

- **SQL for relational questions:** `getTopIssues`, `getRepeatUsers` and `getLongestUnresolved` in [the Worker](../src/index.ts) express aggregation at the storage boundary. Exact title grouping is simple but does not cluster semantically similar reports. Selecting sentiment beside a grouped title also leaves mixed-group sentiment ambiguous.
- **Cache-aside summaries:** four keys expire after 300 seconds, insights after 600. Seeding deletes keys before inserting rows, not as an atomic write-and-invalidation operation. A concurrent reader can repopulate intermediate summaries. KV propagation and TTL mean a refreshing browser can still display stale data.
- **Small unified deployment:** one Worker hosts HTML and API with D1/KV/AI bindings. This reduces service setup but couples UI, routing and queries in one large source file.
- **AI as an optional dependency:** sentiment catches exceptions and uses keywords; insight failures return a message. There is no evaluation set, accuracy evidence, prompt-injection defense or trained model in this repository. Model availability and output schemas are external assumptions.

## Validation ledger — 2026-10-20

Inspected application source, SQL variants, package lock, Wrangler configuration, Vitest configuration and git history. No AGENTS.md or CI workflow was present in the checked tree.

| Check | Result and boundary |
|---|---|
| Dependency install | `npm ci --ignore-scripts` completed; does not certify install scripts or dependency security |
| TypeScript | `npx tsc --noEmit` exited 0 for the root configuration |
| Bundle | `npx wrangler deploy --dry-run --outdir /tmp/feedback-analyzer-dryrun` produced bundle; no publication |
| Existing tests | Runtime setup failed with `uv_interface_addresses`; zero tests executed |
| Test relevance | Static inspection found starter Hello World assertions inconsistent with dashboard output |
| D1/AI/browser workflow | Not end-to-end verified; no cloud calls or deployed site inspection |
| Performance | No raw timings, load experiment or cache A/B evidence found |

[create-table.sql](../create-table.sql) creates only structure, while [schema.sql](../schema.sql) also inserts examples. [seed-data.sql](../seed-data.sql) is another fixture; avoid layering all seed mechanisms on the same database during a demonstration.

## Failure and security boundaries

The outer router turns thrown errors into 500 JSON responses with exception messages. D1/KV errors can therefore fail a panel rather than use a resilient stale value. The browser's parallel loaders catch failures independently. There is no retry queue, durable ingestion workflow, authorization boundary or observability evidence beyond configured Workers logging.

Email/history disclosure, unescaped HTML contexts, unrestricted CORS, prompt injection and the unauthenticated mutating seed path must be addressed before handling real feedback. Seeding can partially succeed because each insert has its own catch block. A successful HTTP response does not mean every fixture was inserted.

## Next engineering work

Replace starter tests with isolated route tests using known D1 rows and controlled KV/AI bindings. Check cache-hit/miss equivalence, expiration/invalidation, missing IDs, partial seed failure and model response parsing. Add authentication and method restrictions before exposing data; remove public seeding; use safe DOM construction. Measure cache effects with fixed fixtures and archived raw timings before adding performance claims. These are recommendations, not implemented features of this documentation PR.
