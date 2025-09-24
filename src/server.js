/**
 * Unified Crawler - AI-powered web crawling and login automation
 * Supports multiple modes: auto, media, text, forms, static, script
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { randomUUID } from 'crypto';
import { createSuccessResponse, createErrorResponse } from './utils.js';
import { attemptLogin, startCrawl } from './unified-operations.js';
import { validateInput, createValidationErrorResponse } from './schemas/validation.js';
import gelfClient from '/app/shared/gelf-client.js';

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = 'unified-crawler';

// Job management
const activeJobs = new Map();
const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

// Helper function to send logs to backend
async function sendLogToBackend(jobId, level, message, data = {}) {
  try {
    const timestamp = new Date().toISOString();
    const response = await fetch(`${BACKEND_URL}/jobs/${jobId}/logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        level,
        message,
        data: {
          ...data,
          timestamp
        },
        agent_name: SERVICE_NAME
      })
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to send log to backend: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`❌ Error sending log to backend:`, error);
  }
}

// Helper function to update job status
function updateJobStatus(jobId, status, result = null, error = null) {
  const job = activeJobs.get(jobId);
  if (job) {
    job.status = status;
    job.updated_at = new Date();
    if (result) job.result = result;
    if (error) job.error = error;
    activeJobs.set(jobId, job);
  }
}

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: SERVICE_NAME, 
    timestamp: new Date().toISOString(),
    supported_modes: ['auto', 'media', 'text', 'forms', 'static', 'script'],
    operations: ['login', 'crawl']
  });
});

// JSON-RPC endpoint
app.post('/rpc', async (req, res) => {
  console.log('[SERVER] 📥 Received JSON-RPC request');
  
  try {
    const requestBody = req.body;
    const { jsonrpc, method, params, id } = requestBody;
    
    console.log(`[SERVER] 🎯 Method: ${method}`);
    
    // Handle different methods
    switch (method) {
      case 'queueLoginJob':
        return await handleQueueLoginJob(req, res, params, id);
      
      case 'getJobStatus':
        return await handleGetJobStatus(req, res, params, id);
      
      case 'attemptLogin':
        return await handleAttemptLogin(req, res, params, id);
      
      case 'startCrawl':
        return await handleStartCrawl(req, res, params, id);
      
      default:
        return res.json(createErrorResponse({
          code: -32601,
          message: `Method not found: ${method}`
        }, id));
    }
    
  } catch (error) {
    console.error('[SERVER] ❌ Error processing request:', error);
    
    const errorResponse = createErrorResponse({
      message: `Server error: ${error.message}`,
      details: {
        stack: error.stack,
        timestamp: new Date().toISOString()
      }
    });
    
    res.json(errorResponse);
  }
});

// Handle queueLoginJob method
async function handleQueueLoginJob(req, res, params, id) {
  try {
    const jobId = randomUUID();
    const { url, context } = params;
    
    console.log(`[SERVER] 🚀 Queuing login job ${jobId} for: ${url}`);
    console.log(`[SERVER] 🎯 Mode: ${context?.mode || 'auto'}`);
    
    // Create job record
    const job = {
      id: jobId,
      status: 'queued',
      created_at: new Date(),
      updated_at: new Date(),
      url,
      context,
      result: null,
      error: null
    };
    
    activeJobs.set(jobId, job);
    
    // Start job execution in background
    executeLoginJob(jobId).catch(error => {
      console.error(`❌ Job ${jobId} failed:`, error);
      updateJobStatus(jobId, 'failed', null, error.message);
    });
    
    // Return job queued response
    res.json({
      jsonrpc: "2.0",
      result: {
        job_id: jobId,
        status: 'queued',
        message: 'Login job queued successfully'
      },
      id
    });
    
  } catch (error) {
    console.error('[SERVER] ❌ Error queuing login job:', error);
    res.json(createErrorResponse({
      message: `Failed to queue login job: ${error.message}`
    }, id));
  }
}

// Handle getJobStatus method
async function handleGetJobStatus(req, res, params, id) {
  try {
    const { job_id } = params;
    const job = activeJobs.get(job_id);
    
    if (!job) {
      return res.json(createErrorResponse({
        code: -32602,
        message: `Job not found: ${job_id}`
      }, id));
    }
    
    res.json({
      jsonrpc: "2.0",
      result: {
        job_id,
        status: job.status,
        progress: job.status === 'running' ? 50 : (job.status === 'completed' ? 100 : 0),
        message: `Job is ${job.status}`,
        result: job.result,
        error: job.error
      },
      id
    });
    
  } catch (error) {
    console.error('[SERVER] ❌ Error getting job status:', error);
    res.json(createErrorResponse({
      message: `Failed to get job status: ${error.message}`
    }, id));
  }
}

// Handle attemptLogin method (legacy)
async function handleAttemptLogin(req, res, params, id) {
  try {
    // Validate input using schema
    const validation = validateInput({ jsonrpc: "2.0", method: "attemptLogin", params, id });
    if (!validation.valid) {
      console.log('[SERVER] ❌ Input validation failed:', validation.errors);
      return res.json(createValidationErrorResponse(validation.errors, id));
    }
    
    const { url, username, password } = validation.data.params;
    
    console.log(`[SERVER] 🎯 Processing login request for: ${url}`);
    console.log(`[SERVER] 👤 Username: ${username}`);
    console.log(`[SERVER] 🔑 Password: ${password ? '*'.repeat(password.length) : 'Not provided'}`);
    console.log(`[SERVER] 🍪 Cookies: ${params.context?.cookies?.length || 0} provided`);
    console.log(`[SERVER] 🎯 Task: ${params.context?.task || 'Automated login'}`);
    console.log(`[SERVER] 🎯 Mode: ${params.context?.mode || 'auto'}`);
    
    // Extract OpenAI API key from request or environment
    const openaiApiKey = params.context?.openai_api_key || process.env.OPENAI_API_KEY;
    
    if (!openaiApiKey) {
      return res.json(createErrorResponse({
        message: "OpenAI API key is required. Provide it in context.openai_api_key or set OPENAI_API_KEY environment variable"
      }, id));
    }
    
    // Execute login attempt
    const result = await attemptLogin(
      url,
      username,
      password,
      params.context?.cookies || [],
      {
        ...params.context,
        useRemoteBrowser: false, // Force local browser
        browserServiceUrl: null
      },
      openaiApiKey
    );
    
    console.log(`[SERVER] ✅ Login attempt completed. Success: ${result.success}`);
    
    // Return standardized response
    const response = createSuccessResponse({
      success: result.success,
      message: result.message,
      duration_ms: result.duration_ms,
      final_url: result.finalUrl,
      final_title: result.finalTitle,
      cookies: result.cookies || [],
      details: result.details || {},
      logs: result.logs || [],
      screenshots: result.screenshots || [],
      video: result.video || null
    }, id);
    
    res.json(response);
    
  } catch (error) {
    console.error('[SERVER] ❌ Error processing login attempt:', error);
    res.json(createErrorResponse({
      message: `Server error: ${error.message}`,
      details: {
        stack: error.stack,
        timestamp: new Date().toISOString()
      }
    }, id));
  }
}

// Handle startCrawl method
async function handleStartCrawl(req, res, params, id) {
  try {
    // Validate required parameters
    if (!params?.url) {
      return res.json({ 
        jsonrpc: '2.0', 
        id, 
        error: { code: -32602, message: 'Missing required parameter: url' } 
      });
    }
    
    if (!params?.context?.project_id) {
      return res.json({ 
        jsonrpc: '2.0', 
        id, 
        error: { code: -32602, message: 'Missing required parameter: context.project_id' } 
      });
    }

    // Initialize OpenAI with API key from context or environment
    const openaiApiKey = params.context.openai_api_key || process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return res.json({ 
        jsonrpc: '2.0', 
        id, 
        error: { code: -32602, message: 'OpenAI API key not provided in context or environment' } 
      });
    }

    console.log(`[SERVER] 🎯 Processing crawl request for: ${params.url}`);
    console.log(`[SERVER] 🎯 Mode: ${params.context?.mode || 'auto'}`);

    const result = await startCrawl(params.url, params.cookies || [], params.context, openaiApiKey);
    
    res.json({ jsonrpc: '2.0', id, result });
    
  } catch (error) {
    console.error('[SERVER] ❌ Error processing crawl request:', error);
    res.json({ 
      jsonrpc: '2.0', 
      id, 
      error: { code: -32603, message: error.message } 
    });
  }
}

// Execute login job in background
async function executeLoginJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  
  let logInterval;
  
  try {
    updateJobStatus(jobId, 'running');
    await sendLogToBackend(jobId, 'info', 'Starting login job execution');
    
    // Start periodic logging (every 5 seconds)
    logInterval = setInterval(async () => {
      const jobStatus = activeJobs.get(jobId);
      if (jobStatus && jobStatus.status === 'running') {
        await sendLogToBackend(jobId, 'info', `Login job ${jobId} is still running...`);
      }
    }, 5000);
    
    const { url, context } = job;
    const { credentials, options = {} } = context;
    
    // Extract OpenAI API key
    const openaiApiKey = context.openai_api_key || process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error('OpenAI API key is required');
    }
    
    await sendLogToBackend(jobId, 'info', `Attempting login for: ${url} with mode: ${context.mode || 'auto'}`);
    
    // Execute login attempt
    const result = await attemptLogin(
      url,
      credentials?.username,
      credentials?.password,
      context.cookies || [],
      {
        ...context,
        useRemoteBrowser: false, // Force local browser
        browserServiceUrl: null,
        ...options
      },
      openaiApiKey
    );
    
    await sendLogToBackend(jobId, 'info', `Login attempt completed. Success: ${result.success}`);
    
    // Update job with result
    const jobResult = {
      success: result.success,
      message: result.message,
      duration_ms: result.duration_ms,
      final_url: result.finalUrl,
      final_title: result.finalTitle,
      cookies: result.cookies || [],
      details: result.details || {},
      logs: result.logs || [],
      screenshots: result.screenshots || [],
      video: result.video || null
    };
    
    updateJobStatus(jobId, 'completed', jobResult);
    await sendLogToBackend(jobId, 'info', 'Login job completed successfully');
    
  } catch (error) {
    console.error(`❌ Job ${jobId} execution failed:`, error);
    updateJobStatus(jobId, 'failed', null, error.message);
    await sendLogToBackend(jobId, 'error', `Login job failed: ${error.message}`);
  } finally {
    // Clear the log interval
    if (logInterval) {
      clearInterval(logInterval);
    }
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`[SERVER] 🚀 Unified Crawler running on port ${PORT}`);
  console.log(`[SERVER] 📡 JSON-RPC endpoint: http://localhost:${PORT}/rpc`);
  console.log(`[SERVER] 🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`[SERVER] 🎯 Supported modes: auto, media, text, forms, static, script`);
});

export default app;
