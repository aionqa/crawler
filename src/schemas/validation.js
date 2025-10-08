/**
 * Validation schemas for unified crawler
 */

import { z } from 'zod';

// Common schemas
const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional()
});

const CredentialsSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required')
});

const OptionsSchema = z.object({
  headless: z.boolean().default(true),
  timeout: z.number().min(1000).max(300000).default(30000),
  max_retries: z.number().min(1).max(10).default(2),
  enable_screenshots: z.boolean().default(true),
  enable_video_recording: z.boolean().default(true), // Mandatory per rule 38-video-recording-mandatory.mdc
  max_pages: z.number().min(1).max(1000).default(100),
  max_depth: z.number().min(0).max(10).default(3) // Changed min from 1 to 0 to allow single-page analysis
});

const ContextSchema = z.object({
  project_id: z.string().optional(), // No longer required - crawler doesn't need to know about projects
  configuration_id: z.string().optional(),
  job_id: z.string().optional(),
  credentials: CredentialsSchema.optional(),
  options: OptionsSchema.optional(),
  mode: z.enum(['auto', 'media', 'text', 'forms', 'static', 'script']).default('auto'),
  script: z.string().optional(),
  task: z.string().optional(),
  openai_api_key: z.string().optional()
});

// Request schemas
const LoginRequestSchema = z.object({
  url: z.string().url('Invalid URL format'),
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  cookies: z.array(CookieSchema).default([]),
  context: ContextSchema
});

const CrawlRequestSchema = z.object({
  url: z.string().url('Invalid URL format'),
  cookies: z.array(CookieSchema).default([]),
  context: ContextSchema
});

const QueueLoginJobSchema = z.object({
  url: z.string().url('Invalid URL format'),
  context: ContextSchema
});

const GetJobStatusSchema = z.object({
  job_id: z.string().min(1, 'Job ID is required')
});

// Validation functions
export function validateInput(request) {
  const { jsonrpc, method, params, id } = request;
  
  // Validate JSON-RPC format
  if (jsonrpc !== '2.0') {
    return {
      valid: false,
      errors: ['Invalid JSON-RPC version. Must be "2.0"']
    };
  }
  
  if (!method) {
    return {
      valid: false,
      errors: ['Method is required']
    };
  }
  
  if (!params) {
    return {
      valid: false,
      errors: ['Params are required']
    };
  }
  
  // Validate method-specific parameters
  let schema;
  switch (method) {
    case 'attemptLogin':
      schema = LoginRequestSchema;
      break;
    case 'startCrawl':
      schema = CrawlRequestSchema;
      break;
    case 'queueLoginJob':
      schema = QueueLoginJobSchema;
      break;
    case 'getJobStatus':
      schema = GetJobStatusSchema;
      break;
    default:
      return {
        valid: false,
        errors: [`Unknown method: ${method}`]
      };
  }
  
  try {
    const validatedData = schema.parse(params);
    return {
      valid: true,
      data: { jsonrpc, method, params: validatedData, id }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      };
    }
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    };
  }
}

export function createValidationErrorResponse(errors, id = null) {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32602,
      message: "Invalid params",
      data: {
        errors,
        timestamp: new Date().toISOString()
      }
    },
    id
  };
}

// Individual validation functions
export function validateUrl(url) {
  try {
    new URL(url);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

export function validateMode(mode) {
  const validModes = ['auto', 'media', 'text', 'forms', 'static', 'script'];
  if (validModes.includes(mode)) {
    return { valid: true };
  }
  return { 
    valid: false, 
    error: `Invalid mode. Must be one of: ${validModes.join(', ')}` 
  };
}

export function validateCredentials(credentials) {
  try {
    CredentialsSchema.parse(credentials);
    return { valid: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      };
    }
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    };
  }
}

export function validateOptions(options) {
  try {
    OptionsSchema.parse(options);
    return { valid: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      };
    }
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    };
  }
}

export function validateContext(context) {
  try {
    ContextSchema.parse(context);
    return { valid: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      };
    }
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    };
  }
}

// Export schemas for external use
export {
  CookieSchema,
  CredentialsSchema,
  OptionsSchema,
  ContextSchema,
  LoginRequestSchema,
  CrawlRequestSchema,
  QueueLoginJobSchema,
  GetJobStatusSchema
};
