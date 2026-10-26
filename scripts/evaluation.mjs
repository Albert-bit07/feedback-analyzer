import { validateAnalysis } from '../src/processing.ts';

const sentiments = ['positive', 'neutral', 'negative'];
function text(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error('Invalid ' + field);
  }
  return value.trim();
}
function rowsById(rows, field) {
  if (!Array.isArray(rows)) throw new Error('Expected ' + field + ' array');
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid ' + field + ' row');
    const id = text(row.id, 'example ID', 128);
    if (result.has(id)) throw new Error('Duplicate example ID');
    result.set(id, row);
  }
  return result;
}

export function evaluate(dataset, predictions) {
  const datasetId = text(dataset?.dataset_id, 'dataset_id');
  const provenance = text(dataset?.provenance, 'provenance', 1000);
  const modelVersion = text(predictions?.model_version, 'model_version');
  const promptVersion = text(predictions?.prompt_version, 'prompt_version');
  const labels = rowsById(dataset.examples, 'examples');
  if (!labels.size) throw new Error('Dataset must not be empty');
  const outputs = rowsById(predictions.predictions, 'predictions');
  for (const id of outputs.keys()) {
    if (!labels.has(id)) throw new Error('Prediction ID is absent from dataset');
  }
  const confusion = Object.fromEntries(sentiments.map(label => [label,
    Object.fromEntries([...sentiments, 'missing', 'invalid'].map(predicted => [predicted, 0]))]));
  let valid = 0, missing = 0, invalid = 0, sentimentCorrect = 0, categoryCorrect = 0;
  const mismatches = [];
  for (const [id, label] of labels) {
    if (!sentiments.includes(label.sentiment)) throw new Error('Invalid expected sentiment');
    const category = text(label.category, 'expected category', 80);
    let output;
    let status = 'valid';
    if (!outputs.has(id)) { missing++; status = 'missing'; }
    else {
      try { output = validateAnalysis(outputs.get(id).output); valid++; }
      catch { invalid++; status = 'invalid'; }
    }
    confusion[label.sentiment][output?.sentiment ?? status]++;
    const sentimentMatches = output?.sentiment === label.sentiment;
    const categoryMatches = output?.category === category;
    if (sentimentMatches) sentimentCorrect++;
    if (categoryMatches) categoryCorrect++;
    if (!sentimentMatches || !categoryMatches) {
      mismatches.push({id, status, expected: {sentiment:label.sentiment, category},
        actual: output ? {sentiment:output.sentiment, category:output.category} : null});
    }
  }
  // Missing and invalid predictions stay in the denominator, so partial runs
  // cannot appear more accurate simply by omitting difficult examples.
  return {schema_version:1, dataset_id:datasetId, provenance,
    model_version:modelVersion, prompt_version:promptVersion,
    counts:{total:labels.size, valid, missing, invalid, sentiment_correct:sentimentCorrect, category_correct:categoryCorrect},
    metrics:{valid_output_rate:valid/labels.size, sentiment_accuracy:sentimentCorrect/labels.size,
      category_exact_match:categoryCorrect/labels.size},
    sentiment_confusion:confusion, mismatches};
}
