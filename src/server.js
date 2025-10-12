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
import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import path from 'path';
import * as backendLogger from './backend-logger.js';

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = 'unified-crawler';

// Job management
const activeJobs = new Map();
const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

// Swagger configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "AionQA Unified Crawler API",
      version: "1.0.0",
      description: "Unified AI-powered web crawling and login automation system. Supports multiple modes: auto, media, text, forms, static, script. Uses JSON-RPC 2.0 protocol.",
      contact: {
        name: "AionQA Team",
        email: "support@aionqa.com"
      },
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT"
      }
    },
    servers: [
      { 
        url: `http://localhost:${PORT}`, 
        description: "Development server" 
      },
      { 
        url: "http://unified-crawler:3005", 
        description: "Docker container server" 
      }
    ],
    tags: [
      {
        name: "Health",
        description: "Health check endpoints"
      },
      {
        name: "JSON-RPC",
        description: "JSON-RPC 2.0 endpoints for crawler operations"
      }
    ]
  },
  apis: [path.join(__dirname, "server.js")],
});

// Helper function to send logs to backend using structured logging endpoints
async function sendLogToBackend(jobId, level, message, data = {}) {
  try {
    const mode = data.mode || 'auto';
    const componentMode = mode === 'auto' ? 'text' : mode;
    const componentName = `CRAWLER-${componentMode.toUpperCase()}`;
    
    // Use structured logging based on presence of page_url
    const pageUrl = data.page_url || data.pageUrl;
    
    if (pageUrl) {
      // Page-level log
      await backendLogger.appendPageLog(
        jobId,
        pageUrl,
        level,
        message,
        null, // pageLogId - will be created if needed
        componentName,
        data
      );
    } else {
      // Job-level log
      await backendLogger.appendJobLog(
        jobId,
        level,
        message,
        componentName,
        data
      );
    }
  } catch (error) {
    console.error(`❌ Error sending log to backend:`, error);
  }
}

// Helper function to update job status
function updateJobStatus(jobId, status, result = null, error = null) {
  const job = activeJobs.get(jobId);
  if (job) {
    const now = new Date();
    const startTime = job.start_time || job.created_at;
    const duration = now.getTime() - startTime.getTime();
    const minimumDuration = 60000; // 1 minute minimum
    
    console.log(`[UNIFIED-CRAWLER] Job ${jobId} duration: ${duration}ms, minimum required: ${minimumDuration}ms`);
    
    // If trying to mark as completed but duration is too short, mark as failed instead
    if (status === 'completed' && duration < minimumDuration) {
      console.log(`[UNIFIED-CRAWLER] Job ${jobId} completed too quickly (${duration}ms), marking as failed`);
      status = 'failed';
      error = error || `Job completed too quickly (${duration}ms) - likely didn't perform real crawling work`;
    }
    
    job.status = status;
    job.updated_at = now;
    if (result) job.result = result;
    if (error) job.error = error;
    activeJobs.set(jobId, job);
  }
}

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Swagger UI routes
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the health status of the unified crawler service
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: healthy
 *                 service:
 *                   type: string
 *                   example: unified-crawler
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 supported_modes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: [auto, media, text, forms, static, script]
 *                 operations:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: [login, crawl]
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: SERVICE_NAME, 
    timestamp: new Date().toISOString(),
    supported_modes: ['auto', 'media', 'text', 'forms', 'static', 'script'],
    operations: ['login', 'crawl']
  });
});

/**
 * @swagger
 * components:
 *   schemas:
 *     JSONRPCRequest:
 *       type: object
 *       required:
 *         - jsonrpc
 *         - method
 *         - id
 *       properties:
 *         jsonrpc:
 *           type: string
 *           example: "2.0"
 *         method:
 *           type: string
 *           enum: [queueLoginJob, getJobStatus, attemptLogin, startCrawl]
 *           example: "attemptLogin"
 *         params:
 *           type: object
 *         id:
 *           type: string
 *           example: "1"
 *     JSONRPCResponse:
 *       type: object
 *       required:
 *         - jsonrpc
 *         - id
 *       properties:
 *         jsonrpc:
 *           type: string
 *           example: "2.0"
 *         result:
 *           type: object
 *         error:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             message:
 *               type: string
 *         id:
 *           type: string
 *           example: "1"
 *     LoginParams:
 *       type: object
 *       required:
 *         - url
 *         - username
 *         - password
 *       properties:
 *         url:
 *           type: string
 *           format: uri
 *           example: "https://example.com/login"
 *         username:
 *           type: string
 *           example: "user@example.com"
 *         password:
 *           type: string
 *           example: "password123"
 *         context:
 *           type: object
 *           properties:
 *             mode:
 *               type: string
 *               enum: [auto, media, text, forms, static, script]
 *               example: "auto"
 *             cookies:
 *               type: array
 *               items:
 *                 type: object
 *             openai_api_key:
 *               type: string
 *     CrawlParams:
 *       type: object
 *       required:
 *         - url
 *       properties:
 *         url:
 *           type: string
 *           format: uri
 *           example: "https://example.com"
 *         cookies:
 *           type: array
 *           items:
 *             type: object
 *         context:
 *           type: object
 *           properties:
 *             job_id:
 *               type: string
 *               example: "job-uuid-here"
 *             mode:
 *               type: string
 *               enum: [auto, media, text, forms, static, script]
 *               example: "auto"
 *             openai_api_key:
 *               type: string
 * /rpc:
 *   post:
 *     summary: JSON-RPC 2.0 endpoint
 *     description: Main JSON-RPC endpoint for all crawler operations including login, crawl, and job management
 *     tags: [JSON-RPC]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/JSONRPCRequest'
 *           examples:
 *             attemptLogin:
 *               summary: Login operation
 *               value:
 *                 jsonrpc: "2.0"
 *                 method: "attemptLogin"
 *                 params:
 *                   url: "https://example.com/login"
 *                   username: "user@example.com"
 *                   password: "password123"
 *                   context:
 *                     mode: "auto"
 *                     openai_api_key: "your-openai-key"
 *                 id: "1"
 *             startCrawl:
 *               summary: Crawl operation
 *               value:
 *                 jsonrpc: "2.0"
 *                 method: "startCrawl"
 *                 params:
 *                   url: "https://example.com"
 *                   context:
 *                     job_id: "job-uuid-here"
 *                     mode: "auto"
 *                     openai_api_key: "your-openai-key"
 *                 id: "1"
 *             queueLoginJob:
 *               summary: Queue login job
 *               value:
 *                 jsonrpc: "2.0"
 *                 method: "queueLoginJob"
 *                 params:
 *                   url: "https://example.com/login"
 *                   context:
 *                     credentials:
 *                       username: "user@example.com"
 *                       password: "password123"
 *                     mode: "auto"
 *                     openai_api_key: "your-openai-key"
 *                 id: "1"
 *             getJobStatus:
 *               summary: Get job status
 *               value:
 *                 jsonrpc: "2.0"
 *                 method: "getJobStatus"
 *                 params:
 *                   job_id: "job-uuid-here"
 *                 id: "1"
 *     responses:
 *       200:
 *         description: JSON-RPC response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/JSONRPCResponse'
 *             examples:
 *               success:
 *                 summary: Successful operation
 *                 value:
 *                   jsonrpc: "2.0"
 *                   result:
 *                     success: true
 *                     message: "Login completed successfully"
 *                     duration_ms: 5000
 *                     final_url: "https://example.com/dashboard"
 *                     final_title: "Dashboard"
 *                     cookies: []
 *                     details: {}
 *                     logs: []
 *                     screenshots: []
 *                     video: null
 *                   id: "1"
 *               error:
 *                 summary: Error response
 *                 value:
 *                   jsonrpc: "2.0"
 *                   error:
 *                     code: -32601
 *                     message: "Method not found"
 *                   id: "1"
 */
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
        useRemoteBrowser: true, // Use remote browser service
        browserServiceUrl: process.env.BROWSER_SERVICE_URL || 'http://browser-1:3000'
      },
      openaiApiKey
    );
    
    console.log(`[SERVER] ✅ Login attempt completed. Success: ${result.success}`);
    
    // Return standardized response
    const response = createSuccessResponse({
      success: result.success,
      approach: result.approach || 'unknown', // Include the winning approach!
      message: result.message,
      duration_ms: result.duration_ms,
      final_url: result.finalUrl,
      final_title: result.finalTitle,
      cookies: result.cookies || [],
      details: result.details || {},
      logs: result.logs || [],
      screenshots: result.screenshots || [],
      video: result.video || null,
      loginValidation: result.loginValidation || null,
      loginConfirmed: result.loginConfirmed || false
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
    
    // project_id is no longer required - crawler doesn't need to know about projects

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
    console.log(`[SERVER] 🎯 Context.options:`, JSON.stringify(params.context?.options || null));
    console.log(`[SERVER] 🎯 Max Depth from context:`, params.context?.options?.max_depth);
    console.log(`[SERVER] 🎯 Max Pages from context:`, params.context?.options?.max_pages);

    // Send debug info to job logs if job_id is available
    if (params.context?.job_id) {
      await sendLogToBackend(params.context.job_id, 'info', `🔧 DEBUG: Received max_depth=${params.context?.options?.max_depth}, max_pages=${params.context?.options?.max_pages}`);
    }

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
        useRemoteBrowser: true, // Use remote browser service
        browserServiceUrl: process.env.BROWSER_SERVICE_URL || 'http://browser-1:3000',
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
