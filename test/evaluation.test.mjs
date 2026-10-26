import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../scripts/evaluation.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Synthetic cases verify arithmetic and error handling, not model quality.
const dataset = {dataset_id:'synthetic-unit-cases',provenance:'Handwritten synthetic test labels',examples:[
  {id:'a',sentiment:'positive',category:'UX'},
  {id:'b',sentiment:'negative',category:'speed'},
  {id:'c',sentiment:'neutral',category:'billing'},
  {id:'d',sentiment:'negative',category:'support'},
]};
const predictions = {model_version:'test-double',prompt_version:'test-v1',predictions:[
  {id:'a',output:{sentiment:'positive',category:'UX',summary:'Private report text'}},
  {id:'b',output:{sentiment:'positive',category:'speed',summary:'Another report'}},
  {id:'c',output:{sentiment:'neutral',category:'billing',summary:''}},
]};
test('counts incomplete and invalid outputs as failures with a fixed denominator',()=>{
  const result=evaluate(dataset,predictions);
  assert.deepEqual(result.counts,{total:4,valid:2,missing:1,invalid:1,sentiment_correct:1,category_correct:2});
  assert.deepEqual(result.metrics,{valid_output_rate:.5,sentiment_accuracy:.25,category_exact_match:.5});
  assert.equal(result.sentiment_confusion.negative.positive,1);
  assert.equal(result.sentiment_confusion.negative.missing,1);
  assert.equal(result.sentiment_confusion.neutral.invalid,1);
  assert.deepEqual(result.mismatches.map(row=>row.id),['b','c','d']);
  assert.ok(!JSON.stringify(result).includes('Private report text'));
});
test('rejects ambiguous IDs, invalid labels and empty datasets',()=>{
  for(const changed of [[],[...dataset.examples,dataset.examples[0]], [{id:'a',sentiment:'bad',category:'UX'}]]) {
    assert.throws(()=>evaluate({...dataset,examples:changed},predictions));
  }
  for(const changed of [[...predictions.predictions,predictions.predictions[0]], [{id:'unknown',output:{}}]]) {
    assert.throws(()=>evaluate(dataset,{...predictions,predictions:changed}));
  }
  assert.throws(()=>evaluate({...dataset,provenance:''},predictions));
  assert.throws(()=>evaluate(dataset,{...predictions,model_version:''}));
});
test('uses the serving output validator and case-sensitive exact category matching',()=>{
  const labels={...dataset,examples:[dataset.examples[0]]};
  const result=evaluate(labels,{...predictions,predictions:[{id:'a',output:{sentiment:'positive',category:'ux',summary:'Valid'}}]});
  assert.equal(result.metrics.sentiment_accuracy,1);
  assert.equal(result.metrics.category_exact_match,0);
  const invalid=evaluate(labels,{...predictions,predictions:[{id:'a',output:{sentiment:['positive'],category:'UX',summary:'Valid'}}]});
  assert.equal(invalid.counts.invalid,1);
  assert.equal(invalid.metrics.sentiment_accuracy,0);
});
test('an entirely missing run has zero accuracy, not undefined or perfect accuracy',()=>{
  const result=evaluate(dataset,{...predictions,predictions:[]});
  assert.equal(result.counts.missing,4);
  assert.deepEqual(result.metrics,{valid_output_rate:0,sentiment_accuracy:0,category_exact_match:0});
});
test('CLI emits a reproducible report and fails closed without echoing malformed input',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'feedback-evaluation-'));
  try {
    const labels=join(dir,'labels.json'), outputs=join(dir,'predictions.json');
    await writeFile(labels,JSON.stringify(dataset)); await writeFile(outputs,JSON.stringify(predictions));
    const run=()=>spawnSync(process.execPath,['scripts/evaluate.mjs',labels,outputs],{encoding:'utf8'});
    const first=run(), second=run();
    assert.equal(first.status,0,first.stderr);
    assert.equal(first.stdout,second.stdout);
    const report=JSON.parse(first.stdout);
    assert.match(report.input_sha256.labels,/^[a-f0-9]{64}$/);
    assert.equal(report.counts.total,4);
    await writeFile(outputs,'secret invalid JSON');
    const failed=run();
    assert.equal(failed.status,1);
    assert.equal(failed.stdout,'');
    assert.ok(!failed.stderr.includes('secret invalid JSON'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
