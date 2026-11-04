// Fixed fields only: never include inputs, credentials, IDs or provider errors.
export async function observeInsights(
    operation: () => Promise<Response>,
    emit: (line: string) => void = line => console.info(line),
    clock: () => number = Date.now,
): Promise<Response> {
    const started = clock();
    let response: Response | undefined;
    try {
        response = await operation();
        return response;
    } finally {
        // Observability must not change request success or mask its original error.
        try {
            const cache = response?.headers.get('X-Insights-Cache');
            const rawAge = response?.headers.get('X-Insights-Age-Seconds');
            const age = rawAge == null ? NaN : Number(rawAge);
            const duration = clock() - started;
            emit(JSON.stringify({
                event: 'insight_request_v1',
                outcome: response?.ok ? 'success' : 'failure',
                cache: cache && ['hit', 'miss', 'unavailable'].includes(cache) ? cache : 'unknown',
                duration_ms: Number.isSafeInteger(Math.round(duration)) && duration >= 0 ? Math.round(duration) : null,
                cache_age_seconds: response?.ok && cache === 'hit' && Number.isInteger(age) && age >= 0 && age < 600 ? age : null,
            }));
        } catch { /* Logging is best effort. */ }
    }
}
