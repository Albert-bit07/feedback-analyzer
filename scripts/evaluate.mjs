import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluate } from './evaluation.mjs';

try {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/evaluate.mjs labels.json predictions.json');
  const [labels, predictions] = await Promise.all(process.argv.slice(2).map(path => readFile(path, 'utf8')));
  const report = evaluate(JSON.parse(labels), JSON.parse(predictions));
  const hash = value => createHash('sha256').update(value).digest('hex');
  report.input_sha256 = {labels:hash(labels), predictions:hash(predictions)};
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch {
  // Input files may contain private feedback; do not echo parse errors or contents.
  process.stderr.write('Evaluation failed: supply valid labels and predictions files matching the documented schema.\n');
  process.exitCode = 1;
}
