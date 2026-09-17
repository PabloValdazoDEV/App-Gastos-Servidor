// One source of defaults for environment parsing and optional/lazy AI services.
export const DEFAULT_RECEIPT_ANALYSIS_CONFIG = Object.freeze({
  receiptModel: 'gpt-5.6-luna',
  timeoutMs: 60_000,
  maxOutputTokens: 8192,
  analysisLimitPerHour: 10,
});
