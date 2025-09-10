import { z } from 'zod';

// Common schemas
export const CredentialsSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required')
});

export const OptionsSchema = z.object({
  headless: z.boolean().default(true),
  timeout: z.number().default(30000),
  maxWaitMsPerAction: z.number().default(30000),
  maxRetries: z.number().default(2)
});

export const AIContextSchema = z.object({
  project_id: z.string().min(1, 'Project ID is required'),
  configuration_id: z.string().optional()
});

export const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional()
});

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.object({}).optional()
});

// Login agent schemas
export const LoginRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('attemptLogin'),
  params: z.object({
    url: z.string().url('Invalid URL'),
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
    headless: z.boolean().default(true),
    timeout: z.number().default(30000)
  }),
  id: z.number()
});

export const LoginResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.object({
    success: z.boolean(),
    cookies: z.array(CookieSchema).default([]),
    screenshot: z.string().optional(),
    pageContent: z.string().optional(),
    redirectUrl: z.string().optional(),
    error: z.string().optional()
  }),
  id: z.number()
});

export const LoginErrorResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  error: ErrorSchema,
  id: z.number()
});

// Backend to login agent request schema
export const BackendLoginRequestSchema = z.object({
  module_name: z.enum(['simplified', 'text', 'media', 'static']),
  target_url: z.string().url('Invalid URL'),
  credentials: CredentialsSchema,
  options: OptionsSchema,
  ai_context: AIContextSchema
});

export const BackendLoginResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({}).optional(),
  module: z.string(),
  containerName: z.string(),
  port: z.number()
});

// Crawler agent schemas
export const CrawlerRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('startCrawl'),
  params: z.object({
    startUrl: z.string().url('Invalid URL'),
    maxPages: z.number().default(100),
    maxDepth: z.number().default(3),
    headless: z.boolean().default(true),
    timeout: z.number().default(30000),
    cookies: z.array(CookieSchema).default([]),
    analysisSettings: z.object({
      takeScreenshots: z.boolean().default(true),
      extractText: z.boolean().default(true),
      extractLinks: z.boolean().default(true),
      extractForms: z.boolean().default(true),
      aiAnalysis: z.boolean().default(true)
    }).optional()
  }),
  id: z.number()
});

export const CrawlerResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.object({
    success: z.boolean(),
    pages: z.array(z.object({
      url: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      screenshot: z.string().optional(),
      links: z.array(z.string()).default([]),
      forms: z.array(z.object({})).default([]),
      aiAnalysis: z.object({}).optional()
    })).default([]),
    error: z.string().optional()
  }),
  id: z.number()
});

// Backend to crawler agent request schema
export const BackendCrawlerRequestSchema = z.object({
  module_name: z.enum(['simplified', 'text', 'media', 'static']),
  start_url: z.string().url('Invalid URL'),
  max_pages: z.number().default(100),
  max_depth: z.number().default(3),
  options: OptionsSchema,
  cookies: z.array(CookieSchema).default([]),
  ai_context: AIContextSchema
});

export const BackendCrawlerResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({}).optional(),
  module: z.string(),
  containerName: z.string(),
  port: z.number()
});

// Validation functions
export function validateLoginRequest(data) {
  return LoginRequestSchema.parse(data);
}

export function validateLoginResponse(data) {
  return LoginResponseSchema.parse(data);
}

export function validateBackendLoginRequest(data) {
  return BackendLoginRequestSchema.parse(data);
}

export function validateBackendLoginResponse(data) {
  return BackendLoginResponseSchema.parse(data);
}

export function validateCrawlerRequest(data) {
  return CrawlerRequestSchema.parse(data);
}

export function validateCrawlerResponse(data) {
  return CrawlerResponseSchema.parse(data);
}

export function validateBackendCrawlerRequest(data) {
  return BackendCrawlerRequestSchema.parse(data);
}

export function validateBackendCrawlerResponse(data) {
  return BackendCrawlerResponseSchema.parse(data);
}
