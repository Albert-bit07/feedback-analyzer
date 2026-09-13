# Feedback Analyzer

A feedback analytics dashboard built on Cloudflare Workers, D1, KV, and Workers AI. It stores incoming feedback, classifies sentiment automatically, and surfaces patterns across entries without anyone manually reading through them one by one.

## Stack and why

**D1** holds the feedback table. The queries this needs (who has complained more than once, what's been open longest, which issues repeat most) are relational: group by, having, order by. A key value store can't answer those without pulling everything into application code first, so a real SQL database was the right call even at a small scale.

```sql
-- Repeat complainers, useful for spotting at risk users
SELECT user_email, COUNT(*) AS complaint_count,
       GROUP_CONCAT(title, ' | ') AS issues
FROM feedback
WHERE resolved_at IS NULL
GROUP BY user_email
HAVING COUNT(*) > 1
ORDER BY complaint_count DESC;
```

**KV** sits in front of D1 as a cache. Dashboard reads don't need to hit D1 on every request since feedback doesn't change second to second. A 5 minute TTL keeps dashboard loads fast (roughly 400ms on a cache miss, 75ms on a hit) while still refreshing often enough to feel current. Cache entries are invalidated explicitly whenever new data is seeded or written.

**Workers AI** handles sentiment classification and higher level insight generation. Per entry sentiment uses `@cf/huggingface/distilbert-sst-2-int8`; a second pass with `@cf/meta/llama-3-8b-instruct` summarizes patterns across a batch of feedback ("three entries mention slow dashboard loads" type signal). Keyword matching breaks on things like "amazingly slow," so a model that reads context does meaningfully better here.

**Workers** hosts the whole thing. No servers to patch or scale, deploys are near instant, and D1/KV/AI all run in the same runtime without extra plumbing.

## Running locally

```bash
pip install -r requirements.txt   # if applicable, otherwise remove
npm install
wrangler d1 execute <DB_NAME> --local --file=./schema.sql
npm run dev
```

## Testing

Tests run with Vitest:

```bash
npm test
```

## Notes

Cache invalidation currently happens on write; a background refresh job would be a reasonable next step if traffic grew.
