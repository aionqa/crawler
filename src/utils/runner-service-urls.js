/**
 * Runner/crawler defaults when env is unset. Production uses AWS; local Docker Compose must set
 * BACKEND_URL (e.g. http://back:4000) and optionally AI_SERVICE_URL for self-hosted AI.
 */

export const DEFAULT_RUNNER_BACKEND_URL = 'https://api.aionqa.com';

export function getRunnerBackendUrl() {
  const u = typeof process.env.BACKEND_URL === 'string' ? process.env.BACKEND_URL.trim() : '';
  return u || DEFAULT_RUNNER_BACKEND_URL;
}

/** Managed AI service base (paths include /api/ai/chat). */
export const DEFAULT_AI_SERVICE_BASE_URL = 'https://ai.aionqa.com';

export function getDefaultAiServiceBaseUrl() {
  const u = typeof process.env.AI_SERVICE_URL === 'string' ? process.env.AI_SERVICE_URL.trim() : '';
  return u || DEFAULT_AI_SERVICE_BASE_URL;
}

/**
 * True when URL points at the Node backend's OpenAI proxy or docker-only hostname — not a runnable AI service from crawler containers.
 */
export function isDockerInternalBackendAiUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.hostname === 'back') return true;
    const p = u.pathname.replace(/\/+$/, '');
    if (p === '/openai' || p.endsWith('/openai')) return true;
    return false;
  } catch {
    return false;
  }
}
