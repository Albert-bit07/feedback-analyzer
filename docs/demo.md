# 90-second local demonstration

**Status:** recording script, not a verified recording. No screenshot or output is fabricated. Use only seeded examples in a fresh disposable checkout; do not seed a shared service.

1. Prepare using the [README commands](../README.md#run-locally), with dependencies installed before recording. Confirm Wrangler starts and D1 is local. If it requests cloud authentication for AI, omit the AI panel from the demonstrated success claims until you deliberately enable and verify that binding.
2. **0–15 s:** show the diagram: browser, Worker, SQL storage, summary cache and model inference.
3. **15–40 s:** open the local dashboard. Show top issues, oldest issues and repeat reporters. Explain that source labels are fixture fields, not live integrations.
4. **40–60 s:** select a recent record and inspect its reporter history. Use synthetic email addresses only.
5. **60–80 s:** inspect `/api/stats` twice in a terminal or browser; explain the 300-second cache policy from code. Do not describe timing differences as a measured speedup.
6. **80–95 s:** show `getAIInsights` in source. If a real AI response was observed, label it as generated; otherwise explain the integration and visible unavailable state without claiming inference succeeded.

Stop the dev process with Ctrl-C. Retain logs for any failed panel and report that failure in the recording. Remove only the disposable checkout you created after inspecting its path; no broad cleanup command is required. The prototype has no recorded evaluation or full application test suite.
