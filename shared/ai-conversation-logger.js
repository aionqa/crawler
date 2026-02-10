/**
 * AI Conversation Logger for AionQA Agents
 * 
 * This module provides a standardized way for all agents (crawlers and login agents)
 * to log AI conversations to the backend for the ChatMode feature.
 */

import { StructuredAIResponse } from './structured-ai-response.js';
import OpenAI from 'openai';
import { chromium } from 'playwright';
import axios from 'axios';
import { createOpenAIClient } from '../src/openai-client-factory.js';

/**
 * Extract the first complete JSON object or array from a string that may contain
 * markdown, IIFEs, or other wrapper text (e.g. LM Studio output).
 * Uses balanced-brace matching so trailing junk like "}; })();" is not included.
 * @param {string} str - Raw content
 * @returns {string|null} Extracted JSON substring or null
 */
function extractFirstCompleteJSON(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  const s = str.trim();
  const openBrace = s.indexOf('{');
  const openBracket = s.indexOf('[');
  let start = -1;
  if (openBrace >= 0 && (openBracket < 0 || openBrace < openBracket)) {
    start = openBrace;
  } else if (openBracket >= 0) {
    start = openBracket;
  }
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  let inString = false;
  let escape = false;
  let stringChar = null;
  while (i < s.length) {
    const c = s[i];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      if (c === '\\') { escape = true; i++; continue; }
      if (c === stringChar) { inString = false; stringChar = null; i++; continue; }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      i++;
      continue;
    }
    if (c === '{' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
      i++;
      continue;
    }
    i++;
  }
  return null;
}

/**
 * Normalize JSON schema for OpenAI strict response_format: required = exactly property keys, additionalProperties: false.
 * Object types without "properties" get properties: {}, required: [] so they are not dropped (avoids "Extra required key" from OpenAI).
 * Mutates the schema in place. Use so requests work whether sent to OpenAI directly or via aionqa-ai-service.
 */
function ensureStrictSchema(schema) {
  if (!schema || typeof schema !== 'object') return;
  // Fix object types that have no "properties" (OpenAI may drop them and then "required" has extra keys)
  if (schema.type === 'object' && !(schema.properties && typeof schema.properties === 'object')) {
    schema.properties = {};
    schema.additionalProperties = false;
    schema.required = [];
  }
  // Normalize any node that has "properties" so required exactly matches property keys
  if (schema.properties && typeof schema.properties === 'object') {
    const propKeys = Object.keys(schema.properties);
    schema.required = [...propKeys];
    if (!('additionalProperties' in schema)) {
      schema.additionalProperties = false;
    }
    for (const key of propKeys) {
      ensureStrictSchema(schema.properties[key]);
    }
  }
  if (schema.type === 'object' && !('additionalProperties' in schema)) {
    schema.additionalProperties = false;
  }
  if (schema.items) {
    ensureStrictSchema(Array.isArray(schema.items) ? schema.items[0] : schema.items);
  }
  for (const key of ['definitions', 'oneOf', 'anyOf', 'allOf', 'schema']) {
    if (schema[key] && Array.isArray(schema[key])) {
      schema[key].forEach(ensureStrictSchema);
    } else if (schema[key] && typeof schema[key] === 'object' && !Array.isArray(schema[key])) {
      if (key === 'schema') {
        ensureStrictSchema(schema[key]);
      } else {
        for (const k of Object.keys(schema[key])) {
          ensureStrictSchema(schema[key][k]);
        }
      }
    }
  }
}

export class AIConversationLogger {
  constructor(backendUrl = null, runnerToken = null, context = {}) {
    // Use environment variable if available, otherwise fallback to default
    this.backendUrl = backendUrl || process.env.BACKEND_URL || 'http://back:4000';
    this.runnerToken = runnerToken || process.env.RUNNER_TOKEN;
    this.context = context; // Store context for AI service URL configuration
    this._openaiClient = null; // Lazy initialization
    this.promptCache = new Map(); // Cache prompts to avoid repeated fetches
    
    // OpenAI pricing (as of 2024, in USD per 1M tokens)
    this.pricing = {
      'gpt-4': { input: 30.00, output: 60.00 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4o': { input: 5.00, output: 15.00 },
      'gpt-4o-mini': { input: 0.150, output: 0.600 },
      'gpt-5-mini': { input: 0.150, output: 0.600 },
      'gpt-5-nano': { input: 0.150, output: 0.600 },
      'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
      'o1-preview': { input: 15.00, output: 60.00 },
      'o1-mini': { input: 3.00, output: 12.00 }
    };
  }
  
  /**
   * Estimate input token count for the request (heuristic: ~4 chars per token for text; images ~1000 each).
   * Used to choose which AI service to call when context.ai_services has multiple entries with max_input_tokens.
   */
  estimateInputTokensFromRequest(openaiRequest) {
    if (!openaiRequest) return 0;
    let total = 0;
    const input = openaiRequest.input || openaiRequest.messages;
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item.content && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.text) total += Math.ceil(String(part.text).length / 4);
            if (part.type === 'input_image' || part.image_url) total += 1000;
          }
        } else if (typeof item.content === 'string') {
          total += Math.ceil(item.content.length / 4);
        }
      }
    }
    if (total === 0 && openaiRequest.input) {
      total = Math.ceil(JSON.stringify(openaiRequest.input).length / 4);
    }
    return total;
  }

  /**
   * Get OpenAI client (lazy initialization with current context)
   * Updates context if provided
   */
  getOpenAIClient(updateContext = null) {
    if (updateContext) {
      this.context = { ...this.context, ...updateContext };
      this._openaiClient = null; // Reset to recreate with new context
    }
    if (!this._openaiClient) {
      // Use AI service instead of direct OpenAI client
      this._openaiClient = createOpenAIClient(this.context);
    }
    return this._openaiClient;
  }
  
  /**
   * Getter for backward compatibility
   */
  get openaiClient() {
    return this.getOpenAIClient();
  }
  
  /**
   * Safely stringify complex objects while handling circular references,
   * Maps/Sets, functions, and BigInt values.
   * @param {any} value - Value to stringify
   * @param {number} space - Indentation spaces
   * @returns {string} Serialized JSON string
   */
  safeStringify(value, space = 2) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(
        value,
        (key, val) => {
          if (typeof val === 'bigint') {
            return val.toString();
          }
          if (typeof val === 'function') {
            return `[Function:${val.name || 'anonymous'}]`;
          }
          if (val instanceof Map) {
            return {
              type: 'Map',
              entries: Array.from(val.entries())
            };
          }
          if (val instanceof Set) {
            return {
              type: 'Set',
              values: Array.from(val.values())
            };
          }
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) {
              return '[Circular]';
            }
            seen.add(val);
          }
          return val;
        },
        space
      );
    } catch (error) {
      console.error('[AI-LOGGER] ❌ Failed to stringify payload:', error.message);
      return JSON.stringify({
        error: 'SerializationFailed',
        message: error.message
      });
    }
  }
  
  /**
   * Calculate cost of an OpenAI API call
   * @param {Object} usage - Usage object from OpenAI response
   * @param {string} model - Model name
   * @returns {Object} Cost breakdown
   */
  calculateCost(usage, model) {
    if (!usage || !model) {
      return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
    }
    
    // Find pricing for the model (try exact match first, then prefix match)
    let modelPricing = this.pricing[model];
    if (!modelPricing) {
      // Try to find by prefix (e.g., "gpt-4-0613" matches "gpt-4")
      const modelPrefix = Object.keys(this.pricing).find(key => model.startsWith(key));
      modelPricing = modelPrefix ? this.pricing[modelPrefix] : null;
    }
    
    // Default to gpt-5-mini pricing if model not found
    if (!modelPricing) {
      console.warn(`[AI-COST] Unknown model "${model}", using gpt-5-mini pricing as fallback`);
      modelPricing = this.pricing['gpt-5-mini'];
    }
    
    const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const totalTokens = usage.total_tokens || (inputTokens + outputTokens);
    
    // Calculate costs (pricing is per 1M tokens)
    const inputCost = (inputTokens / 1000000) * modelPricing.input;
    const outputCost = (outputTokens / 1000000) * modelPricing.output;
    const totalCost = inputCost + outputCost;
    
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat(totalCost.toFixed(6)),
      currency: 'USD',
      model
    };
  }

  /**
   * Fetch prompt configuration from backend by slug
   * @param {string} slug - Prompt slug (e.g., "analyze-page-summary")
   * @returns {Promise<Object>} Prompt configuration
   */
  async fetchPrompt(slug) {
    // Check cache first
    if (this.promptCache.has(slug)) {
      return this.promptCache.get(slug);
    }

    try {
      // Build headers with authentication if runner token is available
      const headers = {};
      if (this.runnerToken) {
        headers['Authorization'] = `Bearer ${this.runnerToken}`;
      }
      
      const response = await axios.get(`${this.backendUrl}/api/prompts/${slug}`, {
        headers,
        timeout: 10000
      });
      
      const prompt = response.data;
      
      // Cache the prompt
      this.promptCache.set(slug, prompt);
      
      console.log(`[AI-PROMPT] ✅ Fetched prompt: ${slug}`);
      return prompt;
    } catch (error) {
      const errorMessage = error.response 
        ? `Failed to fetch prompt "${slug}": ${error.response.status} ${error.response.statusText}`
        : error.message || `Failed to fetch prompt "${slug}"`;
      console.error(`[AI-PROMPT] ❌ ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }

  /**
   * Replace placeholders in prompt template
   * @param {string} template - Template string with {{placeholders}}
   * @param {Object} values - Key-value pairs for replacements
   * @returns {string} Template with placeholders replaced
   */
  replacePlaceholders(template, values) {
    // Handle non-string templates (null, undefined, object)
    if (typeof template !== 'string') {
      console.warn('[AI-LOGGER] replacePlaceholders: template is not a string:', typeof template);
      return String(template || '');
    }
    
    let result = template;
    const placeholderRegexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    for (const [key, value] of Object.entries(values)) {
      const placeholder = `{{${key}}}`;
      let replacement;
      // Don't embed huge base64 screenshot in prompt text - image is sent separately via buildResponseInput
      if ((key === 'screenshot' || key === 'screenshot_base64') && typeof value === 'string' && value.length > 2000) {
        replacement = `[Screenshot attached as image (${Math.round(value.length / 1024)} KB)]`;
      } else if (typeof value === 'string') {
        replacement = value;
      } else {
        replacement = JSON.stringify(value, null, 2);
      }
      result = result.replace(new RegExp(placeholderRegexEscape(placeholder), 'g'), replacement);
    }
    
    return result;
  }

  /**
   * Build structured request context for UI expand/collapse (page_url, visible_text, interactive_elements, etc.)
   * @param {Object} payload - Step payload used for the AI request
   * @param {number} maxStringLength - Max length for string values (default 8000)
   * @returns {Array<{key: string, label: string, value: string|object}>}
   */
  buildRequestContextComponents(payload, maxStringLength = 8000) {
    if (!payload || typeof payload !== 'object') return [];
    const components = [];
    const keys = [
      { key: 'page_url', label: 'Page URL' },
      { key: 'url_before_action', label: 'URL before action' },
      { key: 'url_after_action', label: 'URL after action' },
      { key: 'visible_text', label: 'Visible text' },
      { key: 'interactive_elements', label: 'Interactive elements' },
      { key: 'forms', label: 'Forms' },
      { key: 'currentJourney', label: 'Current journey' },
      { key: 'playwright_analysis', label: 'Playwright analysis' }
    ];
    for (const { key, label } of keys) {
      if (!(key in payload)) continue;
      const raw = payload[key];
      if (raw === undefined || raw === null) continue;
      let value;
      if (typeof raw === 'string') {
        value = raw.length <= maxStringLength ? raw : raw.substring(0, maxStringLength) + '\n… [truncated]';
      } else {
        try {
          const str = JSON.stringify(raw, null, 2);
          value = str.length <= maxStringLength ? raw : { _truncated: true, _preview: str.substring(0, maxStringLength) + '…' };
        } catch (_) {
          value = String(raw);
        }
      }
      components.push({ key, label, value });
    }
    return components;
  }

  /**
   * Normalize a URL when building conversation keys
   * @param {string|null} url 
   * @returns {string|null}
   */
  normalizeUrlForKey(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch (error) {
      return url;
    }
  }

  /**
   * Compute a conversation key so OpenAI Conversations API maintains context per workflow
   * @param {Object} params 
   * @returns {string|null}
   */
  getConversationKey({ jobId, agentName, pageUrl, promptSlug, payload }) {
    const explicitKey = payload?.conversation_key || payload?.conversationKey || payload?.conversationId || payload?.conversation_id;
    if (explicitKey) {
      return String(explicitKey);
    }
    return null;
  }

  /**
   * Build Responses API input array from system and user content
   */
  buildResponseInput(systemMessage, userMessageText, payload) {
    const input = [];

    if (systemMessage && systemMessage.trim().length > 0) {
      input.push({
        role: 'system',
        type: 'message',
        content: [
          {
            type: 'input_text',
            text: systemMessage
          }
        ]
      });
    }

    const userContent = [
      {
        type: 'input_text',
        text: userMessageText
      }
    ];

    // CRITICAL: Check both screenshot_base64 and screenshot (workflow analyzer uses screenshot)
    const screenshotData = payload?.screenshot_base64 || payload?.screenshot;
    if (screenshotData) {
      userContent.push({
        type: 'input_image',
        image_url: `data:image/png;base64,${screenshotData}`,
        detail: 'high'
      });
    }

    input.push({
      role: 'user',
      type: 'message',
      content: userContent
    });

    return input;
  }

  /**
   * Convert legacy chat messages to Responses API input format
   * @param {Array} messages 
   * @returns {Array}
   */
  convertMessagesToResponseInput(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    return messages.map((message) => {
      const contentList = [];

      if (Array.isArray(message.content)) {
        message.content.forEach((item) => {
          if (!item) return;
          if (typeof item === 'string') {
            contentList.push({ type: 'input_text', text: item });
            return;
          }
          if (item.type === 'text' && typeof item.text === 'string') {
            contentList.push({ type: 'input_text', text: item.text });
          } else if (item.type === 'image_url' && item.image_url) {
            const imageUrl = typeof item.image_url === 'string' ? item.image_url : item.image_url.url;
            if (imageUrl) {
              contentList.push({
                type: 'input_image',
                image_url: imageUrl,
                detail: item.detail || 'auto'
              });
            }
          }
        });
      } else if (typeof message.content === 'string') {
        contentList.push({
          type: 'input_text',
          text: message.content
        });
      }

      if (contentList.length === 0) {
        contentList.push({
          type: 'input_text',
          text: ''
        });
      }

      return {
        role: message.role === 'assistant' ? 'assistant' : (message.role === 'system' ? 'system' : 'user'),
        type: 'message',
        content: contentList
      };
    });
  }

  /**
   * Generate thumbnail from HTML content using Playwright
   * @param {string} htmlContent - HTML content to render
   * @param {number} width - Thumbnail width
   * @param {number} height - Thumbnail height
   * @returns {Promise<Buffer>} PNG thumbnail buffer
   */
  async generateHTMLThumbnail(htmlContent, width = 400, height = 300) {
    let browser = null;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      await page.setContent(htmlContent);
      const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
      await browser.close();
      return screenshot;
    } catch (error) {
      console.error('[AI-LOGGER] Failed to generate HTML thumbnail:', error.message);
      if (browser) await browser.close();
      return null;
    }
  }

  /**
   * Generate thumbnail from JSON by rendering it as formatted text
   * @param {string} jsonContent - JSON content
   * @param {number} width - Thumbnail width
   * @param {number} height - Thumbnail height
   * @returns {Promise<Buffer>} PNG thumbnail buffer
   */
  async generateJSONThumbnail(jsonContent, width = 400, height = 300) {
    let browser = null;
    try {
      const formattedJson = JSON.stringify(JSON.parse(jsonContent), null, 2);
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { margin: 0; padding: 10px; font-family: 'Courier New', monospace; font-size: 10px; background: #1e1e1e; color: #d4d4d4; }
            pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; }
            .key { color: #9cdcfe; }
            .string { color: #ce9178; }
            .number { color: #b5cea8; }
            .boolean { color: #569cd6; }
          </style>
        </head>
        <body><pre>${this.syntaxHighlightJSON(formattedJson)}</pre></body>
        </html>
      `;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      await page.setContent(htmlContent);
      const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
      await browser.close();
      return screenshot;
    } catch (error) {
      console.error('[AI-LOGGER] Failed to generate JSON thumbnail:', error.message);
      if (browser) await browser.close();
      return null;
    }
  }

  /**
   * Simple JSON syntax highlighting for HTML rendering
   */
  syntaxHighlightJSON(json) {
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = 'number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'key';
        } else {
          cls = 'string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'boolean';
      } else if (/null/.test(match)) {
        cls = 'null';
      }
      return `<span class="${cls}">${match}</span>`;
    });
  }

  /**
   * Resize screenshot to thumbnail size
   * @param {string} base64Screenshot - Base64 encoded screenshot
   * @param {number} width - Thumbnail width
   * @param {number} height - Thumbnail height
   * @returns {Promise<Buffer>} PNG thumbnail buffer
   */
  async generateScreenshotThumbnail(base64Screenshot, width = 400, height = 300) {
    let browser = null;
    try {
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; background: #000; }
            img { max-width: 100%; max-height: 100%; object-fit: contain; }
          </style>
        </head>
        <body><img src="data:image/png;base64,${base64Screenshot}" /></body>
        </html>
      `;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.setContent(htmlContent);
      const screenshot = await page.screenshot({ type: 'png' });
      await browser.close();
      return screenshot;
    } catch (error) {
      console.error('[AI-LOGGER] Failed to generate screenshot thumbnail:', error.message);
      if (browser) await browser.close();
      return null;
    }
  }

  /**
   * Upload thumbnail to MinIO
   * @param {Buffer} thumbnailBuffer - Thumbnail image buffer
   * @param {string} filename - Filename for the thumbnail
   * @param {string} jobId - Job ID
   * @returns {Promise<string>} Thumbnail URL
   */
  async uploadThumbnail(thumbnailBuffer, filename, jobId) {
    try {
      const response = await fetch(`${this.backendUrl}/upload/thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          filename: filename,
          thumbnail_base64: thumbnailBuffer.toString('base64')
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to upload thumbnail: ${response.statusText}`);
      }

      const result = await response.json();
      return result.url || result.key;
    } catch (error) {
      console.error('[AI-LOGGER] Failed to upload thumbnail:', error.message);
      return null;
    }
  }

  getAuthHeaders() {
    return this.runnerToken ? { 'Authorization': `Bearer ${this.runnerToken}` } : {};
  }

  async ensureAiBudget(jobId) {
    if (!jobId || !this.backendUrl) return;
    try {
      await axios.post(
        `${this.backendUrl}/jobs/${jobId}/ai-budget/check`,
        {},
        { headers: this.getAuthHeaders() }
      );
    } catch (error) {
      const status = error?.response?.status;
      if (status === 402) {
        const message = error?.response?.data?.message || 'AI token balance exhausted. Please top up to continue.';
        throw new Error(message);
      }
      throw error;
    }
  }

  async reportAiMetrics(jobId, payload) {
    if (!jobId || !this.backendUrl || !payload) {
      return;
    }
    try {
      await axios.post(
        `${this.backendUrl}/jobs/${jobId}/ai-metrics`,
        payload,
        { headers: this.getAuthHeaders() }
      );
    } catch (error) {
      console.error('[AI-LOGGER] Failed to report AI usage metrics:', error.response?.data || error.message);
    }
  }

  /**
   * Make AI call using prompt from database (single attempt, no retries)
   * @param {string} promptSlug - Prompt slug to use
   * @param {Object} payload - Data to fill into prompt template
   * @param {string} jobId - Job ID for logging
   * @param {string} agentName - Agent name for logging
   * @param {string} pageUrl - Page URL for logging
   * @param {string} screenshotId - Optional screenshot ID
   * @param {Object} sourcePayload - Optional source payload for logging
   * @param {number} attemptNumber - Deprecated: kept for backward compatibility (not used)
   * @param {string} previousError - Deprecated: kept for backward compatibility (not used)
   * @param {string} modelOverride - Optional model override
   * @param {boolean} reasoningEnabled - Enable reasoning mode (if supported by model)
   * @param {boolean} websearchEnabled - Enable web search (if supported by model)
   * @returns {Promise<Object>} AI response (parsed JSON)
   */
  async makeAICallWithPrompt(promptSlug, payload, jobId, agentName, pageUrl = null, screenshotId = null, sourcePayload = null, customTemplate = null, attemptNumber = 1, previousError = null, modelOverride = null, reasoningEnabled = false, websearchEnabled = false) {
    // Track pending conversation ID for error handling
    let pendingConversationId = null;
    let pendingChatContextId = null;
    let userMessageText = null; // Store for error handling
    
    try {
      // 1. Get prompt configuration (either custom or fetch from backend)
      let prompt;
      if (customTemplate) {
        // Support both string templates and full prompt objects
        if (typeof customTemplate === 'string') {
          prompt = {
            user_message_template: customTemplate,
            system_message: 'You are an automation assistant.',
            response_schema_description: null,
            response_schema: null
          };
        } else if (customTemplate && typeof customTemplate === 'object') {
          prompt = {
            user_message_template: customTemplate.user_message_template || customTemplate.template,
            system_message: customTemplate.system_message_template || customTemplate.system_message || 'You are an automation assistant.',
            response_schema_description: customTemplate.response_schema_description || null,
            response_schema: customTemplate.response_schema || null
          };
        }
      }

      if (!prompt) {
        // Fetch from backend (default behavior)
        prompt = await this.fetchPrompt(promptSlug);
      }

      // Ensure minimum structure exists
      prompt.system_message = prompt.system_message || prompt.system_message_template || 'You are an automation assistant.';
      prompt.user_message_template = prompt.user_message_template || prompt.template;
      prompt.response_schema_description = prompt.response_schema_description || null;
      prompt.response_schema = prompt.response_schema || null;
      
      // 2. Replace placeholders in user message template (e.g. {{page_url}}, {{url_after_action}}, {{visible_text}})
      // Keep all payload keys so placeholders are substituted; URLs in the prompt are context only, not used for direct calls
      let userMessageText = this.replacePlaceholders(prompt.user_message_template, payload);
      
      // 2a. Add project-specific additional prompt text if available
      if (payload.additional_prompt_text && payload.additional_prompt_text.trim()) {
        userMessageText += `\n\n=== PROJECT-SPECIFIC CONTEXT ===\n${payload.additional_prompt_text.trim()}\n`;
      }
      
      // No retry logic - removed
      
      // 3. Add explicit output schema instruction for all models (OpenAI, LM Studio, etc.)
      const wantsJson = payload?.text_format !== 'text';
      if (prompt.response_schema_description) {
        userMessageText += `\n\n=== OUTPUT SCHEMA (follow exactly) ===\n${prompt.response_schema_description}\n\nYou must respond with valid JSON that strictly matches this schema.`;
      }
      if (prompt.response_schema && typeof prompt.response_schema === 'object') {
        // Include precise schema so models that support it can follow it
        try {
          const schemaStr = JSON.stringify(prompt.response_schema);
          if (schemaStr.length < 4000) {
            userMessageText += `\n\n=== JSON SCHEMA (strict) ===\n${schemaStr}\n\nYour response must be valid JSON conforming to this schema.`;
          }
        } catch (_) {}
      }
      // 3a. Same instruction for all models: raw JSON only, no markdown/wrappers (critical for LM Studio and others)
      if (wantsJson) {
        userMessageText += `\n\nIMPORTANT: Output only the raw JSON object. Do not wrap in markdown code blocks (no \`\`\`json), no prefixes, no suffixes, no explanations. Reply with nothing but the JSON.`;
      } else if (!userMessageText.toLowerCase().includes('json')) {
        userMessageText += `\n\nIMPORTANT: Respond with VALID JSON ONLY. No markdown, no code blocks, just pure JSON.`;
      }
      
      // No retry logic - removed
      
      const enhancedSystemMessage = prompt.system_message || 'You are an automation assistant.';

      // Determine conversation key for OpenAI Conversations API
      const conversationKey = this.getConversationKey({
        jobId,
        agentName,
        pageUrl,
        promptSlug,
        payload
      });

      // 4. Construct Responses API input (supports text + optional screenshot)
      const responseInput = this.buildResponseInput(enhancedSystemMessage, userMessageText, payload);
      
      // 5. Get project LLM config to use project's default model if not overridden
      let projectModel = null;
      let projectOptions = {};
      if (jobId && this.backendUrl) {
        try {
          // Extract project_id from payload or job context
          let projectId = payload?.project_id || payload?.projectId || null;
          
          console.log(`[AI-CALL] 🔍 Looking for project_id: payload.project_id=${payload?.project_id}, payload.projectId=${payload?.projectId}, jobId=${jobId}`);
          
          // If project_id not in payload, try to get it from job
          if (!projectId && jobId) {
            try {
              const jobResponse = await axios.get(`${this.backendUrl}/jobs/${jobId}`, {
                headers: this.runnerToken ? { 'Authorization': `Bearer ${this.runnerToken}` } : {},
                timeout: 3000
              }).catch(() => null);
              if (jobResponse && jobResponse.data) {
                const rawProjectId = jobResponse.data.project_id;
                console.log(`[AI-CALL] 🔍 Job response data:`, JSON.stringify({
                  hasProjectId: !!rawProjectId,
                  projectIdType: typeof rawProjectId,
                  projectIdValue: rawProjectId?.toString ? rawProjectId.toString() : rawProjectId
                }));
                if (rawProjectId) {
                  // Convert ObjectId to string if needed
                  projectId = typeof rawProjectId === 'object' && rawProjectId.toString ? rawProjectId.toString() : String(rawProjectId);
                  console.log(`[AI-CALL] ℹ️ Retrieved project_id from job: ${projectId}`);
                } else {
                  console.warn(`[AI-CALL] ⚠️ Job ${jobId} does not have project_id field`);
                }
              } else {
                console.warn(`[AI-CALL] ⚠️ No job data returned for jobId: ${jobId}`);
              }
            } catch (jobError) {
              console.warn(`[AI-CALL] ⚠️ Could not fetch job to get project_id: ${jobError.message}`);
            }
          }
          
          if (projectId) {
            const configResponse = await axios.get(`${this.backendUrl}/api/projects/${projectId}/llm-config`, {
              headers: this.runnerToken ? { 'Authorization': `Bearer ${this.runnerToken}` } : {},
              timeout: 5000
            }).catch(() => null);
            if (configResponse && configResponse.data) {
              projectModel = configResponse.data.model;
              projectOptions = configResponse.data.options || {};
              console.log(`[AI-CALL] ✅ Using project LLM config: model=${projectModel}, options=${JSON.stringify(projectOptions)}`);
            } else {
              console.warn(`[AI-CALL] ⚠️ No LLM config found for project ${projectId}`);
            }
          } else {
            console.warn(`[AI-CALL] ⚠️ No project_id available, using default model`);
          }
        } catch (error) {
          console.warn(`[AI-CALL] ⚠️ Failed to fetch project LLM config: ${error.message}`);
          // Continue with defaults
        }
      }
      
      // 6. Construct OpenAI request (use modelOverride if provided, then payload model, then project model, then default)
      const model = modelOverride || payload?.model || projectModel || "gpt-5-mini";
      
      // Debug logging to understand model selection
      if (attemptNumber === 1) {
        console.log(`[AI-CALL] 🔍 Model selection: modelOverride=${modelOverride}, payload.model=${payload?.model}, projectModel=${projectModel}, final=${model}`);
      }
      
      // Get reasoning/websearch from parameters, payload, or project options (in that order)
      const useReasoning = reasoningEnabled || payload?.reasoning_enabled || projectOptions.reasoning_enabled || false;
      const useWebsearch = websearchEnabled || payload?.websearch_enabled || projectOptions.websearch_enabled || false;
      
      // GPT-5 specific options (from payload, then project options, then defaults)
      // Use !== undefined check to properly handle null values (null means explicitly disabled)
      const textFormat = payload?.text_format !== undefined ? payload.text_format : (projectOptions.text_format || 'json_object');
      const reasoningEffort = payload?.reasoning_effort !== undefined ? payload.reasoning_effort : (projectOptions.reasoning_effort || null);
      const verbosity = payload?.verbosity !== undefined ? payload.verbosity : (projectOptions.verbosity || null);
      const storeLogs = payload?.store_logs !== undefined ? payload.store_logs : (projectOptions.store_logs !== undefined ? projectOptions.store_logs : true);
      
      // Debug logging for reasoning after variables are defined
      if (attemptNumber === 1) {
        console.log(`[AI-CALL] 🔍 Reasoning: enabled=${useReasoning}, effort=${reasoningEffort}, from payload=${payload?.reasoning_effort}, from project=${projectOptions.reasoning_effort}`);
      }
      
      // Request JSON format for all models (OpenAI, LM Studio, etc.) so they are asked the same way
      const openaiRequest = {
        model: model,
        input: responseInput,
        text: {
          format: { type: textFormat === 'json_object' ? 'json_object' : 'text' }
        }
      };
      // Pass response_schema in request (normalized for OpenAI strict mode so it works for direct OpenAI or aionqa-ai-service)
      if (prompt.response_schema && typeof prompt.response_schema === 'object') {
        const schema = JSON.parse(JSON.stringify(prompt.response_schema));
        ensureStrictSchema(schema);
        openaiRequest.response_schema = schema;
      }
      // Generous max_output_tokens so script/JSON responses are not truncated (LM Studio / Ollama default may be low)
      const scriptPromptSlugs = ['generate_journey_script', 'generate_login_script', 'generate-workflow-script', 'generate-form-fill-script', 'generate-click-script', 'generate-navigation-script', 'generate-validation-script'];
      const defaultMaxOut = scriptPromptSlugs.includes(promptSlug) ? 4096 : 2048;
      openaiRequest.max_output_tokens = payload?.max_completion_tokens ?? sourcePayload?.max_completion_tokens ?? defaultMaxOut;
      
      // Add reasoning if enabled and supported
      if (useReasoning) {
        openaiRequest.reasoning = true;
        // Add reasoning effort for GPT-5 models
        // Use project setting unless workflow explicitly overrides it
        if (model.startsWith('gpt-5')) {
          // reasoningEffort comes from: workflow payload > project options > null
          // If it's set (from either source), pass it to OpenAI
          // If null/undefined, don't set it and let OpenAI use its default
          if (reasoningEffort !== null && reasoningEffort !== undefined && reasoningEffort !== '') {
            openaiRequest.reasoning_effort = reasoningEffort;
            console.log(`[AI-CALL] ✅ Setting reasoning_effort to: ${reasoningEffort} (from ${payload?.reasoning_effort !== undefined ? 'workflow' : 'project settings'})`);
          } else {
            console.log(`[AI-CALL] ⚠️ No reasoning_effort specified - OpenAI will use default (medium)`);
          }
        }
      }
      
      // Add web search if enabled and supported
      if (useWebsearch) {
        openaiRequest.web_search = true;
      }
      
      // Add verbosity for GPT-5 models (must be in text.verbosity, not top level)
      if (model.startsWith('gpt-5') && verbosity) {
        openaiRequest.text.verbosity = verbosity;
      }
      
      // Note: store_logs is not a valid OpenAI API parameter, it's just tracked in metadata

    if (conversationKey) {
      openaiRequest.conversation = {
        id: conversationKey
      };
      }
      
      console.log(`[AI-CALL] 🤖 Making AI call with prompt: ${promptSlug}`);
      console.log(`[AI-CALL] 📋 Context: job=${jobId}, agent=${agentName}, url=${pageUrl || 'N/A'}`);
      console.log(`[AI-CALL] 📊 Schema: ${prompt.response_schema_description?.substring(0, 100) || 'N/A'}...`);
      
      // 6. Log request immediately with pending status (before making OpenAI call)
      let pendingConversationId = null;
      let pendingChatContextId = null;
      if (jobId && this.backendUrl) {
        try {
          const purpose = this.generateAIPurpose(promptSlug, sourcePayload || payload, pageUrl);
          const pendingConversationIdValue = `ai-conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          
          // Create pending AI conversation entry
          const pendingConversationData = {
            job_id: jobId,
            agent_name: agentName,
            conversation_type: promptSlug,
            text_request: (userMessageText != null ? String(userMessageText) : '').substring(0, 500), // Preview of request
            source_payload: sourcePayload || payload,
            ai_response: null, // No response yet
            human_request: purpose,
            human_response: '⏳ Waiting for AI response...',
            screenshot_id: screenshotId,
            page_url: pageUrl,
            timestamp: new Date(),
            status: 'pending', // Mark as pending
            attachments: [],
            metadata: {
              prompt_slug: promptSlug,
              pending: true,
              request_sent_at: new Date().toISOString(),
              // Add model and params information
              model: model,
              model_params: {
                reasoning_enabled: useReasoning,
                websearch_enabled: useWebsearch,
                text_format: textFormat,
                reasoning_effort: reasoningEffort,
                verbosity: verbosity,
                store_logs: storeLogs
              }
            },
            conversation_id: pendingConversationIdValue
          };
          
          const pendingResponse = await fetch(`${this.backendUrl}/ai-conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pendingConversationData)
          });
          
          if (pendingResponse.ok) {
            const pendingResult = await pendingResponse.json();
            pendingConversationId = pendingResult.conversation_id;
            pendingChatContextId = pendingResult.chat_context_id;
            console.log(`[AI-CALL] 📤 Request logged with pending status (conversation_id: ${pendingConversationId})`);
          } else {
            console.warn(`[AI-CALL] ⚠️ Failed to log pending request: ${pendingResponse.status}`);
          }
        } catch (pendingLogError) {
          console.warn(`[AI-CALL] ⚠️ Error logging pending request: ${pendingLogError.message}`);
          // Continue with API call even if pending log fails
        }
      }
      
      // 6.5. Log AI conversation immediately to job logs with step name, page, and request JSON
      const aiCallStartTime = Date.now();
      if (jobId && this.backendUrl && attemptNumber === 1) {
        try {
          // Extract step information from sourcePayload
          const stepName = sourcePayload?.step_name || sourcePayload?.stepId || 'AI Request';
          const stepId = sourcePayload?.step_id || sourcePayload?.stepId || null;
          
          // Build request JSON tree for display
          const requestTree = {
            model: model,
            prompt: promptSlug,
            page: pageUrl || 'Unknown',
            step: stepName,
            parameters: {
              reasoning_enabled: useReasoning,
              websearch_enabled: useWebsearch,
              text_format: textFormat,
              reasoning_effort: reasoningEffort,
              verbosity: verbosity,
              store_logs: storeLogs
            },
            request: openaiRequest
          };
          
          const paramsList = [];
          if (useReasoning) {
            // Show actual reasoning_effort value being used (or indicate OpenAI default)
            if (reasoningEffort) {
              paramsList.push(`Reasoning: ${reasoningEffort}`);
            } else {
              paramsList.push(`Reasoning (default: medium)`);
            }
          }
          if (useWebsearch) paramsList.push('Web Search');
          if (textFormat === 'json_object') paramsList.push('JSON Format');
          if (verbosity) paramsList.push(`Verbosity: ${verbosity}`);
          if (storeLogs) paramsList.push('Store Logs');
          
          const paramsText = paramsList.length > 0 ? ` (${paramsList.join(', ')})` : '';
          const stepInfo = stepName !== 'AI Request' ? ` - Step: ${stepName}` : '';
          const pageInfo = pageUrl ? ` - Page: ${new URL(pageUrl).pathname}` : '';
          
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId,
            level: 'info',
            message: `🤖 AI Request: ${stepName}${pageInfo} - Model: ${model}${paramsText}`,
            component: 'AI-CALL',
            metadata: {
              prompt_slug: promptSlug,
              step_name: stepName,
              step_id: stepId,
              page_url: pageUrl,
              model: model,
              model_params: {
                reasoning_enabled: useReasoning,
                websearch_enabled: useWebsearch,
                text_format: textFormat,
                reasoning_effort: reasoningEffort,
                verbosity: verbosity,
                store_logs: storeLogs
              },
              full_request: JSON.stringify(requestTree, null, 2), // Request as JSON tree
              status: 'pending',
              aiConversationId: pendingConversationId, // Link to conversation
              attempt_number: attemptNumber
            }
          }, {
            headers: this.runnerToken ? { 'Authorization': `Bearer ${this.runnerToken}` } : {}
          }).catch(() => {}); // Silent fail - don't block execution
        } catch (e) {
          // Silent fail - don't block execution
        }
      }
      
      // 7. Make OpenAI call (after ensuring budget)
      if (jobId) {
        await this.ensureAiBudget(jobId);
      }
      // Update context with job_id and project_id for AI service URL resolution
      const contextUpdate = {
        job_id: jobId,
        jobId: jobId,
        project_id: payload?.project_id || sourcePayload?.project_id || this.context?.project_id,
        projectId: payload?.project_id || sourcePayload?.project_id || this.context?.project_id
      };
      // AI service must be explicitly configured (no fallbacks). Use context.ai_services from helper config.
      const aiServices = this.context?.ai_services || payload?.ai_services || sourcePayload?.ai_services;
      if (!Array.isArray(aiServices) || aiServices.length === 0) {
        throw new Error('AI not configured. Add at least one AI service in the helper config (e.g. OpenAI or LM Studio URL).');
      }
      const estimatedInputTokens = this.estimateInputTokensFromRequest(openaiRequest);
      const eligibleServices = aiServices.filter((s) => (s.max_input_tokens ?? 32000) >= estimatedInputTokens);
      if (eligibleServices.length === 0) {
        throw new Error(`No AI service with sufficient context limit for this request (~${estimatedInputTokens} tokens). Add a service with max_input_tokens >= ${estimatedInputTokens} in the helper config.`);
      }
      let response;
      let finishReason = 'stop';
      let aiResponse;
      let lastError = null;
      for (let idx = 0; idx < eligibleServices.length; idx++) {
        const chosen = eligibleServices[idx];
        const serviceUrl = chosen?.url;
        if (!serviceUrl) continue;
        try {
          contextUpdate.llm_config = { ...this.context?.llm_config, endpoint: serviceUrl };
          if (attemptNumber === 1) {
            console.log(`[AI-CALL] 📍 Trying AI service ${idx + 1}/${eligibleServices.length} (config order): ${chosen.label || serviceUrl} (max ${chosen.max_input_tokens ?? 32000})`);
          }
          const client = this.getOpenAIClient(contextUpdate);
          response = await client.responses.create(openaiRequest);

          // 7. Determine finish reason
          finishReason = 'stop';
          if (response.incomplete_details?.reason === 'max_output_tokens') {
            finishReason = 'length';
          } else if (response.status && response.status !== 'completed') {
            finishReason = response.status;
          }

          if (finishReason === 'length') {
            console.warn(`[AI-CALL] ⚠️ OpenAI response was truncated (finish_reason: length). This may indicate incomplete content.`);
            if (jobId && this.backendUrl) {
              try {
                await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
                  jobId,
                  level: 'warn',
                  message: `⚠️ OpenAI response was truncated (finish_reason: length). Response may be incomplete.`,
                  component: 'AI-CALL',
                  metadata: {
                    finish_reason: finishReason,
                    prompt_slug: promptSlug,
                    truncated: true
                  }
                }, {
                  headers: this.runnerToken ? { 'Authorization': `Bearer ${this.runnerToken}` } : {}
                }).catch(() => {});
              } catch (e) {}
            }
          }

          // 8. Parse response with validation (LM Studio may return output in output[0].text or array content)
          const rawContent = typeof response?.output_text === 'string'
            ? response.output_text
            : (Array.isArray(response?.output) && response.output[0]?.text != null ? String(response.output[0].text) : '');
          if (!rawContent || (typeof rawContent === 'string' && !rawContent.trim())) {
            throw new Error(`OpenAI returned empty or undefined content. Response: ${JSON.stringify(response)}`);
          }

          let jsonContent = rawContent.trim();
          const codeBlockMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (codeBlockMatch) {
            jsonContent = codeBlockMatch[1].trim();
          }
          const extracted = extractFirstCompleteJSON(jsonContent);
          if (extracted) {
            jsonContent = extracted;
          } else {
            const jsonMatch = jsonContent.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
            if (jsonMatch) {
              jsonContent = jsonMatch[0];
            }
          }
          aiResponse = JSON.parse(jsonContent);
          // Success: valid response from this service
          if (attemptNumber === 1 && idx > 0) {
            console.log(`[AI-CALL] ✅ Succeeded with fallback service ${idx + 1}/${eligibleServices.length}: ${chosen.label || serviceUrl}`);
          }
          break;
        } catch (err) {
          lastError = err;
          const status = err.response?.status || err.status;
          const isHttpError = status != null && (status < 200 || status >= 300);
          const msg = err.message || String(err);
          const isParseOrEmpty = /empty|undefined content|parse.*JSON|incomplete/.test(msg);
          if (attemptNumber === 1) {
            console.warn(`[AI-CALL] ⚠️ AI service failed (${chosen.label || serviceUrl}): ${msg}${isHttpError ? ` (HTTP ${status})` : ''}`);
          }
          if (idx < eligibleServices.length - 1) {
            if (attemptNumber === 1) {
              console.log(`[AI-CALL] 🔄 Trying next AI service (${idx + 2}/${eligibleServices.length})...`);
            }
            continue;
          }
          throw lastError;
        }
      }
      if (aiResponse === undefined) {
        throw lastError || new Error('AI call failed: no response from any configured service.');
      }

      // 8. Validate response against schema
      if (prompt.response_schema) {
        const isValid = this.validateResponse(aiResponse, prompt.response_schema);
        if (!isValid) {
          console.warn(`[AI-CALL] ⚠️ Response validation failed for prompt: ${promptSlug}`);
        }
      }
      
      // 9. Log AI call completion with duration, tokens, and cost to job logs
      const aiCallDuration = Date.now() - aiCallStartTime;
      if (jobId && this.backendUrl && response.usage) {
        try {
          const costDetails = this.calculateCost(response.usage, response.model);
          const inputTokens = response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0;
          const outputTokens = response.usage.completion_tokens ?? response.usage.output_tokens ?? 0;
          const totalTokens = response.usage.total_tokens ?? (inputTokens + outputTokens);
          
          const durationSeconds = (aiCallDuration / 1000).toFixed(2);
          const costText = costDetails.totalCost > 0 
            ? `Cost: $${costDetails.totalCost.toFixed(6)} USD`
            : 'Cost: $0.000000 USD';
          
          await axios.post(`${this.backendUrl}/api/logs/jobs/append`, {
            jobId,
            level: 'info',
            message: `✅ AI call completed in ${durationSeconds}s - Input: ${inputTokens} tokens, Output: ${outputTokens} tokens, Total: ${totalTokens} tokens, ${costText}`,
            component: 'AI-CALL',
            metadata: {
              prompt_slug: promptSlug,
              step_name: sourcePayload?.step_name || sourcePayload?.stepId || null,
              step_id: sourcePayload?.step_id || sourcePayload?.stepId || null,
              page_url: pageUrl,
              model: response.model,
              duration_ms: aiCallDuration,
              duration_seconds: parseFloat(durationSeconds),
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: totalTokens
              },
              cost: costDetails,
              status: 'completed',
              finish_reason: finishReason,
              full_response: JSON.stringify({
                model: response.model,
                response: aiResponse,
                usage: response.usage,
                finish_reason: finishReason
              }, null, 2), // Response as JSON tree
              aiConversationId: pendingConversationId // Link to conversation
            }
          }, {
            headers: this.runnerToken ? { 'Authorization': `Bearer ${this.runnerToken}` } : {}
          }).catch(() => {}); // Silent fail - don't block execution
        } catch (e) {
          // Silent fail - don't block execution
        }
      }
      
      // 10. Log conversation to job logs with FULL payload as attachments
      const conversationRecord = await this.logAIRequestResponse(
        jobId,
        agentName,
        promptSlug, // Use slug as conversation_type
        openaiRequest,
        {
          response_id: response.id,
          usage: response.usage,
          model: response.model,
          output_text: response.output_text,
          output: response.output,
          content: aiResponse,
          parsed: true,
          prompt_slug: promptSlug,
          prompt_name: prompt.name,
          prompt_schema: prompt.response_schema,
          finish_reason: finishReason, // Include finish_reason in response metadata
          conversation_id: pendingConversationId || conversationKey || null,
          conversation_key: conversationKey || null,
          truncated: finishReason === 'length' // Flag if truncated
        },
        screenshotId,
        pageUrl,
        sourcePayload || payload,  // Use sourcePayload if provided, otherwise payload
        { skipJobLogs: true, returnRecord: true }
      );
      
      if (conversationRecord) {
        // Update the pending conversation with the actual response
        // Add model and params to metadata
        const enhancedMetadata = {
          ...conversationRecord.metadata,
          model: model,
          model_params: {
            reasoning_enabled: useReasoning,
            websearch_enabled: useWebsearch,
            text_format: textFormat,
            reasoning_effort: reasoningEffort,
            verbosity: verbosity,
            store_logs: storeLogs
          }
        };
        // Structured request context for UI expand/collapse (page_url, visible_text, interactive_elements, etc.)
        const payloadComponents = this.buildRequestContextComponents(conversationRecord.sourcePayload || payload);

        await this.sendAIConversation(
          jobId,
          agentName,
          promptSlug,
          conversationRecord.textRequest,
          conversationRecord.sourcePayload,
          conversationRecord.aiResponse,
          conversationRecord.screenshotId || screenshotId,
          pageUrl,
          {
            human_request: conversationRecord.humanRequest,
            human_response: conversationRecord.humanResponse,
            attachments: conversationRecord.attachments,
            metadata: enhancedMetadata,
            cost: conversationRecord.cost,
            usage: conversationRecord.usage,
            status: 'success', // Update status from pending to success
            conversation_id: pendingConversationId || conversationKey || null,
            payload_components: payloadComponents
          }
        );
      } else if (pendingConversationId && jobId && this.backendUrl) {
        // If conversationRecord wasn't created but we have a pending conversation, update it directly
        try {
          const purpose = this.generateAIPurpose(promptSlug, sourcePayload || payload, pageUrl);
          const updateData = {
            job_id: jobId,
            agent_name: agentName,
            conversation_type: promptSlug,
            text_request: (userMessageText != null ? String(userMessageText) : '').substring(0, 500),
            source_payload: sourcePayload || payload,
            ai_response: aiResponse,
            human_request: purpose,
            human_response: `AI completed: ${purpose}`,
            screenshot_id: screenshotId,
            page_url: pageUrl,
            timestamp: new Date(),
            status: 'success', // Update from pending to success
            usage: response.usage,
            cost: this.calculateCost(response.usage, response.model),
            conversation_id: pendingConversationId,
            metadata: {
              model: model,
              model_params: {
                reasoning_enabled: useReasoning,
                websearch_enabled: useWebsearch,
                text_format: textFormat,
                reasoning_effort: reasoningEffort,
                verbosity: verbosity,
                store_logs: storeLogs
              }
            }
          };
          
          await fetch(`${this.backendUrl}/ai-conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData)
          });
          console.log(`[AI-CALL] ✅ Updated pending conversation ${pendingConversationId} with response`);
        } catch (updateError) {
          console.warn(`[AI-CALL] ⚠️ Failed to update pending conversation: ${updateError.message}`);
        }
      }
      
      console.log(`[AI-CALL] ✅ AI call completed: ${promptSlug} (${response.usage?.total_tokens || 0} tokens)`);

      if (jobId && response.usage) {
        await this.reportAiMetrics(jobId, {
          usage: response.usage,
          model: response.model,
          ai_calls_count: 1,
        });
      }
      
      // Attach truncation metadata to response for downstream processing
      if (finishReason === 'length') {
        aiResponse._truncated = true;
        aiResponse._finish_reason = finishReason;
      }
      
      return aiResponse;
      
    } catch (error) {
      console.error(`[AI-CALL] ❌ AI call failed for prompt "${promptSlug}":`, error.message);
      
      // Update pending conversation to failed status if it exists
      if (pendingConversationId && jobId && this.backendUrl) {
        try {
          const purpose = this.generateAIPurpose(promptSlug, sourcePayload || payload, pageUrl);
          const failureData = {
            job_id: jobId,
            agent_name: agentName,
            conversation_type: promptSlug,
            text_request: userMessageText?.substring(0, 500) || 'AI request',
            source_payload: sourcePayload || payload,
            ai_response: null,
            human_request: purpose,
            human_response: `❌ Failed: ${error.message}`,
            screenshot_id: screenshotId,
            page_url: pageUrl,
            timestamp: new Date(),
            status: 'failed', // Update from pending to failed
            error: error.message,
            conversation_id: pendingConversationId
          };
          
          await fetch(`${this.backendUrl}/ai-conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(failureData)
          });
          console.log(`[AI-CALL] ❌ Updated pending conversation ${pendingConversationId} with failure status`);
        } catch (updateError) {
          console.warn(`[AI-CALL] ⚠️ Failed to update pending conversation to failed: ${updateError.message}`);
        }
      }
      
      // Log failed request (fallback if pending conversation wasn't created)
      if (!pendingConversationId) {
        const failureRecord = await this.logAIRequestResponse(
          jobId,
          agentName,
          promptSlug,
          { prompt_slug: promptSlug, payload },
          {
            error: error.message,
            success: false,
            prompt_slug: promptSlug,
          },
          screenshotId,
          pageUrl,
          sourcePayload,
          { skipJobLogs: true, returnRecord: true, status: 'failed' }
        );
        
        if (failureRecord) {
          try {
            await this.sendAIConversation(
              jobId,
              agentName,
              promptSlug,
              failureRecord.textRequest,
              failureRecord.sourcePayload,
              failureRecord.aiResponse,
              failureRecord.screenshotId || screenshotId,
              pageUrl,
              {
                human_request: failureRecord.humanRequest,
                human_response: failureRecord.humanResponse,
                attachments: failureRecord.attachments,
                metadata: failureRecord.metadata,
                cost: failureRecord.cost,
                usage: failureRecord.usage,
                status: 'failed',
                error: error.message
              }
            );
          } catch (conversationError) {
            console.warn(`[AI-CALL] ⚠️ Failed to record failed conversation: ${conversationError.message}`);
          }
        }
      }
      
      // No retries - throw error immediately
      throw error;
    }
  }

  /**
   * Validate AI response against prompt schema (basic validation)
   * @param {Object} response - AI response
   * @param {Object} schema - JSON schema
   * @returns {boolean} Whether response matches schema
   */
  validateResponse(response, schema) {
    if (!schema || !schema.required) return true;
    
    // Special handling for generate-workflow-script prompt
    if (schema.required && schema.required.includes('playwright_script')) {
      // Check if either playwright_script or code field exists
      if (response.playwright_script || response.code) {
        return true;
      }
      console.warn(`[AI-VALIDATION] ⚠️ Missing required field: playwright_script or code`);
      return false;
    }
    
    // Special handling for validate-login-success prompt
    if (schema.required && schema.required.includes('login_successful')) {
      // Check if any success field exists
      if (response.login_successful !== undefined || response.success !== undefined || 
          response.is_successful !== undefined || response.validated !== undefined ||
          response.successful !== undefined) {
        // Normalize the response to use login_successful
        if (response.login_successful === undefined) {
          response.login_successful = response.success ?? response.is_successful ?? 
                                       response.validated ?? response.successful ?? false;
        }
        console.log(`[AI-VALIDATION] ✅ Login validation field normalized: login_successful=${response.login_successful}`);
        return true;
      }
      console.warn(`[AI-VALIDATION] ⚠️ Missing required field: login_successful (or success)`);
      return false;
    }
    
    // Special handling for attempt-login prompt
    if (schema.required && schema.required.includes('playwright_code')) {
      // Check if any code field exists
      if (response.playwright_code || response.code || response.script) {
        // Normalize the response to use playwright_code
        if (!response.playwright_code && (response.code || response.script)) {
          response.playwright_code = response.code || response.script;
        }
        return true;
      }
      console.warn(`[AI-VALIDATION] ⚠️ Missing required field: playwright_code`);
      return false;
    }
    
    // Basic validation: check required fields exist
    for (const field of schema.required) {
      if (!(field in response)) {
        console.warn(`[AI-VALIDATION] ⚠️ Missing required field: ${field}`);
        return false;
      }
    }
    
    return true;
  }

  /**
   * Send structured AI conversation to backend for chat mode
   * @param {Object} structuredResponse - StructuredAIResponse object
   */
  async sendStructuredConversation(structuredResponse) {
    console.log(`[AI-CONVERSATION] 🚀 Sending structured AI conversation for job ${structuredResponse.metadata.job_id} by agent ${structuredResponse.metadata.agent_name}`);
    try {
      const conversationData = {
        job_id: structuredResponse.metadata.job_id,
        agent_name: structuredResponse.metadata.agent_name,
        conversation_type: structuredResponse.metadata.conversation_type,
        structured_response: structuredResponse,
        timestamp: structuredResponse.metadata.timestamp
      };

      const httpResponse = await fetch(`${this.backendUrl}/ai-conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationData)
      });

      if (httpResponse.ok) {
        console.log(`[AI-CONVERSATION] 🤖 Structured AI conversation sent to chat mode for job ${structuredResponse.metadata.job_id} by agent ${structuredResponse.metadata.agent_name}`);
      } else {
        console.log(`[AI-CONVERSATION] ⚠️ Failed to send structured AI conversation: ${httpResponse.status}`);
      }
    } catch (error) {
      console.log(`[AI-CONVERSATION] ⚠️ Error sending structured AI conversation: ${error.message}`);
    }
  }

  /**
   * Send AI conversation to backend for chat mode (updated structured format)
   * @param {string} jobId - Job ID this conversation belongs to
   * @param {string} agentName - Name of the agent (e.g., crawler-simplified, login-text)
   * @param {string} conversationType - Type of conversation (e.g., page_analysis, login_attempt, content_extraction)
   * @param {string} textRequest - The text request sent to AI
   * @param {Object} sourcePayload - Source data provided to AI (HTML, forms, screenshots, etc.)
   * @param {Object} aiResponse - The AI response
   * @param {string} screenshotId - Optional screenshot ID associated with this conversation
   * @param {string} pageUrl - Optional page URL this conversation relates to
   * @param {Object} options - Additional options for enhanced payload structure
   */
  async sendAIConversation(jobId, agentName, conversationType, textRequest, sourcePayload, aiResponse, screenshotId = null, pageUrl = null, options = {}) {
    // Extract approach/mode from sourcePayload or options to create separate conversations
    const mode = sourcePayload?.mode || options?.mode || 'auto';
    const approach = sourcePayload?.approach || options?.approach || mode;
    const providedHumanRequest = options?.human_request || null;
    const providedHumanResponse = options?.human_response || null;
    const attachments = Array.isArray(options?.attachments) ? options.attachments : [];
    const additionalMetadata = options?.metadata || {};
    const costDetails = options?.cost || null;
    const usageDetails = options?.usage || null;
    const conversationStatus = options?.status || 'success';
    const errorMessage = options?.error || null;
    const explicitConversationId = options?.conversation_id || sourcePayload?.conversationId || sourcePayload?.conversation_id || null;
    
    // For auto mode, use the specific approach being tried, not "auto"
    const actualApproach = (mode === 'auto' && approach && approach !== 'auto') ? approach : mode;
    const approachAgentName = `${agentName}-${actualApproach}`;
    
    console.log(`[AI-CONVERSATION] Sending conversation: ${approachAgentName} (${actualApproach})`);
    try {
      // Generate human-readable descriptions using AI
      let humanRequest = providedHumanRequest;
      if (!humanRequest) {
        humanRequest = await this.generateCrawlerIntent(conversationType, textRequest, pageUrl);
      }

      let humanResponse = providedHumanResponse;
      if (!humanResponse) {
        humanResponse = await this.generateAIIntent(conversationType, aiResponse, pageUrl);
      }

      // Extract screenshot metadata from sourcePayload
      const screenshotMetadata = {
        screenshot_id: screenshotId || sourcePayload?.screenshot_id,
        screenshot_path: sourcePayload?.screenshot_path,
        full_hd_screenshot: sourcePayload?.full_hd_screenshot || false,
        action: sourcePayload?.action,
        step: sourcePayload?.step,
        form_type: sourcePayload?.form_type,
        field_filled: sourcePayload?.field_filled,
        analysis_type: sourcePayload?.analysis_type,
        mode: mode,
        approach: actualApproach,
        conversation_id: sourcePayload?.conversationId || sourcePayload?.conversation_id
      };

      const timestamp = new Date();

      // Extract model and params from sourcePayload or options
      const modelInfo = sourcePayload?.model || options?.model || additionalMetadata?.model || null;
      const modelParams = {
        reasoning_enabled: sourcePayload?.reasoning_enabled || options?.reasoning_enabled || additionalMetadata?.model_params?.reasoning_enabled || false,
        websearch_enabled: sourcePayload?.websearch_enabled || options?.websearch_enabled || additionalMetadata?.model_params?.websearch_enabled || false,
        text_format: sourcePayload?.text_format || options?.text_format || additionalMetadata?.model_params?.text_format || 'json_object',
        reasoning_effort: sourcePayload?.reasoning_effort || options?.reasoning_effort || additionalMetadata?.model_params?.reasoning_effort || null,
        verbosity: sourcePayload?.verbosity || options?.verbosity || additionalMetadata?.model_params?.verbosity || null,
        store_logs: sourcePayload?.store_logs !== undefined ? sourcePayload.store_logs : (options?.store_logs !== undefined ? options.store_logs : true)
      };
      
      // Merge model info into metadata
      const enhancedMetadata = {
        ...additionalMetadata,
        model: modelInfo,
        model_params: modelParams
      };
      
      const conversationData = {
        job_id: jobId,
        agent_name: approachAgentName, // Use approach-specific agent name
        original_agent_name: agentName, // Keep original for reference
        mode: mode, // Add mode field (auto, media, text, etc.)
        approach: actualApproach, // Add approach field (static, media, text, etc.)
        conversation_type: conversationType,
        text_request: textRequest,
        source_payload: sourcePayload || {},
        ai_response: aiResponse,
        human_request: humanRequest,
        human_response: humanResponse,
        screenshot_id: screenshotMetadata.screenshot_id,
        screenshot_path: screenshotMetadata.screenshot_path,
        screenshot_metadata: screenshotMetadata,
        page_url: pageUrl,
        timestamp,
        structured_response: true,
        status: conversationStatus,
        error: errorMessage,
        cost: costDetails,
        usage: usageDetails,
        attachments,
        metadata: enhancedMetadata,
        conversation_id: explicitConversationId,
        // Enhanced payload structure
        enhanced_payload: options.enhanced_payload || false,
        payload_components: options.payload_components || [],
        conversation_flow: options.conversation_flow || false,
        flow_steps: options.flow_steps || [],
        separate_screenshots: options.separate_screenshots || false
      };

      console.log(`[AI-CONVERSATION] 📤 Sending conversation to backend:`, {
        jobId,
        conversationId: explicitConversationId,
        conversationType,
        hasRequest: !!textRequest,
        hasResponse: !!aiResponse,
        attachmentsCount: attachments.length
      });
      
      const httpResponse = await fetch(`${this.backendUrl}/ai-conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationData)
      });

      if (httpResponse.ok) {
        const responseData = await httpResponse.json().catch(() => ({}));
        console.log(`[AI-CONVERSATION] ✅ Structured AI conversation sent to chat mode for job ${jobId} by agent ${agentName}`, {
          conversation_id: responseData.conversation_id,
          chat_context_id: responseData.chat_context_id
        });
        console.log(`[AI-CONVERSATION] 📝 Human Request: ${humanRequest}`);
        console.log(`[AI-CONVERSATION] 🤖 AI Response: ${humanResponse}`);
      } else {
        const errorText = await httpResponse.text().catch(() => 'Unknown error');
        console.error(`[AI-CONVERSATION] ❌ Failed to send structured AI conversation: ${httpResponse.status}`, errorText);
        console.error(`[AI-CONVERSATION] Request data:`, {
          jobId,
          conversationId: explicitConversationId,
          conversationType,
          pageUrl
        });
      }
    } catch (error) {
      console.error(`[AI-CONVERSATION] ❌ Error sending structured AI conversation: ${error.message}`, error);
      console.error(`[AI-CONVERSATION] Stack:`, error.stack);
    }
  }

  /**
   * Generate human-readable crawler intent using real AI
   * Always makes real OpenAI calls for descriptions
   */
  async generateCrawlerIntent(conversationType, textRequest, pageUrl) {
    try {
      const prompt = `Generate a brief, human-readable description of what this AI request is doing:

Conversation Type: ${conversationType}
Page URL: ${pageUrl}
Request Preview: ${typeof textRequest === 'string' ? textRequest.substring(0, 200) : JSON.stringify(textRequest).substring(0, 200)}...

Respond with just a short description (1-2 sentences) of what the AI is being asked to do.`;

      const response = await this.openaiClient.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: 'user',
            type: 'message',
            content: [
              { type: 'input_text', text: prompt }
            ]
          }
        ],
        text: {
          format: { type: 'text' }
        },
        max_output_tokens: 200
      });

      const content = response.output_text;
      if (!content || content.trim() === '') {
        throw new Error('AI returned empty content for crawler intent');
      }

      return content.trim();
    } catch (error) {
      // Fallback only if AI call fails
      console.warn(`[AI-INTENT] ⚠️ Failed to generate crawler intent: ${error.message}`);
      return `AI request for ${conversationType} on ${pageUrl || 'unknown page'}`;
    }
  }

  /**
   * Generate human-readable AI response description using real AI
   * Always makes real OpenAI calls for descriptions
   */
  async generateAIIntent(conversationType, aiResponse, pageUrl) {
    try {
      const prompt = `Generate a brief, human-readable description of what this AI response accomplished:

Conversation Type: ${conversationType}
Page URL: ${pageUrl}
Response Preview: ${typeof aiResponse === 'string' ? aiResponse.substring(0, 200) : JSON.stringify(aiResponse).substring(0, 200)}...

Respond with just a short description (1-2 sentences) of what the AI accomplished or found.`;

      const response = await this.openaiClient.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: 'user',
            type: 'message',
            content: [
              { type: 'input_text', text: prompt }
            ]
          }
        ],
        text: {
          format: { type: 'text' }
        },
        max_output_tokens: 200
      });

      const content = response.output_text;
      if (!content || content.trim() === '') {
        throw new Error('AI returned empty content for AI intent');
      }

      return content.trim();
    } catch (error) {
      // Fallback only if AI call fails
      console.warn(`[AI-INTENT] ⚠️ Failed to generate AI intent: ${error.message}`);
      return `AI response for ${conversationType} on ${pageUrl || 'unknown page'}`;
    }
  }

  /**
   * Send AI request and response as job logs (SIMPLIFIED APPROACH)
   * Instead of creating separate AI conversation records, just log to job logs with special tags
   */
  /**
   * Generate a descriptive purpose for AI requests based on context
   */
  generateAIPurpose(conversationType, sourcePayload = null, pageUrl = null) {
    // Extract meaningful context from sourcePayload
    const approach = sourcePayload?.approach;
    const workflowLeg = sourcePayload?.workflow_leg;
    const formName = sourcePayload?.form_name;
    const fieldName = sourcePayload?.field_name;
    const testAction = sourcePayload?.test_action;
    const pageTitle = sourcePayload?.page_title;
    const currentStep = sourcePayload?.current_step;
    const testData = sourcePayload?.test_data;
    const previousError = sourcePayload?.previous_error;
    const retryAttempt = sourcePayload?.retry_attempt;
    const formType = sourcePayload?.form_type;
    const fieldValue = sourcePayload?.field_value;
    
    // Generate specific descriptions based on conversation type and context
    switch (conversationType) {
      case 'generate-workflow-script':
        if (retryAttempt && previousError) {
          return `Retrying ${workflowLeg || testAction} after previous error: "${previousError.substring(0, 50)}..."`;
        } else if (workflowLeg && formName && testData) {
          return `Testing ${workflowLeg} on "${formName}" form with data: ${JSON.stringify(testData).substring(0, 30)}...`;
        } else if (workflowLeg && formName) {
          return `Testing ${workflowLeg} on form "${formName}"`;
        } else if (workflowLeg) {
          return `Executing workflow step: ${workflowLeg}`;
        } else if (testAction) {
          return `Generating test script for: ${testAction}`;
        } else if (pageTitle) {
          return `Creating test workflow for page: ${pageTitle}`;
        } else {
          return `Generating automated test workflow`;
        }
        
      case 'analyze-page-for-workflow':
        if (pageTitle) {
          return `Analyzing page structure for testing: ${pageTitle}`;
        } else {
          return `Analyzing page elements for test automation`;
        }
        
      case 'generate-login-script':
        if (formName) {
          return `Creating login automation for form: ${formName}`;
        } else {
          return `Generating login form automation script`;
        }
        
      case 'analyze-login-form':
        return `Analyzing login form structure and fields`;
        
      case 'generate-form-fill-script':
        if (retryAttempt && previousError) {
          return `Retrying form fill for "${fieldName || 'field'}" after error: "${previousError.substring(0, 50)}..."`;
        } else if (formName && fieldName && fieldValue) {
          return `Filling "${fieldName}" field in "${formName}" form with value: "${fieldValue}"`;
        } else if (formName && fieldName) {
          return `Creating form fill script for "${fieldName}" in form "${formName}"`;
        } else if (formName) {
          return `Creating form fill script for form: ${formName}`;
        } else {
          return `Generating form filling automation`;
        }
        
      case 'analyze-form-structure':
        if (formName && formType) {
          return `Analyzing ${formType} form structure: "${formName}"`;
        } else if (formName) {
          return `Analyzing form structure: ${formName}`;
        } else {
          return `Analyzing form elements and validation rules`;
        }
        
      case 'generate-click-script':
        if (testAction) {
          return `Creating click automation for: ${testAction}`;
        } else {
          return `Generating click interaction script`;
        }
        
      case 'analyze-clickable-elements':
        return `Identifying clickable elements and their properties`;
        
      case 'generate-navigation-script':
        if (currentStep) {
          return `Creating navigation script for: ${currentStep}`;
        } else {
          return `Generating page navigation automation`;
        }
        
      case 'analyze-navigation-elements':
        return `Analyzing navigation elements and links`;
        
      case 'generate-validation-script':
        return `Creating validation checks for form submissions`;
        
      case 'analyze-validation-rules':
        return `Analyzing form validation rules and error messages`;
        
      default:
        // Fallback to more descriptive generic message
        if (approach && pageTitle) {
          return `AI analysis using ${approach} approach on page: ${pageTitle}`;
        } else if (approach) {
          return `AI analysis using ${approach} approach`;
        } else if (pageTitle) {
          return `AI analysis for page: ${pageTitle}`;
        } else {
          return `AI request for ${conversationType}`;
        }
    }
  }

  async logAIRequestResponse(jobId, agentName, conversationType, request, response, screenshotId = null, pageUrl = null, sourcePayload = null, extraOptions = {}) {
    try {
      const {
        skipJobLogs = false,
        returnRecord = false,
        status = 'success',
        conversationId = null
      } = extraOptions || {};
      // Generate descriptive purpose based on context
      const purpose = this.generateAIPurpose(conversationType, sourcePayload, pageUrl);
      const humanRequest = `${purpose}`;
      
      // Extract AI's own description from the response if available
      let aiGeneratedDescription = null;
      let humanResponse = `AI completed: ${purpose}`;
      let pageSummaryShortDescription = null;
      
      if (response?.content) {
        // Try to extract summary/description field from AI response
        if (typeof response.content === 'object') {
          aiGeneratedDescription = response.content.summary || response.content.description || response.content.chat_description;
        } else if (typeof response.content === 'string') {
          try {
            const toParse = extractFirstCompleteJSON(response.content) || response.content;
            const parsedContent = JSON.parse(toParse);
            aiGeneratedDescription = parsedContent.summary || parsedContent.description || parsedContent.chat_description;
          } catch (e) {
            // Not JSON, ignore
          }
        }
        
        // Use AI's description if available, otherwise use generated purpose
        if (aiGeneratedDescription) {
          humanResponse = aiGeneratedDescription;
        }

        // Capture short description for page summary conversations when available
        if (conversationType === 'page_summary') {
          if (typeof response.content === 'object' && response.content?.short_description) {
            pageSummaryShortDescription = response.content.short_description;
          } else if (typeof response.content === 'string') {
            try {
              const toParse = extractFirstCompleteJSON(response.content) || response.content;
              const parsedContent = JSON.parse(toParse);
              pageSummaryShortDescription = parsedContent.short_description || null;
            } catch (_) {
              // Ignore parsing errors for string responses
            }
          }
        }
      }

      // Generate a unique conversation ID for this request-response pair
      const recordConversationId = conversationId || `ai-conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const timestampIso = new Date().toISOString();

      const serializedRequest = typeof request === 'string'
        ? request
        : this.safeStringify(request, 2);
      const serializedResponse = typeof response === 'string'
        ? response
        : this.safeStringify(response, 2);
      
      // Generate thumbnails for HTML, screenshot, and JSON (for visual job history)
      const thumbnails = {};
      console.log(`[AI-LOGGER] 📸 Generating thumbnails for visual job history...`);
      
      try {
        // Generate HTML thumbnail
        if (sourcePayload?.html_content) {
          console.log(`[AI-LOGGER] 📄 Generating HTML thumbnail...`);
          const htmlThumbnail = await this.generateHTMLThumbnail(sourcePayload.html_content);
          if (htmlThumbnail) {
            const htmlThumbnailUrl = await this.uploadThumbnail(htmlThumbnail, `html_thumb_${recordConversationId}.png`, jobId);
            if (htmlThumbnailUrl) {
              thumbnails.html_thumbnail = htmlThumbnailUrl;
              console.log(`[AI-LOGGER] ✅ HTML thumbnail generated: ${htmlThumbnailUrl}`);
            }
          }
        }
        
        // Generate screenshot thumbnail
        if (sourcePayload?.screenshot_base64) {
          console.log(`[AI-LOGGER] 📸 Generating screenshot thumbnail...`);
          const screenshotThumbnail = await this.generateScreenshotThumbnail(sourcePayload.screenshot_base64);
          if (screenshotThumbnail) {
            const screenshotThumbnailUrl = await this.uploadThumbnail(screenshotThumbnail, `screenshot_thumb_${recordConversationId}.png`, jobId);
            if (screenshotThumbnailUrl) {
              thumbnails.screenshot_thumbnail = screenshotThumbnailUrl;
              console.log(`[AI-LOGGER] ✅ Screenshot thumbnail generated: ${screenshotThumbnailUrl}`);
            }
          }
        }
        
        // Generate JSON thumbnail
        if (sourcePayload?.interactive_elements_json) {
          console.log(`[AI-LOGGER] 📊 Generating JSON thumbnail...`);
          const jsonThumbnail = await this.generateJSONThumbnail(sourcePayload.interactive_elements_json);
          if (jsonThumbnail) {
            const jsonThumbnailUrl = await this.uploadThumbnail(jsonThumbnail, `json_thumb_${recordConversationId}.png`, jobId);
            if (jsonThumbnailUrl) {
              thumbnails.json_thumbnail = jsonThumbnailUrl;
              console.log(`[AI-LOGGER] ✅ JSON thumbnail generated: ${jsonThumbnailUrl}`);
            }
          }
        }
      } catch (thumbnailError) {
        console.error(`[AI-LOGGER] ⚠️ Failed to generate thumbnails: ${thumbnailError.message}`);
        // Continue without thumbnails
      }
      
      // Create attachments for ALL data passed to OpenAI
      const attachments = [];
      
      // 1. Raw request attachment
      attachments.push({
        type: 'ai_request',
        filename: `ai_request_${recordConversationId}.json`,
        content: serializedRequest,
        mimeType: 'application/json',
        size: serializedRequest.length,
        timestamp: timestampIso
      });

      // 2. Raw response attachment
      attachments.push({
        type: 'ai_response',
        filename: `ai_response_${recordConversationId}.json`,
        content: serializedResponse,
        mimeType: 'application/json',
        size: serializedResponse.length,
        timestamp: timestampIso
      });
      
      // 3. Full HTML content if present in sourcePayload
      if (sourcePayload?.html_content) {
        attachments.push({
          type: 'html_content',
          filename: `html_content_${recordConversationId}.html`,
          content: sourcePayload.html_content,
          mimeType: 'text/html',
          size: sourcePayload.html_content.length,
          timestamp: timestampIso
        });
      }
      
      // 4. Interactive elements JSON if present
      if (sourcePayload?.interactive_elements_json) {
        attachments.push({
          type: 'interactive_elements',
          filename: `interactive_elements_${recordConversationId}.json`,
          content: sourcePayload.interactive_elements_json,
          mimeType: 'application/json',
          size: sourcePayload.interactive_elements_json.length,
          timestamp: timestampIso
        });
      }
      
      // 4a. Playwright analysis JSON if present (for login-service)
      if (sourcePayload?.playwright_analysis) {
        const playwrightContent = typeof sourcePayload.playwright_analysis === 'string' 
          ? sourcePayload.playwright_analysis 
          : JSON.stringify(sourcePayload.playwright_analysis, null, 2);
        attachments.push({
          type: 'playwright_analysis',
          filename: `playwright_analysis_${recordConversationId}.json`,
          content: playwrightContent,
          mimeType: 'application/json',
          size: playwrightContent.length,
          timestamp: timestampIso
        });
      }
      
      // 5. Screenshot reference if present - improved detection
      // Handle multiple screenshot sources (before/after, main screenshot)
      const screenshotSources = [];
      
      // Main screenshot (prioritize screenshot_base64, then screenshot, then screenshot_data)
      const mainScreenshotData = sourcePayload?.screenshot_base64 || sourcePayload?.screenshot || sourcePayload?.screenshot_data;
      if (screenshotId && mainScreenshotData) {
        screenshotSources.push({
          id: screenshotId,
          data: mainScreenshotData,
          label: 'screenshot'
        });
      }
      
      // Before screenshot (if different from main)
      const beforeScreenshotData = sourcePayload?.before_screenshot || sourcePayload?.screenshot_before;
      if (beforeScreenshotData && beforeScreenshotData !== mainScreenshotData) {
        screenshotSources.push({
          id: sourcePayload?.screenshot_before_id || `${screenshotId}_before` || null,
          data: beforeScreenshotData,
          label: 'screenshot_before'
        });
      }
      
      // After screenshot (if different from main)
      const afterScreenshotData = sourcePayload?.after_screenshot || sourcePayload?.screenshot_after;
      if (afterScreenshotData && afterScreenshotData !== mainScreenshotData && afterScreenshotData !== beforeScreenshotData) {
        screenshotSources.push({
          id: sourcePayload?.screenshot_after_id || `${screenshotId}_after` || null,
          data: afterScreenshotData,
          label: 'screenshot_after'
        });
      }
      
      // Create attachments for each unique screenshot
      const seenScreenshotData = new Set();
      screenshotSources.forEach((screenshot, idx) => {
        // Skip duplicates based on data content (first 100 chars as fingerprint)
        const dataFingerprint = screenshot.data ? screenshot.data.substring(0, 100) : '';
        if (seenScreenshotData.has(dataFingerprint)) {
          console.log(`[AI-LOGGER] ⚠️ Skipping duplicate screenshot: ${screenshot.label}`);
          return;
        }
        seenScreenshotData.add(dataFingerprint);
        
        attachments.push({
          type: 'screenshot',
          filename: `screenshot_${screenshot.label}_${recordConversationId}.png`,
          content: screenshot.data ? `[Screenshot base64 data: ${screenshot.data.length} chars]` : `[Screenshot ID: ${screenshot.id}]`,
          mimeType: 'image/png',
          size: screenshot.data?.length || 0,
          timestamp: timestampIso,
          screenshot_id: screenshot.id,
          screenshot_label: screenshot.label,
          has_data: !!screenshot.data
        });
        console.log(`[AI-LOGGER] 📸 Screenshot attachment (${screenshot.label}): ID=${screenshot.id}, HasData=${!!screenshot.data}, Size=${screenshot.data?.length || 0}`);
      });
      
      if (screenshotSources.length === 0) {
        console.log(`[AI-LOGGER] ⚠️ No screenshot data found for conversation ${recordConversationId}`);
        console.log(`[AI-LOGGER] 📋 SourcePayload keys:`, Object.keys(sourcePayload || {}));
      }
      
      // 6. Previous logs if present (check both previous_logs and previous_attempts)
      const previousLogsContent = sourcePayload?.previous_logs || sourcePayload?.previous_attempts;
      if (previousLogsContent) {
        attachments.push({
          type: 'previous_logs',
          filename: `previous_logs_${recordConversationId}.txt`,
          content: previousLogsContent,
          mimeType: 'text/plain',
          size: previousLogsContent.length,
          timestamp: timestampIso
        });
      }

      // Send AI Request and Response as job logs with ALL attachments
      const requestAttachments = attachments.filter(a => a.type !== 'ai_response');
      const responseAttachments = attachments.filter(a => a.type !== 'ai_request');

      // Compose human-readable response for page analysis summary
      if (conversationType === 'page_summary') {
        const summaryText = pageSummaryShortDescription || aiGeneratedDescription || humanResponse;
        humanResponse = `📄 Page Analysis: ${summaryText || 'Summary not available'}`;
      }

      const responseUsage = response?.usage || {};
      const costDetails = this.calculateCost(responseUsage, response?.model);
      const technicalResponseText = typeof response?.output_text === 'string'
        ? response.output_text
        : (typeof response?.content === 'string' ? response.content : serializedResponse);

      const logEntries = [
        {
          level: 'info',
          message: `🤖 AI Request: ${humanRequest}`,
          component: 'OPENAI-REQUEST',
          agentName,
          timestamp: new Date(),
          pageUrl: pageUrl, // Top-level pageUrl for routing
          aiConversationId: recordConversationId, // Top-level conversation ID
          attachments: requestAttachments,  // All attachments except response
          metadata: {
            ai_request: true,
            conversation_type: conversationType,
            agent_name: agentName,
            page_url: pageUrl,
            screenshot_id: screenshotId,
            human_request: humanRequest,
            conversation_description: humanRequest, // Add description field for chat display
            technical_request: serializedRequest.substring(0, 500),
            full_request: serializedRequest,
            source_payload: sourcePayload,
            model: response?.model || sourcePayload?.model,
            prompt_name: response?.prompt_name || conversationType, // Add prompt name for workflow display
            prompt_slug: response?.prompt_slug || conversationType, // Add prompt slug
            has_html_content: !!sourcePayload?.html_content,
            html_content_size: sourcePayload?.html_content?.length || 0,
            has_interactive_elements: !!sourcePayload?.interactive_elements_json,
            has_playwright_analysis: !!sourcePayload?.playwright_analysis,
            has_screenshot: !!(screenshotId || sourcePayload?.screenshot_base64 || sourcePayload?.screenshot),
            has_previous_logs: !!(sourcePayload?.previous_logs || sourcePayload?.previous_attempts),
            page_analysis: conversationType === 'page_summary',
            page_summary_short_description: pageSummaryShortDescription,
            previous_response_id: response?.previous_response_id,
            // Add thumbnails for visual job history
            thumbnails: thumbnails,
            has_thumbnails: Object.keys(thumbnails).length > 0
          }
        },
        {
          level: 'info',
          message: `🧠 AI Response: ${humanResponse}`,
          component: 'OPENAI-RESPONSE',
          agentName,
          timestamp: new Date(),
          pageUrl: pageUrl, // Top-level pageUrl for routing
          aiConversationId: recordConversationId, // Top-level conversation ID
          attachments: responseAttachments,  // Response attachment plus content artifacts
          metadata: {
            ai_response: true,
            conversation_type: conversationType,
            agent_name: agentName,
            page_url: pageUrl,
            screenshot_id: screenshotId,
            human_response: humanResponse,
            conversation_description: humanResponse, // Add description field for chat display (AI's own description)
            ai_generated_description: aiGeneratedDescription, // Store AI's original description separately
            technical_response: technicalResponseText.substring(0, 500),
            full_response: serializedResponse,
            usage: response?.usage,
            model: response?.model,
            cost: costDetails,
            prompt_name: response?.prompt_name || conversationType, // Add prompt name for workflow display
            prompt_slug: response?.prompt_slug || conversationType, // Add prompt slug
            page_analysis: conversationType === 'page_summary',
            page_summary_short_description: pageSummaryShortDescription,
            output_text: response?.output_text,
            output_items: response?.output,
            finish_reason: response?.finish_reason,
            // Add thumbnails for visual job history
            thumbnails: thumbnails,
            has_thumbnails: Object.keys(thumbnails).length > 0
          }
        }
      ];
      if (!skipJobLogs) {
        const uploadResponse = await fetch(`${this.backendUrl}/upload/logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId,
            logs: logEntries
          })
        });

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          console.error(`[AI-LOG] ❌ Failed to upload logs (${uploadResponse.status}): ${errorText}`);
          if (returnRecord) {
            return {
              status,
              jobId,
              agentName,
              conversationType,
              textRequest: serializedRequest,
              aiResponse: response,
              sourcePayload,
              attachments,
              humanRequest,
              humanResponse,
              screenshotId,
              pageUrl,
              metadata: {
                request: logEntries[0]?.metadata || {},
                response: logEntries[1]?.metadata || {},
                thumbnails
              },
          cost: this.calculateCost(response?.usage, response?.model),
              usage: response?.usage,
              timestamp: new Date(),
          conversationId: recordConversationId
            };
          }
          return;
        }

        console.log(`[AI-LOG] ✅ AI request/response logged to job logs for ${jobId}`);
      }

      if (returnRecord) {
        return {
          status,
          jobId,
          agentName,
          conversationType,
          textRequest: serializedRequest,
          aiResponse: response,
          sourcePayload,
          attachments,
          humanRequest,
          humanResponse,
          screenshotId,
          pageUrl,
          metadata: {
            request: logEntries[0]?.metadata || {},
            response: logEntries[1]?.metadata || {},
            thumbnails
          },
          cost: costDetails,
          usage: response?.usage,
          timestamp: new Date(),
          conversationId: recordConversationId
        };
      }
    } catch (error) {
      console.error(`[AI-LOG] ❌ Failed to log AI request/response: ${error.message}`);
      if (returnRecord) {
        return {
          status: 'error',
          jobId,
          agentName,
          conversationType,
          textRequest: typeof request === 'string' ? request : this.safeStringify(request, 2),
          aiResponse: response,
          sourcePayload,
          attachments: [],
          humanRequest: '',
          humanResponse: '',
          screenshotId,
          pageUrl,
          metadata: {},
          cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
          usage: null,
          timestamp: new Date(),
          conversationId: recordConversationId
        };
      }
    }
  }

  /**
   * @deprecated This method is deprecated. Use makeAICallWithPrompt() instead.
   * 
   * TEMPORARY: Still functional but will be removed soon.
   * This method logs warnings and will be removed in a future update.
   * 
   * Migration: Replace with makeAICallWithPrompt() using prompts from database.
   * See /AI-PROMPT-MIGRATION-GUIDE.md for complete migration instructions.
   */
  async createChatCompletion(openaiClient, jobId, agentName, conversationType, options, screenshotId = null, pageUrl = null, sourcePayload = null) {
    // Log deprecation warning
    console.warn(`[DEPRECATED] createChatCompletion() is deprecated for conversation: ${conversationType}`);
    console.warn(`[DEPRECATED] Please migrate to makeAICallWithPrompt() - See /AI-PROMPT-MIGRATION-GUIDE.md`);
    
    try {
      const client = openaiClient || this.openaiClient;
      const messagesInput = this.convertMessagesToResponseInput(options?.messages || []);

      const conversationKey = this.getConversationKey({
        jobId,
        agentName,
        pageUrl,
        promptSlug: conversationType,
        payload: sourcePayload || {}
      });
      const requestPayload = {
        model: options?.model || "gpt-5-mini",
        input: messagesInput.length > 0 ? messagesInput : [{
          role: 'user',
          type: 'message',
          content: [
            { type: 'input_text', text: '' }
          ]
        }]
      };

      if (options?.temperature !== undefined) {
        requestPayload.temperature = options.temperature;
      }
      if (options?.top_p !== undefined) {
        requestPayload.top_p = options.top_p;
      }
      if (options?.max_completion_tokens !== undefined) {
        requestPayload.max_output_tokens = options.max_completion_tokens;
      }
      if (options?.response_format?.type === 'json_object') {
        requestPayload.text = {
          format: { type: 'json_object' }
        };
      }
      if (conversationKey) {
        requestPayload.conversation = {
          id: conversationKey
        };
      }

      const response = await client.responses.create(requestPayload);

      let finishReason = 'stop';
      if (response.incomplete_details?.reason === 'max_output_tokens') {
        finishReason = 'length';
      } else if (response.status && response.status !== 'completed') {
        finishReason = response.status;
      }

      const outputText = response.output_text || '';

      const completionResult = {
        id: response.id,
        model: response.model,
        usage: response.usage,
        choices: [
          {
            index: 0,
            finish_reason: finishReason,
            message: {
              role: 'assistant',
              content: outputText
            }
          }
        ],
        output_text: outputText,
        response
      };

      const completionRecord = await this.logAIRequestResponse(
        jobId,
        agentName,
        conversationType,
        requestPayload, // Full request payload
        {
          response_id: response.id,
          usage: response.usage,
          model: response.model,
          output_text: response.output_text,
          output: response.output,
          content: outputText,
          deprecated_method: true,
          migration_needed: true,
          finish_reason: finishReason,
          previous_response_id: requestPayload.previous_response_id || null
        },
        screenshotId,
        pageUrl,
        sourcePayload,
        { skipJobLogs: true, returnRecord: true }
      );

      if (completionRecord) {
        await this.sendAIConversation(
          jobId,
          agentName,
          conversationType,
          completionRecord.textRequest,
          completionRecord.sourcePayload,
          completionRecord.aiResponse,
          completionRecord.screenshotId || screenshotId,
          pageUrl,
          {
            human_request: completionRecord.humanRequest,
            human_response: completionRecord.humanResponse,
            attachments: completionRecord.attachments,
            metadata: completionRecord.metadata,
            cost: completionRecord.cost,
            usage: completionRecord.usage,
            status: completionRecord.status,
            conversation_id: conversationKey || null
          }
        );
      }

      return completionResult;
    } catch (error) {
      // Log failed request/response
      const failureRecord = await this.logAIRequestResponse(
        jobId,
        agentName,
        conversationType,
        options, // Original request payload for debugging
        {
          error: error.message,
          success: false,
          deprecated_method: true
        },
        screenshotId,
        pageUrl,
        sourcePayload,
        { skipJobLogs: true, returnRecord: true, status: 'failed' }
      );
      
      if (failureRecord) {
        try {
          await this.sendAIConversation(
            jobId,
            agentName,
            conversationType,
            failureRecord.textRequest,
            failureRecord.sourcePayload,
            failureRecord.aiResponse,
            failureRecord.screenshotId || screenshotId,
            pageUrl,
            {
              human_request: failureRecord.humanRequest,
              human_response: failureRecord.humanResponse,
              attachments: failureRecord.attachments,
              metadata: failureRecord.metadata,
              cost: failureRecord.cost,
              usage: failureRecord.usage,
              status: 'failed',
              error: error.message
            }
          );
        } catch (conversationError) {
          console.warn(`[AI-CONVERSATION] ⚠️ Failed to record deprecated conversation failure: ${conversationError.message}`);
        }
      }
      
      throw error;
    }
  }

        /**
         * Analyze request and response with AI to generate clean descriptions
         */
        async analyzeConversationWithAI(jobId, agentName, pageUrl, requestData, responseData, screenshotId = null) {
          try {
            const analysisPrompt = `You are an AI assistant that generates human-readable descriptions for data analysis conversations in a chat interface.
            
            Analyze the following request and response data and provide a JSON response with:
            
            1. request_description: A clear, human-readable description of what the HUMAN wants to do (the intent/purpose)
            2. response_description: A clear, human-readable description of what the AI accomplished or found
            3. request_summary: Key details from the request (forms found, page info, etc.)
            4. response_summary: Key details from the response (actions taken, results, etc.)
            5. key_findings: Array of important findings or insights
            6. confidence_score: 0-1 confidence in the analysis
            7. playwright_script: Extract any Playwright script from the response (if present)
            8. html_content: Extract any HTML content from the response (if present)
            9. forms_data: Extract any forms data from the request (if present)
            10. screenshot_data: Extract any screenshot data from the request (if present)
            
            IMPORTANT: 
            - request_description should describe what the HUMAN wants to accomplish (the goal/intent)
            - response_description should describe what the AI found or accomplished
            - Use clear, conversational language that a human would understand
            
            Examples:
            - request_description: "Analyze document structure and identify form elements for data extraction"
            - response_description: "Found 2 form structures with username and password fields, generated field mappings"
            
            - request_description: "Extract content and catalog interactive elements for structural analysis"
            - response_description: "Discovered 5 forms and 12 links, created element catalog with relationships"
            
            - request_description: "Examine form fields with provided test data"
            - response_description: "Data validation successful, form structure matches expected schema"
            
            Request Data:
            ${JSON.stringify(requestData, null, 2)}
            
            Response Data:
            ${JSON.stringify(responseData, null, 2)}
            
            Agent: ${agentName}
            Page URL: ${pageUrl}
            
            Respond with valid JSON only.`;

      const analysisResponse = await this.openaiClient.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: 'user',
            type: 'message',
            content: [
              { type: 'input_text', text: analysisPrompt }
            ]
          }
        ],
        text: {
          format: { type: 'json_object' }
        }
      });

      const rawAnalysis = analysisResponse.output_text || '';
      const analysisJson = extractFirstCompleteJSON(rawAnalysis) || rawAnalysis;
      const aiAnalysis = JSON.parse(analysisJson);
      
      // Create structured response with AI analysis
      const structuredResponse = StructuredAIResponse.createAIAnalyzedResponse(
        agentName,
        jobId,
        pageUrl,
        requestData,
        responseData,
        aiAnalysis,
        screenshotId
      );

      // Send the analyzed conversation
      await this.sendStructuredConversation(structuredResponse);

      return structuredResponse;
    } catch (error) {
      console.warn('[AI-CONVERSATION] ⚠️ Failed to analyze conversation with AI:', error.message);
      
      // Fallback to regular logging if AI analysis fails
      await this.sendAIConversation(
        jobId,
        agentName,
        'conversation_analysis_failed',
        requestData,
        { error: error.message, success: false },
        screenshotId,
        pageUrl
      );
      
      throw error;
    }
  }

  /**
   * Send enhanced AI conversation with separate payload components
   * @param {string} jobId - Job ID
   * @param {string} agentName - Agent name
   * @param {string} conversationType - Conversation type
   * @param {string} textRequest - Text request
   * @param {Object} aiResponse - AI response
   * @param {Array} payloadComponents - Array of payload components (HTML, forms, etc.)
   * @param {Array} screenshotData - Array of screenshot data with metadata
   * @param {string} pageUrl - Page URL
   */
  async sendEnhancedAIConversation(jobId, agentName, conversationType, textRequest, aiResponse, payloadComponents = [], screenshotData = [], pageUrl = null, options = {}) {
    // Extract approach/mode from options to create separate conversations
    const mode = options?.mode || 'auto';
    const approach = options?.approach || mode;
    
    // For auto mode, use the specific approach being tried, not "auto"
    const actualApproach = (mode === 'auto' && approach && approach !== 'auto') ? approach : mode;
    const approachAgentName = `${agentName}-${actualApproach}`;
    
    console.log(`[AI-CONVERSATION] Enhanced conversation: ${approachAgentName} (${actualApproach})`);
    
    try {
      // Generate human-readable descriptions
      const [humanRequest, humanResponse] = await Promise.all([
        this.generateCrawlerIntent(conversationType, textRequest, pageUrl),
        this.generateAIIntent(conversationType, aiResponse, pageUrl)
      ]);

      const conversationData = {
        job_id: jobId,
        agent_name: approachAgentName, // Use approach-specific agent name
        original_agent_name: agentName, // Keep original for reference
        mode: mode, // Add mode field (auto, media, text, etc.)
        approach: actualApproach, // Add approach field (static, media, text, etc.)
        conversation_type: conversationType,
        text_request: textRequest,
        ai_response: aiResponse,
        human_request: humanRequest,
        human_response: humanResponse,
        page_url: pageUrl,
        timestamp: new Date(),
        structured_response: true,
        enhanced_payload: true,
        payload_components: payloadComponents,
        screenshot_data: screenshotData,
        separate_screenshots: true
      };

      const httpResponse = await fetch(`${this.backendUrl}/ai-conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationData)
      });

      if (httpResponse.ok) {
        console.log(`[AI-CONVERSATION] 🤖 Enhanced AI conversation sent for job ${jobId} by agent ${agentName}`);
        console.log(`[AI-CONVERSATION] 📦 Payload components: ${payloadComponents.length}`);
        console.log(`[AI-CONVERSATION] 📸 Screenshots: ${screenshotData.length}`);
      } else {
        console.log(`[AI-CONVERSATION] ⚠️ Failed to send enhanced AI conversation: ${httpResponse.status}`);
      }
    } catch (error) {
      console.log(`[AI-CONVERSATION] ⚠️ Error sending enhanced AI conversation: ${error.message}`);
    }
  }

  /**
   * Send conversation flow with step-by-step screenshots and actions
   * @param {string} jobId - Job ID
   * @param {string} agentName - Agent name
   * @param {string} pageUrl - Page URL
   * @param {Array} flowSteps - Array of flow steps with screenshots and actions
   */
  async sendConversationFlow(jobId, agentName, pageUrl, flowSteps = [], options = {}) {
    // Extract approach/mode from options to create separate conversations
    const mode = options?.mode || 'auto';
    const approach = options?.approach || mode;
    
    // For auto mode, use the specific approach being tried, not "auto"
    const actualApproach = (mode === 'auto' && approach && approach !== 'auto') ? approach : mode;
    const approachAgentName = `${agentName}-${actualApproach}`;
    
    console.log(`[AI-CONVERSATION] Flow conversation: ${approachAgentName} (${actualApproach})`);
    
    try {
      const conversationData = {
        job_id: jobId,
        agent_name: approachAgentName, // Use approach-specific agent name
        original_agent_name: agentName, // Keep original for reference
        mode: mode, // Add mode field (auto, media, text, etc.)
        approach: actualApproach, // Add approach field (static, media, text, etc.)
        conversation_type: 'conversation_flow',
        text_request: 'Conversation flow with step-by-step screenshots and actions',
        human_request: 'I want to see the step-by-step process with screenshots before and after each action',
        human_response: 'I will show you the complete flow with screenshots and actions taken at each step',
        page_url: pageUrl,
        timestamp: new Date(),
        structured_response: true,
        conversation_flow: true,
        flow_steps: flowSteps,
        separate_screenshots: true,
        enhanced_payload: true
      };

      const httpResponse = await fetch(`${this.backendUrl}/ai-conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationData)
      });

      if (httpResponse.ok) {
        console.log(`[AI-CONVERSATION] 🤖 Conversation flow sent for job ${jobId} by agent ${agentName}`);
        console.log(`[AI-CONVERSATION] 📋 Flow steps: ${flowSteps.length}`);
      } else {
        console.log(`[AI-CONVERSATION] ⚠️ Failed to send conversation flow: ${httpResponse.status}`);
      }
    } catch (error) {
      console.log(`[AI-CONVERSATION] ⚠️ Error sending conversation flow: ${error.message}`);
    }
  }
}

// Create a default instance using environment variables
// Singleton instance - will be recreated with context when needed
// Note: This is deprecated - use new AIConversationLogger(backendUrl, runnerToken, context) instead
export const aiConversationLogger = new AIConversationLogger(
  process.env.BACKEND_URL || 'http://back:4000',
  process.env.RUNNER_TOKEN,
  {}
);
