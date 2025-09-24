#!/usr/bin/env node

/**
 * CLI for unified crawler
 * Usage: node cli.js <operation> <url> [mode] [options]
 */

import { attemptLogin, startCrawl } from './unified-operations.js';
import { validateUrl, validateMode } from './schemas/validation.js';

const args = process.argv.slice(2);

if (args.length < 2) {
  console.log(`
Unified Crawler CLI

Usage:
  node cli.js <operation> <url> [mode] [options]

Operations:
  login    - Attempt to login to a website
  crawl    - Crawl a website

Modes:
  auto     - AI-driven approach (default)
  media    - Screenshot analysis with AI
  text     - HTML text analysis with AI
  forms    - Form field analysis using Playwright
  static   - Standard field ID matching
  script   - Custom script execution

Examples:
  node cli.js login https://example.com/login auto
  node cli.js crawl https://example.com media
  node cli.js login https://example.com/login static
  node cli.js crawl https://example.com text

Environment Variables:
  OPENAI_API_KEY - Required for AI-powered modes
  `);
  process.exit(1);
}

const [operation, url, mode = 'auto', ...extraArgs] = args;

// Validate inputs
const urlValidation = validateUrl(url);
if (!urlValidation.valid) {
  console.error(`❌ Invalid URL: ${urlValidation.error}`);
  process.exit(1);
}

const modeValidation = validateMode(mode);
if (!modeValidation.valid) {
  console.error(`❌ Invalid mode: ${modeValidation.error}`);
  process.exit(1);
}

// Check for OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

// Create context
const context = {
  job_id: `cli_${Date.now()}`,
  project_id: 'cli-test',
  mode: mode,
  options: {
    headless: true,
    timeout: 30000,
    enable_screenshots: true,
    enable_video_recording: false
  },
  openai_api_key: process.env.OPENAI_API_KEY
};

async function runOperation() {
  console.log(`🚀 Starting ${operation} operation`);
  console.log(`📍 URL: ${url}`);
  console.log(`🎯 Mode: ${mode}`);
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Set' : 'Not set'}`);
  console.log('');

  try {
    let result;
    
    if (operation === 'login') {
      // For login, we need credentials
      const username = process.env.TEST_USERNAME || 'testuser';
      const password = process.env.TEST_PASSWORD || 'testpass';
      
      console.log(`👤 Username: ${username}`);
      console.log(`🔑 Password: ${'*'.repeat(password.length)}`);
      console.log('');
      
      result = await attemptLogin(url, username, password, [], context, process.env.OPENAI_API_KEY);
    } else if (operation === 'crawl') {
      result = await startCrawl(url, [], context, process.env.OPENAI_API_KEY);
    } else {
      console.error(`❌ Unknown operation: ${operation}`);
      process.exit(1);
    }

    console.log('');
    console.log('📊 Results:');
    console.log(`✅ Success: ${result.success}`);
    console.log(`📝 Message: ${result.message}`);
    console.log(`⏱️ Duration: ${result.duration_ms}ms`);
    
    if (result.finalUrl) {
      console.log(`🔗 Final URL: ${result.finalUrl}`);
    }
    
    if (result.finalTitle) {
      console.log(`📄 Final Title: ${result.finalTitle}`);
    }
    
    if (result.details) {
      console.log('📋 Details:');
      console.log(JSON.stringify(result.details, null, 2));
    }
    
    if (result.error) {
      console.log('❌ Error:');
      console.log(result.error);
    }

  } catch (error) {
    console.error('❌ Operation failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Operation cancelled by user');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Operation terminated');
  process.exit(0);
});

// Run the operation
runOperation().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
