#!/usr/bin/env node

/**
 * CLI for unified crawler
 * Usage: 
 *   node cli.js <operation> <url> [mode] [options]
 *   node cli.js --file <json-file>
 *   node cli.js --list-examples
 */

import { attemptLogin, startCrawl } from './unified-operations.js';
import { validateUrl, validateMode } from './schemas/validation.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI Logger for stdout output
class CLILogger {
  constructor() {
    this.startTime = Date.now();
  }

  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const elapsed = Date.now() - this.startTime;
    
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      elapsed_ms: elapsed,
      ...data
    };
    
    // Output to stdout in JSON format for easy parsing
    console.log(JSON.stringify(logEntry));
  }

  info(message, data = {}) {
    this.log('info', message, data);
  }

  error(message, data = {}) {
    this.log('error', message, data);
  }

  warn(message, data = {}) {
    this.log('warn', message, data);
  }

  debug(message, data = {}) {
    this.log('debug', message, data);
  }
}

const logger = new CLILogger();

// Set CLI mode environment variable
process.env.CLI_MODE = 'true';

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
Unified Crawler CLI

Usage:
  node cli.js <operation> <url> [mode] [options]
  node cli.js --file <json-file>
  node cli.js --list-examples
  node cli.js --help

Operations:
  login     - Attempt to login to a website
  crawl     - Crawl a website
  analysis  - Analyze page structure and content

Modes:
  auto      - AI-driven approach (default)
  media     - Screenshot analysis with AI
  text      - HTML text analysis with AI
  forms     - Form field analysis using Playwright
  static    - Standard field ID matching
  script    - Custom script execution

Examples:
  node cli.js login https://example.com/login auto
  node cli.js crawl https://example.com media
  node cli.js --file cli-examples/login-example.json
  node cli.js --list-examples

Environment Variables:
  OPENAI_API_KEY - Required for AI-powered modes
  TEST_USERNAME  - Username for login testing (optional)
  TEST_PASSWORD  - Password for login testing (optional)
  `);
}

function listExamples() {
  const examplesDir = path.join(__dirname, '../cli-examples');
  
  if (!fs.existsSync(examplesDir)) {
    logger.error('Examples directory not found', { path: examplesDir });
    return;
  }

  const files = fs.readdirSync(examplesDir).filter(f => f.endsWith('.json'));
  
  logger.info('Available example files:', { count: files.length });
  
  files.forEach(file => {
    const filePath = path.join(examplesDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    logger.info(`📄 ${file}`, { 
      operation: content.operation,
      url: content.url,
      description: content.description || 'No description'
    });
  });
}

function loadPayloadFromFile(filePath) {
  try {
    const fullPath = path.resolve(filePath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const payload = JSON.parse(content);
    
    logger.info('Loaded payload from file', { 
      file: fullPath,
      operation: payload.operation,
      url: payload.url
    });
    
    return payload;
  } catch (error) {
    logger.error('Failed to load payload file', { 
      file: filePath,
      error: error.message 
    });
    process.exit(1);
  }
}

function validatePayload(payload) {
  const required = ['operation', 'url'];
  const missing = required.filter(field => !payload[field]);
  
  if (missing.length > 0) {
    logger.error('Missing required fields in payload', { missing });
    process.exit(1);
  }

  // Validate URL
  const urlValidation = validateUrl(payload.url);
  if (!urlValidation.valid) {
    logger.error('Invalid URL in payload', { 
      url: payload.url,
      error: urlValidation.error 
    });
    process.exit(1);
  }

  // Validate mode if provided
  if (payload.context?.mode) {
    const modeValidation = validateMode(payload.context.mode);
    if (!modeValidation.valid) {
      logger.error('Invalid mode in payload', { 
        mode: payload.context.mode,
        error: modeValidation.error 
      });
      process.exit(1);
    }
  }
}

async function runOperation(payload) {
  const { operation, url, context = {}, options = {} } = payload;
  
  // Merge context with defaults - no project_id needed
  const fullContext = {
    job_id: context.job_id || `cli_${Date.now()}`,
    mode: context.mode || 'auto',
    options: {
      headless: context.headless !== undefined ? context.headless : false, // CLI mode shows browser by default
      timeout: context.timeout || 30000,
      // Always enable video and screenshots by default
      enable_screenshots: true,
      enable_video_recording: true,
      useLocalBrowser: true, // Force local browser for CLI
      ...options
    },
    openai_api_key: context.openai_api_key || process.env.OPENAI_API_KEY
  };

  logger.info('Starting operation', {
    operation,
    url,
    mode: fullContext.mode,
    headless: fullContext.options.headless,
    hasOpenAIKey: !!fullContext.openai_api_key
  });

  try {
    let result;
    
    if (operation === 'login') {
      const username = payload.username || process.env.TEST_USERNAME || 'testuser';
      const password = payload.password || process.env.TEST_PASSWORD || 'testpass';
      
      logger.info('Login credentials', {
        username,
        passwordLength: password.length
      });
      
      result = await attemptLogin(url, username, password, [], fullContext, fullContext.openai_api_key);
    } else if (operation === 'crawl') {
      result = await startCrawl(url, [], fullContext, fullContext.openai_api_key);
    } else if (operation === 'analysis') {
      // For now, treat analysis as a crawl operation
      logger.info('Analysis operation - treating as crawl');
      result = await startCrawl(url, [], fullContext, fullContext.openai_api_key);
    } else {
      logger.error('Unknown operation', { operation });
      process.exit(1);
    }

    logger.info('Operation completed', {
      success: result.success,
      message: result.message,
      duration_ms: result.duration_ms,
      finalUrl: result.finalUrl,
      finalTitle: result.finalTitle
    });
    
    if (result.details) {
      logger.info('Operation details', result.details);
    }
    
    if (result.error) {
      logger.error('Operation error', { error: result.error });
    }

    if (result.logs && result.logs.length > 0) {
      logger.info('Operation logs', { logCount: result.logs.length });
      result.logs.forEach(log => {
        logger.log(log.level || 'info', log.message, log.data || {});
      });
    }

  } catch (error) {
    logger.error('Operation failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Parse command line arguments
if (args.length === 0 || args.includes('--help')) {
  showHelp();
  process.exit(0);
}

if (args.includes('--list-examples')) {
  listExamples();
  process.exit(0);
}

// Check for file input
const fileIndex = args.indexOf('--file');
if (fileIndex !== -1 && args[fileIndex + 1]) {
  const filePath = args[fileIndex + 1];
  const payload = loadPayloadFromFile(filePath);
  validatePayload(payload);
  
  // Check for OpenAI API key
  if (!payload.context?.openai_api_key && !process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }
  
  runOperation(payload);
} else if (args.length >= 2) {
  // Legacy command line interface
  const [operation, url, mode = 'auto', ...extraArgs] = args;

  // Validate inputs
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.error('Invalid URL', { url, error: urlValidation.error });
    process.exit(1);
  }

  const modeValidation = validateMode(mode);
  if (!modeValidation.valid) {
    logger.error('Invalid mode', { mode, error: modeValidation.error });
    process.exit(1);
  }

  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  // Create payload from command line args
  const payload = {
    operation,
    url,
    context: {
      mode,
      openai_api_key: process.env.OPENAI_API_KEY
    }
  };

  runOperation(payload);
} else {
  logger.error('Invalid arguments', { args });
  showHelp();
  process.exit(1);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Operation cancelled by user');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Operation terminated');
  process.exit(0);
});