/**
 * Axios instance with bounded exponential backoff for transient backend/ALB failures
 * (502/503/504/429/408, connection resets, timeouts) during long-running crawls.
 */
import axios from 'axios';
import { isTransientGatewayError, isNetworkUnreachableError } from '../openai-client-factory.js';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_MS = 400;
const DEFAULT_CAP_MS = 12000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryBackendRequest(error) {
  if (!error || error.config?.__skipBackendRetry) return false;
  if (isTransientGatewayError(error)) return true;
  if (isNetworkUnreachableError(error)) return true;
  return false;
}

/**
 * @returns {import('axios').AxiosInstance}
 */
export function createBackendAxiosWithRetries(options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseMs = options.baseDelayMs ?? DEFAULT_BASE_MS;
  const capMs = options.capDelayMs ?? DEFAULT_CAP_MS;

  const instance = axios.create();

  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;
      if (!config || !shouldRetryBackendRequest(error)) {
        return Promise.reject(error);
      }
      const attempt = (config.__backendRetryCount || 0) + 1;
      if (attempt > maxRetries) {
        return Promise.reject(error);
      }
      config.__backendRetryCount = attempt;
      const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 200);
      const delayMs = exp + jitter;
      const status = error.response?.status;
      const code = error.code || '';
      console.warn(
        `[backend-http-retry] transient backend error (attempt ${attempt}/${maxRetries}) status=${status || 'n/a'} code=${code || 'n/a'}: ${error.message}; waiting ${delayMs}ms`
      );
      await sleep(delayMs);
      return instance(config);
    }
  );

  return instance;
}
