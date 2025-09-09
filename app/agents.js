import { randomUUID } from 'crypto';

// Resolve agent URLs from environment or provided overrides
export function getAgentUrls(overrides = {}) {
  // Default to conventional local ports so backend works out-of-the-box
  const defaults = {
    loginSimplified: 'http://127.0.0.1:3001',
    loginText: 'http://127.0.0.1:3002',
    loginMedia: 'http://127.0.0.1:3003',
    loginStatic: 'http://127.0.0.1:3004'
  };
  return {
    loginSimplified: overrides.loginSimplified || process.env.LOGIN_SIMPLIFIED_URL || defaults.loginSimplified,
    loginText: overrides.loginText || process.env.LOGIN_TEXT_URL || defaults.loginText,
    loginMedia: overrides.loginMedia || process.env.LOGIN_MEDIA_URL || defaults.loginMedia,
    loginStatic: overrides.loginStatic || process.env.LOGIN_STATIC_URL || defaults.loginStatic
  };
}

export async function callJsonRpc(baseUrl, method, params = {}, opts = {}) {
  const id = randomUUID();
  const controller = new AbortController();
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 65000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.error?.message || `HTTP ${res.status}`);
    }
    if (json?.error) {
      throw new Error(String(json.error.message || 'RPC error'));
    }
    return json?.result;
  } finally {
    clearTimeout(t);
  }
}

export async function tryLoginAgents({
  url,
  credentials,
  options,
  agentOrder,
  agentUrlsOverrides
}) {
  const urls = getAgentUrls(agentUrlsOverrides);
  const order = agentOrder && Array.isArray(agentOrder) && agentOrder.length
    ? agentOrder
    : ['login-simplified', 'login-text', 'login-media', 'login-static'];

  const nameToUrl = {
    'login-simplified': urls.loginSimplified,
    'login-text': urls.loginText,
    'login-media': urls.loginMedia,
    'login-static': urls.loginStatic
  };

  const attempts = [];
  const isConfigured = (u) => {
    if (!u) return false;
    const s = String(u).trim().toLowerCase();
    if (!s || s === 'disabled' || /:(?:0|undefined|null)(?:\b|$)/.test(s)) return false;
    return true;
  };
  const filtered = order.filter((n) => isConfigured(nameToUrl[n]));
  if (filtered.length === 0) {
    return { success: false, winner: null, attempts, message: 'No agents configured. Start agents or set LOGIN_*_URL envs.', configured: urls };
  }
  for (const agentName of filtered) {
    const baseUrl = nameToUrl[agentName];
    const startedAt = new Date();
    try {
      const result = await callJsonRpc(baseUrl, 'attemptLogin', { url, credentials, options }, { timeoutMs: (options?.maxWaitMsPerAction || 60000) + 10000 });
      const success = !!result?.data?.success;
      attempts.push({ agent: agentName, success, result });
      if (success) break; // stop on first success
    } catch (error) {
      attempts.push({ agent: agentName, success: false, error: String(error?.message || error) });
    } finally {
      const endedAt = new Date();
      attempts[attempts.length - 1].duration_ms = endedAt - startedAt;
    }
  }

  const firstSuccess = attempts.find(a => a.success);
  return {
    success: !!firstSuccess,
    winner: firstSuccess ? firstSuccess.agent : null,
    attempts,
    configured: urls
  };
}

export default {
  callJsonRpc,
  tryLoginAgents,
  getAgentUrls
};


