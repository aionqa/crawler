/**
 * OpenAI Client Factory
 * Creates OpenAI client that uses AionQA AI Service instead of direct OpenAI API
 */

import OpenAI from 'openai';
import axios from 'axios';
import { getAIServiceToken, getAIServiceTokenInternal, invalidateAIServiceToken } from './ai-token-manager.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
// Prefer context.ai_services (injected by backend / helper config).
// For local Docker runs, we also support env AI_SERVICE_URL as a fallback.
const AI_SERVICE_TOKEN = process.env.RUNNER_TOKEN || process.env.AI_SERVICE_TOKEN;

/** Deduped ordered list: primary + other ai_services + env + stable Docker DNS name (helpers may mint ephemeral ai-service-xxxxxx that is not resolvable from the crawler network). */
function collectAiServiceBaseUrlCandidates(primaryUrl, context) {
  const seen = new Set();
  const out = [];
  const push = (u) => {
    const t = typeof u === 'string' ? u.trim() : '';
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  push(primaryUrl);
  if (Array.isArray(context?.ai_services)) {
    for (const s of context.ai_services) {
      if (s?.url) push(String(s.url).trim());
    }
  }
  if (process.env.AI_SERVICE_URL) push(String(process.env.AI_SERVICE_URL).trim());
  push('http://aionqa-ai-service:5000');
  // Last resort: managed AI (same contract as shared docker-engine helpers) when self-hosted
  // ephemeral hostnames (ai-service-xxxxxx) are not resolvable from the crawler network.
  const rawManaged = process.env.AIONQA_MANAGED_AI_FALLBACK_URL;
  const managedDisabled =
    rawManaged != null && ['0', 'false', 'off'].includes(String(rawManaged).trim().toLowerCase());
  const managedUrl = managedDisabled
    ? ''
    : String(rawManaged != null && String(rawManaged).trim() !== '' ? rawManaged : 'https://ai.aionqa.com')
        .trim()
        .replace(/\/$/, '');
  if (managedUrl) push(managedUrl);
  return out;
}

/** Walk Axios/Node error chains (cause, AggregateError) so DNS failures still trigger failover. */
function collectDeepErrorCodes(error, depth = 0) {
  if (!error || depth > 8) return [];
  const out = [];
  const c = error.code;
  if (c) out.push(String(c).toUpperCase());
  if (error.cause) out.push(...collectDeepErrorCodes(error.cause, depth + 1));
  if (Array.isArray(error.errors)) {
    for (const e of error.errors) out.push(...collectDeepErrorCodes(e, depth + 1));
  }
  return out;
}

function collectDeepMessages(error, depth = 0) {
  if (!error || depth > 8) return '';
  const parts = [String(error.message || '')];
  if (error.cause) parts.push(collectDeepMessages(error.cause, depth + 1));
  if (Array.isArray(error.errors)) {
    for (const e of error.errors) parts.push(collectDeepMessages(e, depth + 1));
  }
  return parts.filter(Boolean).join(' ');
}

export function isNetworkUnreachableError(error) {
  if (!error) return false;
  const codes = collectDeepErrorCodes(error);
  const msg = `${String(error.message || '')} ${collectDeepMessages(error)}`.toLowerCase();
  if (String(error.syscall || '').toLowerCase() === 'getaddrinfo') return true;
  // Ephemeral helper hostnames (ai-service-*) often fail with ENOTFOUND from sibling crawler containers.
  if (/ai-service-[a-z0-9-]+/i.test(msg) && (msg.includes('enotfound') || msg.includes('getaddrinfo'))) return true;
  return (
    codes.some((code) =>
      ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ERR_NETWORK', 'ECONNABORTED'].includes(code)
    ) ||
    msg.includes('getaddrinfo') ||
    /getaddrinfo\s+enotfound/i.test(msg) ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up')
  );
}

/**
 * Append stable AI service URLs (Docker DNS + optional managed) when the backend/helper only lists
 * an ephemeral ai-service-* hostname. Ensures makeAICallWithPrompt's outer service loop can advance
 * after DNS failures, and matches collectAiServiceBaseUrlCandidates fallbacks.
 * @param {Array<{url?: string, max_input_tokens?: number, label?: string}>|null|undefined} aiServices
 * @returns {typeof aiServices}
 */
export function mergeDnsFailoverAiServices(aiServices) {
  if (!Array.isArray(aiServices) || aiServices.length === 0) return aiServices;
  const seen = new Set();
  const out = [];
  const norm = (u) => {
    try {
      return new URL(u).href.replace(/\/$/, '');
    } catch {
      return String(u || '').trim().replace(/\/$/, '');
    }
  };
  let maxInputAmongConfigured = 128000;
  for (const s of aiServices) {
    if (!s || !s.url) continue;
    const mt = Number(s.max_input_tokens);
    if (Number.isFinite(mt) && mt > 0) maxInputAmongConfigured = Math.max(maxInputAmongConfigured, mt);
    const key = norm(s.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  // Failover entries must stay eligible when the primary service advertises a higher context window
  // than 128k; otherwise eligibleServices filters them out and DNS failover never runs.
  const failoverTokenLimit = Math.max(128000, maxInputAmongConfigured);
  const fallbacks = [
    { url: 'http://aionqa-ai-service:5000', max_input_tokens: failoverTokenLimit, label: 'failover-stable-docker-ai-service' }
  ];
  const rawManaged = process.env.AIONQA_MANAGED_AI_FALLBACK_URL;
  const managedDisabled =
    rawManaged != null && ['0', 'false', 'off'].includes(String(rawManaged).trim().toLowerCase());
  const managedUrl = managedDisabled
    ? ''
    : String(rawManaged != null && String(rawManaged).trim() !== '' ? rawManaged : 'https://ai.aionqa.com')
        .trim()
        .replace(/\/$/, '');
  if (managedUrl) {
    fallbacks.push({ url: managedUrl, max_input_tokens: failoverTokenLimit, label: 'failover-managed-ai' });
  }
  for (const f of fallbacks) {
    const key = norm(f.url);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/**
 * Create OpenAI client that uses the configured AI service, with DNS/network failover to other configured URLs and stable Docker hostnames.
 * @param {Object} context - Job context containing llm_config.endpoint (from helper ai_services), project_id, job_id
 * @param {string} fallbackApiKey - Fallback API key for backward compatibility (deprecated)
 * @returns {OpenAI} OpenAI client instance
 */
export function createOpenAIClient(context = {}, fallbackApiKey = null) {
  const llmConfig = context.llm_config || {};
  const openaiOptions = (context.openai_options && typeof context.openai_options === 'object') ? context.openai_options : {};
  const projectId = context.project_id || context.projectId;
  const jobId = context.job_id || context.jobId;

  // All AI requests must use the project's configured AI service (context from backend/helper).
  // Prefer llm_config.endpoint, then context.ai_services (injected per project); env only when no project/job.
  const aiServiceUrl = (() => {
    const explicit = llmConfig.endpoint && String(llmConfig.endpoint).trim();
    if (explicit) return explicit;

    const fromServices = Array.isArray(context.ai_services) ? context.ai_services : [];
    const firstUrl = fromServices
      .map((s) => (s && s.url) ? String(s.url).trim() : '')
      .find(Boolean);
    if (firstUrl) return firstUrl;

    // When running in a job with project context, do not fall back to env — project must have configured AI.
    if (projectId || jobId) {
      return '';
    }
    // Local dev only: allow env when no project/job (e.g. local Docker, scripts).
    const fromEnv = process.env.AI_SERVICE_URL && String(process.env.AI_SERVICE_URL).trim();
    return fromEnv || '';
  })();
  if (!aiServiceUrl) {
    throw new Error('AI not configured. Set the project\'s AI service (Settings → LLM / endpoint) or add at least one AI service in the helper config.');
  }

  const aiServiceUrlCandidates = collectAiServiceBaseUrlCandidates(aiServiceUrl, context);
  console.log(`[OpenAI-Client] Using AI Service: ${aiServiceUrl} for project ${projectId}${jobId ? ` (job: ${jobId})` : ''}${aiServiceUrlCandidates.length > 1 ? ` (${aiServiceUrlCandidates.length} URL candidates for DNS/network failover)` : ''}`);

  const isInvalidTokenError = (error) => {
    const status = error?.response?.status || error?.status;
    const msg = String(error?.message || '');
    const responseMsg = String(error?.response?.data?.error?.message || error?.response?.data?.error || '');
    return status === 401 || /invalid token/i.test(msg) || /invalid token/i.test(responseMsg);
  };

  const postToAiServiceWithFailover = async (requestBody, requestConfig, initialToken) => {
    let currentToken = initialToken;
    let lastError;
    for (let i = 0; i < aiServiceUrlCandidates.length; i++) {
      const baseUrl = String(aiServiceUrlCandidates[i]).replace(/\/$/, '');
      const url = `${baseUrl}/api/ai/chat`;
      let tried401 = false;
      for (;;) {
        try {
          const response = await axios.post(url, requestBody, requestConfig(currentToken));
          if (i > 0) {
            console.log(`[OpenAI-Client] Failover succeeded using ${baseUrl}`);
          }
          return response;
        } catch (e) {
          lastError = e;
          if (!tried401 && projectId && jobId && isInvalidTokenError(e)) {
            tried401 = true;
            console.warn('[OpenAI-Client] Invalid token detected, refreshing token and retrying once...');
            invalidateAIServiceToken(jobId);
            currentToken = await getAIServiceTokenInternal(projectId, jobId, true);
            continue;
          }
          if (isNetworkUnreachableError(e) && i < aiServiceUrlCandidates.length - 1) {
            console.warn(`[OpenAI-Client] Unreachable at ${baseUrl}: ${e.message}; trying next AI service URL...`);
            break;
          }
          throw e;
        }
      }
    }
    throw lastError;
  };

  // Create a custom OpenAI client that uses axios to call the AI service
  return new Proxy(new OpenAI({ apiKey: 'ai-service' }), {
    get(target, prop) {
      if (prop === 'chat') {
        return {
          completions: {
            create: async (params) => {
              try {
                // Always get 24-hour AI service token from backend (required for authentication)
                let token = null;
                if (projectId && jobId) {
                  try {
                    token = await getAIServiceToken(projectId, jobId);
                    if (!token) {
                      throw new Error('Token request returned null');
                    }
                    console.log(`[OpenAI-Client] Using AI service token for authentication`);
                  } catch (tokenError) {
                    console.error(`[OpenAI-Client] Failed to get AI service token:`, tokenError.message);
                    if (tokenError.response) {
                      console.error(`  Status: ${tokenError.response.status}`);
                      console.error(`  Response:`, tokenError.response.data);
                    }
                    // Don't use fallback - fail explicitly
                    throw new Error(`Failed to get AI service token: ${tokenError.message}`);
                  }
                } else {
                  // Fallback to RUNNER_TOKEN if project/job IDs not available
                  token = AI_SERVICE_TOKEN;
                  if (!token) {
                    throw new Error('No AI service token available and project/job IDs not provided');
                  }
                  console.log(`[OpenAI-Client] Using fallback token (project/job IDs not available)`);
                }
                
                const requestBody = {
                  project_id: projectId,
                  job_id: jobId,
                  messages: params.messages,
                  model: params.model || llmConfig.model || openaiOptions.model || 'gpt-5-mini',
                  temperature: params.temperature,
                  max_tokens: params.max_tokens,
                  ...params
                };
                const requestConfig = (authToken) => ({
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authToken && { 'Authorization': `Bearer ${authToken}` })
                  },
                  timeout: 900000 // 15 minutes timeout for AI requests
                });
                const response = await postToAiServiceWithFailover(requestBody, requestConfig, token);

                // Return in OpenAI format
                return response.data;
              } catch (error) {
                console.error(`[OpenAI-Client] AI Service request failed:`, error.message);
                if (error.response) {
                  // Convert axios error to OpenAI-like error
                  const err = new Error(error.response.data?.error?.message || error.response.data?.error || error.message);
                  err.status = error.response.status;
                  err.response = error.response.data;
                  throw err;
                }
                throw error;
              }
            }
          }
        };
      }
      if (prop === 'responses') {
        // Support for responses.create() (used by AIConversationLogger)
        return {
          create: async (params) => {
            try {
              // Always get 24-hour AI service token from backend (required for authentication)
              let token = null;
              if (projectId && jobId) {
                try {
                  token = await getAIServiceToken(projectId, jobId);
                  if (!token) {
                    throw new Error('Token request returned null');
                  }
                  console.log(`[OpenAI-Client] Using AI service token for authentication`);
                } catch (tokenError) {
                  console.error(`[OpenAI-Client] Failed to get AI service token:`, tokenError.message);
                  if (tokenError.response) {
                    console.error(`  Status: ${tokenError.response.status}`);
                    console.error(`  Response:`, tokenError.response.data);
                  }
                  // Don't use fallback - fail explicitly
                  throw new Error(`Failed to get AI service token: ${tokenError.message}`);
                }
              } else {
                // Fallback to RUNNER_TOKEN if project/job IDs not available
                token = AI_SERVICE_TOKEN;
                if (!token) {
                  throw new Error('No AI service token available and project/job IDs not provided');
                }
                console.log(`[OpenAI-Client] Using fallback token (project/job IDs not available)`);
              }
              
              const requestBody = {
                project_id: projectId,
                job_id: jobId,
                input: params.input || params.messages, // Support both formats
                messages: params.messages,
                model: params.model || llmConfig.model || openaiOptions.model || 'gpt-5-mini',
                temperature: params.temperature,
                max_tokens: params.max_tokens,
                ...params
              };
              const requestConfig = (authToken) => ({
                headers: {
                  'Content-Type': 'application/json',
                  ...(authToken && { 'Authorization': `Bearer ${authToken}` })
                },
                timeout: 900000 // 15 minutes timeout for AI requests
              });
              const response = await postToAiServiceWithFailover(requestBody, requestConfig, token);

              // Return in OpenAI format
              return response.data;
            } catch (error) {
              console.error(`[OpenAI-Client] AI Service request failed:`, error.message);
              if (error.response) {
                // Convert axios error to OpenAI-like error
                const err = new Error(error.response.data?.error?.message || error.response.data?.error || error.message);
                err.status = error.response.status;
                err.response = error.response.data;
                throw err;
              }
              throw error;
            }
          }
        };
      }
      return target[prop];
    }
  });
}
