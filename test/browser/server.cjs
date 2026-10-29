const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const state = mkdtempSync(path.join(tmpdir(), 'feedback-browser-'));
const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const config = path.join(__dirname, 'wrangler.jsonc');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const migration = spawnSync(process.execPath, [cli, 'd1', 'migrations', 'apply', 'browser-feedback',
  '--local', '--config', config, '--persist-to', state], { cwd: root, env, stdio: 'inherit' });
if (migration.status !== 0) {
  rmSync(state, { recursive: true, force: true });
  process.exit(migration.status || 1);
}
const child = spawn(process.execPath, [cli, 'dev', '--local', '--config', config,
  '--persist-to', state, '--ip', '127.0.0.1', '--port', '18787'], { cwd: root, env, stdio: 'inherit' });
let stopping = false;
let timer;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  timer = setTimeout(() => child.kill('SIGKILL'), 5000);
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timer);
  rmSync(state, { recursive: true, force: true });
  process.exitCode = stopping ? 0 : (code ?? 1);
});
