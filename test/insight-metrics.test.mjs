import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { observeInsights } from '../src/insight_metrics.ts';
import { summarize, MAX_BYTES } from '../scripts/insight-report.mjs';

test('events aggregate cache age alongside failures and duration without private fields', async () => {
    const lines = [];
    let time = 0;
    const observe = operation => observeInsights(operation, line => lines.push(line), () => {time += 10; return time;});
    const hit = new Response('private feedback', {headers: {'X-Insights-Cache':'hit', 'X-Insights-Age-Seconds':'59'}});
    assert.equal(await observe(async () => hit), hit);
    await observe(async () => new Response('', {headers:{'X-Insights-Cache':'miss'}}));
    await observe(async () => new Response('', {status:503, headers:{'X-Insights-Cache':'unavailable'}}));
    const original = new Error('private credential');
    await assert.rejects(observe(async () => {throw original;}), error => error === original);
    assert.ok(!lines.join('').includes('private'));
    assert.deepEqual(summarize(lines.join('\n')), {
        requests:4,successes:2,failures:2,cache:{hit:1,miss:1,unavailable:1,unknown:1},
        hit_fraction:0.25,duration_samples:4,average_duration_ms:10,max_duration_ms:10,
        hit_age_samples:1,average_hit_age_seconds:59,max_hit_age_seconds:59,
    });
});

test('logging failure preserves response and original error; missing data stays unknown', async () => {
    const emit = () => {throw Error('logger unavailable');};
    const response = new Response('ok');
    assert.equal(await observeInsights(async () => response, emit), response);
    const original = new Error('original');
    await assert.rejects(observeInsights(async () => {throw original;},emit), error => error === original);
    let line;
    let time = 20;
    await observeInsights(async () => new Response('',{headers:{'X-Insights-Cache':'untrusted', 'X-Insights-Age-Seconds':'-1'}}),
        value => {line=value;}, () => time--);
    const report = summarize(line);
    assert.equal(report.cache.unknown,1);
    assert.equal(report.duration_samples,0);
    assert.equal(report.average_duration_ms,null);
    assert.equal(report.hit_age_samples,0);
    assert.equal(summarize('').hit_fraction,null);
});

test('report rejects malformed data, unsupported fields and oversized inputs without partial output', () => {
    const row = {event:'insight_request_v1',outcome:'success',cache:'hit',duration_ms:1,cache_age_seconds:0};
    for (const value of [null,[],{...row,private:'secret'}, {...row,cache:'other'}, {...row,cache:['hit']}, {...row,duration_ms:-1},
        {...row,cache_age_seconds:600}, {...row,outcome:'failure',cache_age_seconds:1}]) {
        assert.throws(() => summarize(JSON.stringify(value)), /Invalid metric/);
    }
    assert.throws(() => summarize('x'.repeat(MAX_BYTES+1)), /10 MiB/);
    const cli = spawnSync(process.execPath,['scripts/insight-report.mjs'], {input:JSON.stringify(row)+'\nprivate secret',encoding:'utf8'});
    assert.equal(cli.status,1);
    assert.equal(cli.stdout,'');
    assert.ok(!cli.stderr.includes('private secret'));
    const good = spawnSync(process.execPath,['scripts/insight-report.mjs'],{input:JSON.stringify(row),encoding:'utf8'});
    assert.equal(good.status,0);
    assert.equal(JSON.parse(good.stdout).requests,1);
});


test('authenticated insight route emits once and rejected access emits nothing', async () => {
    const {default: worker} = await import('../src/index.ts');
    const lines = [];
    const original = console.info;
    console.info = line => lines.push(line);
    try {
        const env = {
            DASHBOARD_PASSWORD:'test-only-password',
            DB:{prepare: () => ({bind() {return this;},all:async () => ({results:[]})})},
            CACHE:{get:async () => JSON.stringify({insights:'private feedback',generated_at:new Date().toISOString()})},
        };
        const url = 'https://example.test/api/ai-insights';
        assert.equal((await worker.fetch(new Request(url),env)).status,401);
        assert.equal(lines.length,0);
        const response = await worker.fetch(new Request(url,{headers:{Authorization:'Basic '+btoa('analyst:test-only-password')}}),env);
        assert.equal(response.status,200);
        assert.equal(lines.length,1);
        assert.equal(summarize(lines.join('\n')).cache.hit,1);
        assert.ok(!lines[0].includes('private feedback'));
    } finally {console.info = original;}
});
