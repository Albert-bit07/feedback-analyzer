export const FAILURE_CODES = ['input_failed', 'inference_failed', 'inference_timeout', 'invalid_analysis', 'persistence_failed', 'attempt_limit', 'unknown'] as const;

export function publicProcessingError(value: unknown): typeof FAILURE_CODES[number] | null {
  if (value === null || value === undefined) return null;
  return FAILURE_CODES.find(code => code === value) ?? 'unknown';
}
