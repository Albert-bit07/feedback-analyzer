import { pathToFileURL } from 'node:url';

export const MAX_BYTES = 10 * 1024 * 1024;
const fields = ['event', 'outcome', 'cache', 'duration_ms', 'cache_age_seconds'].sort();

export function summarize(text) {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Input exceeds 10 MiB');
    const report = {requests: 0, successes: 0, failures: 0,
        cache: {hit: 0, miss: 0, unavailable: 0, unknown: 0},
        hit_fraction: null, duration_samples: 0, average_duration_ms: null, max_duration_ms: null,
        hit_age_samples: 0, average_hit_age_seconds: null, max_hit_age_seconds: null};
    let durationSum = 0, ageSum = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (line.length > 4096 || report.requests >= 50000) throw new Error('Record limit exceeded');
        let row;
        try { row = JSON.parse(line); } catch { throw new Error('Invalid metric record'); }
        if (!row || Array.isArray(row) || typeof row !== 'object' ||
            Object.keys(row).sort().join(',') !== fields.join(',') || row.event !== 'insight_request_v1' ||
            !['success', 'failure'].includes(row.outcome) || typeof row.cache !== 'string' || !Object.hasOwn(report.cache, row.cache) ||
            !(row.duration_ms === null || (Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0)) ||
            !(row.cache_age_seconds === null || (row.outcome === 'success' && row.cache === 'hit' &&
                Number.isInteger(row.cache_age_seconds) && row.cache_age_seconds >= 0 && row.cache_age_seconds < 600))) {
            throw new Error('Invalid metric record');
        }
        report.requests++;
        if (row.outcome === 'success') report.successes++; else report.failures++;
        report.cache[row.cache]++;
        if (row.duration_ms !== null) {
            durationSum += row.duration_ms;
            if (!Number.isSafeInteger(durationSum)) throw new Error('Duration total exceeds safe range');
            report.duration_samples++;
            report.max_duration_ms = Math.max(report.max_duration_ms ?? 0, row.duration_ms);
        }
        if (row.cache_age_seconds !== null) {
            ageSum += row.cache_age_seconds;
            report.hit_age_samples++;
            report.max_hit_age_seconds = Math.max(report.max_hit_age_seconds ?? 0, row.cache_age_seconds);
        }
    }
    report.hit_fraction = report.requests ? report.cache.hit / report.requests : null;
    report.average_duration_ms = report.duration_samples ? durationSum / report.duration_samples : null;
    report.average_hit_age_seconds = report.hit_age_samples ? ageSum / report.hit_age_samples : null;
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) throw new Error('Input exceeds 10 MiB');
            chunks.push(chunk);
        }
        console.log(JSON.stringify(summarize(Buffer.concat(chunks).toString('utf8')), null, 2));
    } catch {
        console.error('Cannot summarize metrics: invalid records or input limits exceeded.');
        process.exitCode = 1;
    }
}
