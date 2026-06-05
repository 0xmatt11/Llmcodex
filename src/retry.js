export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryableHttpError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'RetryableHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function withRetry(fn, { attempts = 4, baseDelayMs = 500, maxDelayMs = 10000, logger } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof RetryableHttpError || ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(error.code);
      if (!retryable || attempt === attempts) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = error.retryAfterMs ?? Math.round(exponential * (0.75 + Math.random() / 2));
      logger?.warn({ err: error, attempt, delay }, 'retrying transient operation');
      await sleep(delay);
    }
  }
  throw lastError;
}

export function retryAfterMs(headers) {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}
