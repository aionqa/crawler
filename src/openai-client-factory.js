/**
 * OpenAI Client Factory
 * Creates OpenAI client that uses AionQA AI Service instead of direct OpenAI API
 */

import OpenAI from 'openai';
import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://aionqa-ai-service:5000';
// CRITICAL: Use RUNNER_TOKEN for AI service authentication (not AI_SERVICE_TOKEN for security)
// Helper provides RUNNER_TOKEN to crawler containers, AI service accepts it as alternative auth
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
  
  // Determine AI service URL - priority: llm_config.endpoint > AI_SERVICE_URL > default
  const aiServiceUrl = llmConfig.endpoint || AI_SERVICE_URL;
  
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
                      ...(AI_SERVICE_TOKEN && { 'Authorization': `Bearer ${AI_SERVICE_TOKEN}` })
                    },
                    timeout: 300000 // 5 minutes timeout for AI requests
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
                    'Content-Type': 'application/json'
                  },
                  timeout: 300000 // 5 minutes timeout for AI requests
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
