#!/usr/bin/env node

/**
 * Generate CLI payload from backend request
 * Usage: node generate-payload.js <operation> <url> [options]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function generatePayload(operation, url, options = {}) {
  const basePayload = {
    operation,
    url,
    context: {
      mode: options.mode || 'auto',
      openai_api_key: process.env.OPENAI_API_KEY || 'your-openai-api-key-here',
      headless: options.headless !== undefined ? options.headless : false,
      timeout: options.timeout || 30000,
      // Always enable video and screenshots by default
      job_id: `generated-${Date.now()}`
    },
    options: {
      wait_for_navigation: true,
      screenshot_each_step: true,
      screenshot_before_action: true,
      screenshot_after_field: true,
      screenshot_on_success: true,
      screenshot_on_failure: true,
      ...options.cliOptions
    },
    description: `Generated payload for ${operation} operation on ${url}`
  };

  // Add operation-specific fields
  if (operation === 'login') {
    basePayload.username = options.username || process.env.TEST_USERNAME || 'testuser';
    basePayload.password = options.password || process.env.TEST_PASSWORD || 'testpass';
  }

  if (operation === 'crawl') {
    basePayload.context.max_pages = options.maxPages || 10;
    basePayload.context.max_depth = options.maxDepth || 3;
    basePayload.options.follow_links = true;
    basePayload.options.extract_forms = true;
    basePayload.options.extract_links = true;
  }

  return basePayload;
}

function savePayload(payload, filename) {
  const examplesDir = path.join(__dirname, '../cli-examples');
  const filePath = path.join(examplesDir, filename);
  
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  console.log(`✅ Generated payload saved to: ${filePath}`);
}

function showHelp() {
  console.log(`
Generate CLI Payload

Usage:
  node generate-payload.js <operation> <url> [options]

Operations:
  login     - Generate login payload
  crawl     - Generate crawl payload
  analysis  - Generate analysis payload

Options:
  --mode <mode>              - Operation mode (auto, media, text, forms, static, script)
  --headless                 - Run in headless mode
  --no-screenshots           - Disable screenshots
  --timeout <ms>             - Timeout in milliseconds
  --max-pages <number>       - Maximum pages to crawl
  --max-depth <number>       - Maximum crawl depth
  --username <username>      - Login username
  --password <password>      - Login password
  --output <filename>        - Output filename (default: auto-generated)

Examples:
  node generate-payload.js login https://example.com/login --username testuser --password testpass
  node generate-payload.js crawl https://example.com --max-pages 20 --headless
  node generate-payload.js analysis https://example.com --mode media --output custom-analysis.json
  `);
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2 || args.includes('--help')) {
  showHelp();
  process.exit(0);
}

const [operation, url, ...optionArgs] = args;

// Parse options
const options = {};
let outputFilename = null;

for (let i = 0; i < optionArgs.length; i++) {
  const arg = optionArgs[i];
  
  switch (arg) {
    case '--mode':
      options.mode = optionArgs[++i];
      break;
    case '--headless':
      options.headless = true;
      break;
    case '--no-screenshots':
      options.enableScreenshots = false;
      break;
    case '--timeout':
      options.timeout = parseInt(optionArgs[++i]);
      break;
    case '--max-pages':
      options.maxPages = parseInt(optionArgs[++i]);
      break;
    case '--max-depth':
      options.maxDepth = parseInt(optionArgs[++i]);
      break;
    case '--username':
      options.username = optionArgs[++i];
      break;
    case '--password':
      options.password = optionArgs[++i];
      break;
    case '--output':
      outputFilename = optionArgs[++i];
      break;
    default:
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
  }
}

// Generate filename if not provided
if (!outputFilename) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  outputFilename = `${operation}-${timestamp}.json`;
}

// Generate and save payload
const payload = generatePayload(operation, url, options);
savePayload(payload, outputFilename);

console.log(`\n📄 Generated payload for ${operation} operation:`);
console.log(`   URL: ${url}`);
console.log(`   Mode: ${payload.context.mode}`);
console.log(`   Headless: ${payload.context.headless}`);
console.log(`   Screenshots: ${payload.context.enable_screenshots}`);
console.log(`\n🚀 To test this payload, run:`);
console.log(`   node src/cli.js --file cli-examples/${outputFilename}`);
