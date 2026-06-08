/**
 * Single-attempt backend HTTP helpers.
 *
 * Per .cursor/rules/52-no-retries-one-attempt.mdc, every HTTP/AI/job operation runs
 * exactly once — no transient-error retry loops, no exponential backoff, no
 * MAX_TRANSIENT_RETRIES. These helpers retain their export names (callers depend on
 * them) but now execute the operation a single time; if it fails, it fails.
 */
import axios from 'axios';

/**
 * Run an async operation exactly once. Retained for call-site compatibility; no retry.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function retryTransientAsync(fn) {
  return await fn();
}

/**
 * Plain axios instance with no retry interceptor (single attempt per request).
 * @returns {import('axios').AxiosInstance}
 */
export function createBackendAxiosWithRetries() {
  return axios.create();
}
