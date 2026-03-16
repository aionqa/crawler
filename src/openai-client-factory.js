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

/**
 * Create OpenAI client that uses the configured AI service (no fallbacks).
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

  console.log(`[OpenAI-Client] Using AI Service: ${aiServiceUrl} for project ${projectId}${jobId ? ` (job: ${jobId})` : ''}`);
  const isInvalidTokenError = (error) => {
    const status = error?.response?.status || error?.status;
    const msg = String(error?.message || '');
    const responseMsg = String(error?.response?.data?.error?.message || error?.response?.data?.error || '');
    return status === 401 || /invalid token/i.test(msg) || /invalid token/i.test(responseMsg);
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
                let response;
                try {
                  response = await axios.post(`${aiServiceUrl}/api/ai/chat`, requestBody, requestConfig(token));
                } catch (requestError) {
                  if (projectId && jobId && isInvalidTokenError(requestError)) {
                    console.warn(`[OpenAI-Client] Invalid token detected, refreshing token and retrying once...`);
                    invalidateAIServiceToken(jobId);
                    token = await getAIServiceTokenInternal(projectId, jobId, true);
                    response = await axios.post(`${aiServiceUrl}/api/ai/chat`, requestBody, requestConfig(token));
                  } else {
                    throw requestError;
                  }
                }
                
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
              let response;
              try {
                response = await axios.post(`${aiServiceUrl}/api/ai/chat`, requestBody, requestConfig(token));
              } catch (requestError) {
                if (projectId && jobId && isInvalidTokenError(requestError)) {
                  console.warn(`[OpenAI-Client] Invalid token detected, refreshing token and retrying once...`);
                  invalidateAIServiceToken(jobId);
                  token = await getAIServiceTokenInternal(projectId, jobId, true);
                  response = await axios.post(`${aiServiceUrl}/api/ai/chat`, requestBody, requestConfig(token));
                } else {
                  throw requestError;
                }
              }
              
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
