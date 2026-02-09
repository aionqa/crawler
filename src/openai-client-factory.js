/**
 * OpenAI Client Factory
 * Creates OpenAI client that uses AionQA AI Service instead of direct OpenAI API
 */

import OpenAI from 'openai';
import axios from 'axios';
import { getAIServiceToken } from './ai-token-manager.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://aionqa-ai-service:5000';
// Fallback token for backward compatibility (deprecated - use 24-hour tokens instead)
const AI_SERVICE_TOKEN = process.env.RUNNER_TOKEN || process.env.AI_SERVICE_TOKEN;

/**
 * Create OpenAI client that uses AionQA AI Service
 * @param {Object} context - Job context containing llm_config, project_id, job_id
 * @param {string} fallbackApiKey - Fallback API key for backward compatibility (deprecated)
 * @returns {OpenAI} OpenAI client instance
 */
export function createOpenAIClient(context = {}, fallbackApiKey = null) {
  const llmConfig = context.llm_config || {};
  const projectId = context.project_id || context.projectId;
  const jobId = context.job_id || context.jobId;
  
  // Determine AI service URL. When running on a remote helper, llm_config.endpoint may be
  // the backend URL (e.g. http://back:4000/openai) which does not resolve; use AI_SERVICE_URL.
  let aiServiceUrl = llmConfig.endpoint || AI_SERVICE_URL;
  const isBackendUrl = !aiServiceUrl || aiServiceUrl.includes('back') || aiServiceUrl.includes('/openai');
  if (isBackendUrl && AI_SERVICE_URL) {
    aiServiceUrl = AI_SERVICE_URL;
  }

  // Always use AI service (no direct OpenAI API calls)
  console.log(`[OpenAI-Client] Using AI Service: ${aiServiceUrl} for project ${projectId}${jobId ? ` (job: ${jobId})` : ''}`);
  
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
                
                // Call the AI service endpoint
                const response = await axios.post(
                  `${aiServiceUrl}/api/ai/chat`,
                  {
                    project_id: projectId,
                    job_id: jobId,
                    messages: params.messages,
                    model: params.model || llmConfig.model || 'gpt-5-mini',
                    temperature: params.temperature,
                    max_tokens: params.max_tokens,
                    ...params
                  },
                  {
                    headers: {
                      'Content-Type': 'application/json',
                      ...(token && { 'Authorization': `Bearer ${token}` })
                    },
                    timeout: 900000 // 15 minutes timeout for AI requests
                  }
                );
                
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
              
              // Call the AI service endpoint
              const response = await axios.post(
                `${aiServiceUrl}/api/ai/chat`,
                {
                  project_id: projectId,
                  job_id: jobId,
                  input: params.input || params.messages, // Support both formats
                  messages: params.messages,
                  model: params.model || llmConfig.model || 'gpt-5-mini',
                  temperature: params.temperature,
                  max_tokens: params.max_tokens,
                  ...params
                },
                {
                  headers: {
                    'Content-Type': 'application/json',
                    ...(token && { 'Authorization': `Bearer ${token}` })
                  },
                  timeout: 900000 // 15 minutes timeout for AI requests
                }
              );
              
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
