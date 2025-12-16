/**
 * OpenAI Client Factory
 * Creates OpenAI client that uses configured endpoint (proxy) instead of direct OpenAI API
 */

import OpenAI from 'openai';
import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

/**
 * Create OpenAI client that uses configured endpoint
 * @param {Object} context - Job context containing llm_config, project_id, job_id
 * @param {string} fallbackApiKey - Fallback API key for backward compatibility
 * @returns {OpenAI} OpenAI client instance
 */
export function createOpenAIClient(context = {}, fallbackApiKey = null) {
  const llmConfig = context.llm_config || {};
  const projectId = context.project_id || context.projectId;
  const jobId = context.job_id || context.jobId;
  
  // Check if we should use the proxy endpoint
  const useProxy = llmConfig.endpoint && llmConfig.endpoint !== 'https://api.openai.com/v1';
  
  if (useProxy && projectId) {
    // Use proxy endpoint - create a custom client that proxies through backend
    console.log(`[OpenAI-Client] Using proxy endpoint: ${llmConfig.endpoint} for project ${projectId}${jobId ? ` (job: ${jobId})` : ''}`);
    
    // Create a custom OpenAI client that uses axios to call the proxy
    return new Proxy(new OpenAI({ apiKey: 'proxy' }), {
      get(target, prop) {
        if (prop === 'chat') {
          return {
            completions: {
              create: async (params) => {
                try {
                  // Call the proxy endpoint
                  const response = await axios.post(
                    llmConfig.endpoint,
                    {
                      project_id: projectId,
                      job_id: jobId, // Pass jobId for spending logs
                      messages: params.messages,
                      model: params.model || llmConfig.model || 'gpt-5-mini',
                      temperature: params.temperature,
                      max_tokens: params.max_tokens,
                      ...params
                    },
                    {
                      headers: {
                        'Content-Type': 'application/json'
                      },
                      timeout: 60000
                    }
                  );
                  
                  // Return in OpenAI format
                  return response.data;
                } catch (error) {
                  console.error(`[OpenAI-Client] Proxy request failed:`, error);
                  if (error.response) {
                    // Convert axios error to OpenAI-like error
                    const err = new Error(error.response.data?.error || error.message);
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
                // Call the proxy endpoint
                const response = await axios.post(
                  llmConfig.endpoint,
                  {
                    project_id: projectId,
                    job_id: jobId, // Pass jobId for spending logs
                    messages: params.messages,
                    model: params.model || llmConfig.model || 'gpt-5-mini',
                    temperature: params.temperature,
                    max_tokens: params.max_tokens,
                    ...params
                  },
                  {
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    timeout: 60000
                  }
                );
                
                // Return in OpenAI format
                return response.data;
              } catch (error) {
                console.error(`[OpenAI-Client] Proxy request failed:`, error);
                if (error.response) {
                  // Convert axios error to OpenAI-like error
                  const err = new Error(error.response.data?.error || error.message);
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
  } else {
    // Use direct OpenAI API (backward compatibility)
    const apiKey = fallbackApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key not provided and no proxy endpoint configured');
    }
    console.log(`[OpenAI-Client] Using direct OpenAI API`);
    return new OpenAI({ apiKey });
  }
}

