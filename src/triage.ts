export const triageHTML = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback triage</title>
<style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;background:#f8fafc;color:#172033}input,textarea,button{font:inherit;padding:10px}input,textarea{display:block;width:95%;margin:8px 0 16px}article,form{background:white;padding:24px;margin:20px 0;border:1px solid #cbd5e1;border-radius:12px}button{cursor:pointer}#message{white-space:pre-wrap}small{display:block;color:#475569}</style>
<h1>Feedback triage</h1><p>Submit a report, inspect its processing state, and resolve or reopen it. <a href="/">Summary dashboard</a></p>
<form id="submission"><h2>Submit feedback</h2><label>Title<input name="title" required maxlength="200"></label><label>Description<textarea name="description" required maxlength="8000"></textarea></label><label>Source<input name="source" required maxlength="80" value="manual"></label><button>Submit</button></form>
<section aria-labelledby="processing-heading"><h2 id="processing-heading">Processing health</h2><p id="processing-health" role="status">Loading processing state…</p><small>Current job state. Retry counts reset when a failed job is replayed; this is not a lifetime usage metric.</small></section>
<p id="message" role="status"></p><button id="refresh">Refresh</button><main id="items"></main>
<script>
const message = document.getElementById('message');
async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error('Request failed (' + response.status + '). Retry or check your credentials.');
  return response.json();
}
async function refreshHealth() {
  const element = document.getElementById('processing-health');
  try {
    const health = await api('/api/processing/health');
    const age = health.oldest_active_age_seconds === null ? 'none' : health.oldest_active_age_seconds + ' seconds';
    element.textContent = 'Ready: ' + health.ready_pending + ' · Delayed: ' + health.delayed_pending +
      ' · Processing: ' + health.processing + ' (expired leases: ' + health.expired_leases + ')' +
      ' · Failed: ' + health.failed + ' · Completed: ' + health.completed +
      ' · Retried jobs: ' + health.retried_jobs + ' · Oldest active job: ' + age;
  } catch (error) { element.textContent = 'Processing health unavailable. Refresh to retry.'; }
}
async function refresh() {
  await refreshHealth();
  const rows = await api('/api/triage');
  const root = document.getElementById('items'); root.replaceChildren();
  if (!rows.length) root.textContent = 'No feedback yet.';
  for (const row of rows) {
    const card = document.createElement('article');
    const title = document.createElement('h2'); title.textContent = '#' + row.id + ' ' + row.title;
    const detail = document.createElement('p'); detail.textContent = row.description;
    const state = document.createElement('small'); state.textContent = row.source + ' · ' + (row.resolved_at ? 'Resolved' : 'Open') + ' · Analysis: ' + (row.processing_status || 'Legacy fixture') + ' · Attempts: ' + (row.attempts || 0);
    const button = document.createElement('button'); button.textContent = row.resolved_at ? 'Reopen' : 'Resolve';
    button.onclick = async () => {
      button.disabled = true;
      try { await api('/api/feedback/' + row.id + '/status', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:row.resolved_at ? 'open':'resolved'})}); await refresh(); }
      catch (error) { message.textContent = error.message; button.disabled = false; }
    };
    card.append(title,detail,state,button);
    if (row.analysis_summary) {
      const analysis = document.createElement('p');
      analysis.textContent = 'Analysis: ' + row.analysis_summary + ' · ' + row.analysis_sentiment + ' · ' + row.inference_ms + ' ms';
      card.append(analysis);
    }
    if (row.last_error) {
      const error = document.createElement('small'); error.textContent = 'Processing error: ' + row.last_error;
      card.append(error);
    }
    if (row.processing_status === 'failed') {
      const replay = document.createElement('button'); replay.textContent = 'Retry analysis';
      replay.onclick = async () => {
        replay.disabled = true;
        try { await api('/api/feedback/' + row.id + '/replay', {method:'POST'}); await refresh(); }
        catch (error) { message.textContent = error.message; replay.disabled = false; }
      };
      card.append(replay);
    }
    root.append(card);
  }
}
let pending = null;
document.getElementById('submission').onsubmit = async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button');
  const body = JSON.stringify(Object.fromEntries(new FormData(form)));
  if (!pending || pending.body !== body) pending = {body,key:crypto.randomUUID()};
  button.disabled = true;
  try {
    const result = await api('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':pending.key},body});
    pending = null; form.reset(); message.textContent = 'Feedback #' + result.id + ' saved. Analysis is pending.'; await refresh();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
};
document.getElementById('refresh').onclick = () => refresh().catch(error => message.textContent = error.message);
refresh().catch(error => message.textContent = error.message);
</script></html>`;
