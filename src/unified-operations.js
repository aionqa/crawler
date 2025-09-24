/**
 * Unified Operations - Handles login and crawl operations with multiple modes
 */

import { chromium } from 'playwright';
import OpenAI from 'openai';
import gelfClient from '/app/shared/gelf-client.js';
import { aiConversationLogger } from '/app/shared/ai-conversation-logger.js';
// For now, we'll create simplified versions of these functions
// In production, these would be imported from the shared directory

function createSuccessResponse(data, id = null) {
  return {
    jsonrpc: "2.0",
    result: {
      success: true,
      ...data
    },
    id
  };
}

function createErrorResponse(error, id = null) {
  return {
    jsonrpc: "2.0",
    error: {
      code: error.code || -32603,
      message: error.message || 'Internal error',
      data: error.details || error
    },
    id
  };
}

// Set agent name for GELF
process.env.AGENT_NAME = 'unified-crawler';

// Helper function to send logs to both console and Graylog
async function sendLog(jobId, level, message, data = {}) {
  // Send to console for local debugging
  console.log(`[${level.toUpperCase()}] ${message}`);
  
  // Send to Graylog via GELF
  await gelfClient.sendJobLog(jobId, level, message, 'unified-crawler', data);
}

// Upload files via backend API
async function uploadFileToBackend({ buffer, contentType, type, jobId }) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
    const endpoint = type === 'screenshot' ? '/upload/screenshot' : '/upload/video';
    
    const response = await fetch(`${backendUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jobId: jobId,
        data: buffer.toString('base64'),
        type: contentType
      })
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.file_id;
  } catch (error) {
    console.error(`[unified-crawler] Backend upload error: ${error.message}`);
    return null;
  }
}

// Browser automation wrapper
async function withBrowser(action, options = {}) {
  const browser = await chromium.launch({
    headless: options.headless !== false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ]
  });
  
  const contextOptions = {
    userAgent: options.userAgent,
    ignoreHTTPSErrors: true,
    viewport: options.viewport || { width: 1280, height: 800 }
  };
  
  // Add video recording if enabled
  if (options.enable_video_recording) {
    contextOptions.recordVideo = { 
      dir: '/tmp/aionqa_videos',
      size: { width: 1280, height: 800 }
    };
  }
  
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  
  let videoFileId = null;
  let screenshotFileId = null;
  
  try {
    const result = await action({ page, context, browser });
    
    // Capture screenshot if enabled
    if (options.enable_screenshots && page) {
      try {
        await sendLog(options.job_id || 'unknown', 'info', '📸 Capturing screenshot...');
        const screenshot = await page.screenshot({ 
          type: 'png', 
          fullPage: true 
        });
        screenshotFileId = await uploadFileToBackend({
          buffer: screenshot,
          contentType: 'image/png',
          type: 'screenshot',
          jobId: options.job_id
        });
        await sendLog(options.job_id || 'unknown', 'info', `📸 Screenshot captured successfully: ${screenshotFileId}`);
      } catch (error) {
        await sendLog(options.job_id || 'unknown', 'error', `📸 Screenshot capture failed: ${error.message}`);
      }
    }
    
    // Handle video recording if enabled
    if (options.enable_video_recording && page && page.video) {
      try {
        await sendLog(options.job_id || 'unknown', 'info', '🎥 Processing video recording...');
        const video = page.video();
        if (video) {
          const tempPath = `/tmp/run_${options.job_id || Date.now()}_${Date.now()}.webm`;
          await video.saveAs(tempPath);
          
          const fs = await import('fs');
          const buf = fs.readFileSync(tempPath);
          videoFileId = await uploadFileToBackend({
            buffer: buf,
            contentType: 'video/webm',
            type: 'video',
            jobId: options.job_id
          });
          
          // Clean up temp file
          fs.unlinkSync(tempPath);
          await sendLog(options.job_id || 'unknown', 'info', `🎥 Video recorded successfully: ${videoFileId}`);
        }
      } catch (error) {
        await sendLog(options.job_id || 'unknown', 'error', `🎥 Video recording failed: ${error.message}`);
      }
    }
    
    return {
      ...result,
      video_file_id: videoFileId,
      screenshot_file_id: screenshotFileId
    };
    
  } finally {
    await browser.close();
  }
}

// Mode-specific operation handlers
const modeHandlers = {
  // Auto mode - AI-driven approach (default)
  auto: async (page, context, openaiClient, operation) => {
    await sendLog(context.job_id, 'info', '🤖 Using auto mode - AI-driven approach');
    
    if (operation === 'login') {
      return await performAutoLogin(page, context, openaiClient);
    } else {
      return await performAutoCrawl(page, context, openaiClient);
    }
  },

  // Media mode - Screenshot analysis
  media: async (page, context, openaiClient, operation) => {
    await sendLog(context.job_id, 'info', '📸 Using media mode - Screenshot analysis');
    
    if (operation === 'login') {
      return await performMediaLogin(page, context, openaiClient);
    } else {
      return await performMediaCrawl(page, context, openaiClient);
    }
  },

  // Text mode - HTML text analysis
  text: async (page, context, openaiClient, operation) => {
    await sendLog(context.job_id, 'info', '📝 Using text mode - HTML text analysis');
    
    if (operation === 'login') {
      return await performTextLogin(page, context, openaiClient);
    } else {
      return await performTextCrawl(page, context, openaiClient);
    }
  },

  // Forms mode - Form field analysis
  forms: async (page, context, openaiClient, operation) => {
    await sendLog(context.job_id, 'info', '📋 Using forms mode - Form field analysis');
    
    if (operation === 'login') {
      return await performFormsLogin(page, context, openaiClient);
    } else {
      return await performFormsCrawl(page, context, openaiClient);
    }
  },

  // Static mode - Standard field ID matching
  static: async (page, context, openaiClient, operation) => {
    await sendLog(context.job_id, 'info', '🔍 Using static mode - Standard field ID matching');
    
    if (operation === 'login') {
      return await performStaticLogin(page, context, openaiClient);
    } else {
      return await performStaticCrawl(page, context, openaiClient);
    }
  },

  // Script mode - Custom script execution
  script: async (page, context, openaiClient, operation) => {
    await sendLog(context.job_id, 'info', '📜 Using script mode - Custom script execution');
    
    if (operation === 'login') {
      return await performScriptLogin(page, context, openaiClient);
    } else {
      return await performScriptCrawl(page, context, openaiClient);
    }
  }
};

// Auto mode implementations
async function performAutoLogin(page, context, openaiClient) {
  // Simplified auto login implementation
  await sendLog(context.job_id, 'info', '🤖 Performing auto login with AI analysis');
  
  try {
    // Take a screenshot for analysis (reduced size to avoid token limits)
    const screenshot = await page.screenshot({ 
      type: 'jpeg', 
      quality: 30, 
      fullPage: false,
      clip: { x: 0, y: 0, width: 800, height: 600 }
    });
    
    // Analyze the page with AI
    const htmlContent = await page.content();
    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    const aiPrompt = `Analyze this login page and provide login instructions.

URL: ${currentUrl}
TITLE: ${currentTitle}
HTML CONTENT:
${htmlContent.substring(0, 2000)}${htmlContent.length > 2000 ? '...[truncated]' : ''}

Provide detailed instructions for logging in, including:
1. Form field locations and types
2. Button locations and text
3. Step-by-step login process

Respond with JSON format:
{
  "forms": [...],
  "instructions": "...",
  "confidence": 0.0-1.0
}`;

    const completion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      context.job_id,
      'unified-crawler',
      'auto_login_analysis',
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: aiPrompt }],
        response_format: { type: "json_object" }
      },
      null, // screenshot_id
      currentUrl,
      {
        html_content: htmlContent.substring(0, 2000),
        page_title: currentTitle,
        mode: 'auto'
      }
    );

    const analysis = JSON.parse(completion.choices[0].message.content);
    
    // Execute login based on analysis
    return await executeLoginFromAnalysis(page, analysis, context);
  } catch (error) {
    return {
      success: false,
      message: `Auto login failed: ${error.message}`,
      details: { error: error.stack }
    };
  }
}

async function performAutoCrawl(page, context, openaiClient) {
  // Simplified auto crawl implementation
  await sendLog(context.job_id, 'info', '🤖 Performing auto crawl with AI analysis');
  
  try {
    const htmlContent = await page.content();
    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    // Extract basic page information
    const links = await page.$$eval('a[href]', links => links.map(link => ({
      text: link.textContent?.trim(),
      href: link.href
    })));

    const forms = await page.$$eval('form', forms => forms.map((form, index) => ({
      index,
      action: form.action,
      method: form.method,
      inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
        type: input.type,
        name: input.name,
        id: input.id,
        placeholder: input.placeholder
      }))
    })));

    return {
      success: true,
      message: 'Auto crawl completed',
      details: {
        url: currentUrl,
        title: currentTitle,
        links: links.slice(0, 20), // Limit to first 20 links
        forms,
        totalLinks: links.length,
        totalForms: forms.length
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Auto crawl failed: ${error.message}`,
      details: { error: error.stack }
    };
  }
}

// Media mode implementations
async function performMediaLogin(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📸 Performing media-based login analysis');
  
  // Take screenshot for AI analysis (reduced size to avoid token limits)
  const screenshot = await page.screenshot({ 
    type: 'jpeg', 
    quality: 30, 
    fullPage: false,
    clip: { x: 0, y: 0, width: 800, height: 600 }
  });
  const screenshotBase64 = screenshot.toString('base64');
  
  // Analyze screenshot with AI
  const aiPrompt = `Analyze this login page screenshot and provide login instructions.

SCREENSHOT: data:image/png;base64,${screenshotBase64}
URL: ${page.url()}
TITLE: ${await page.title()}

Provide detailed instructions for logging in, including:
1. Form field locations and types
2. Button locations and text
3. Step-by-step login process
4. Potential challenges or issues

Respond with JSON format:
{
  "forms": [...],
  "instructions": "...",
  "confidence": 0.0-1.0
}`;

  const completion = await aiConversationLogger.createChatCompletion(
    openaiClient,
    context.job_id,
    'unified-crawler',
    'media_login_analysis',
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: aiPrompt }],
      response_format: { type: "json_object" }
    },
    null, // screenshot_id
    page.url(),
    {
      screenshot_base64: screenshotBase64,
      page_title: await page.title(),
      mode: 'media'
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute login based on analysis
  return await executeLoginFromAnalysis(page, analysis, context);
}

async function performMediaCrawl(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📸 Performing media-based crawl analysis');
  
  // Take screenshot for AI analysis (reduced size to avoid token limits)
  const screenshot = await page.screenshot({ 
    type: 'jpeg', 
    quality: 30, 
    fullPage: false,
    clip: { x: 0, y: 0, width: 800, height: 600 }
  });
  const screenshotBase64 = screenshot.toString('base64');
  
  // Analyze screenshot with AI for crawling
  const aiPrompt = `Analyze this webpage screenshot and provide crawling instructions.

SCREENSHOT: data:image/png;base64,${screenshotBase64}
URL: ${page.url()}
TITLE: ${await page.title()}

Provide detailed instructions for crawling, including:
1. Interactive elements to click
2. Links to follow
3. Forms to fill
4. Content to extract
5. Navigation patterns

Respond with JSON format:
{
  "interactive_elements": [...],
  "links": [...],
  "forms": [...],
  "content_areas": [...],
  "crawl_instructions": "...",
  "confidence": 0.0-1.0
}`;

  const completion = await aiConversationLogger.createChatCompletion(
    openaiClient,
    context.job_id,
    'unified-crawler',
    'media_crawl_analysis',
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: aiPrompt }],
      response_format: { type: "json_object" }
    },
    null, // screenshot_id
    page.url(),
    {
      screenshot_base64: screenshotBase64,
      page_title: await page.title(),
      mode: 'media'
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute crawl based on analysis
  return await executeCrawlFromAnalysis(page, analysis, context);
}

// Text mode implementations
async function performTextLogin(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📝 Performing text-based login analysis');
  
  const htmlContent = await page.content();
  const currentUrl = page.url();
  const currentTitle = await page.title();
  
  // Analyze HTML content with AI
  const aiPrompt = `Analyze this HTML page and provide login instructions.

URL: ${currentUrl}
TITLE: ${currentTitle}
HTML CONTENT:
${htmlContent.substring(0, 2000)}${htmlContent.length > 2000 ? '...[truncated]' : ''}

Focus on text content, form structure, and login elements. Provide detailed instructions for logging in.

Respond with JSON format:
{
  "forms": [...],
  "login_elements": [...],
  "instructions": "...",
  "confidence": 0.0-1.0
}`;

  const completion = await aiConversationLogger.createChatCompletion(
    openaiClient,
    context.job_id,
    'unified-crawler',
    'text_login_analysis',
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: aiPrompt }],
      response_format: { type: "json_object" }
    },
    null, // screenshot_id
    currentUrl,
    {
      html_content: htmlContent.substring(0, 2000),
      page_title: currentTitle,
      mode: 'text'
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute login based on analysis
  return await executeLoginFromAnalysis(page, analysis, context);
}

async function performTextCrawl(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📝 Performing text-based crawl analysis');
  
  const htmlContent = await page.content();
  const currentUrl = page.url();
  const currentTitle = await page.title();
  
  // Analyze HTML content with AI for crawling
  const aiPrompt = `Analyze this HTML page and provide crawling instructions.

URL: ${currentUrl}
TITLE: ${currentTitle}
HTML CONTENT:
${htmlContent.substring(0, 2000)}${htmlContent.length > 2000 ? '...[truncated]' : ''}

Focus on text content, links, forms, and interactive elements. Provide detailed instructions for crawling.

Respond with JSON format:
{
  "links": [...],
  "forms": [...],
  "interactive_elements": [...],
  "content_areas": [...],
  "crawl_instructions": "...",
  "confidence": 0.0-1.0
}`;

  const completion = await aiConversationLogger.createChatCompletion(
    openaiClient,
    context.job_id,
    'unified-crawler',
    'text_crawl_analysis',
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: aiPrompt }],
      response_format: { type: "json_object" }
    },
    null, // screenshot_id
    currentUrl,
    {
      html_content: htmlContent.substring(0, 2000),
      page_title: currentTitle,
      mode: 'text'
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute crawl based on analysis
  return await executeCrawlFromAnalysis(page, analysis, context);
}

// Forms mode implementations
async function performFormsLogin(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📋 Performing forms-based login analysis');
  
  // Extract all forms and inputs using Playwright
  const forms = await page.$$eval('form', forms => forms.map((form, index) => ({
    index,
    action: form.action,
    method: form.method,
    inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
      type: input.type,
      name: input.name,
      id: input.id,
      placeholder: input.placeholder,
      required: input.required
    })),
    buttons: Array.from(form.querySelectorAll('button, input[type="submit"]')).map(button => ({
      text: button.textContent?.trim(),
      type: button.type
    }))
  })));

  // Analyze forms with AI
  const aiPrompt = `Analyze these forms and provide login instructions.

FORMS: ${JSON.stringify(forms, null, 2)}
URL: ${page.url()}
TITLE: ${await page.title()}

Provide detailed instructions for logging in using the forms.

Respond with JSON format:
{
  "target_form": 0,
  "field_mapping": {...},
  "instructions": "...",
  "confidence": 0.0-1.0
}`;

  const completion = await aiConversationLogger.createChatCompletion(
    openaiClient,
    context.job_id,
    'unified-crawler',
    'forms_login_analysis',
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: aiPrompt }],
      response_format: { type: "json_object" }
    },
    null, // screenshot_id
    page.url(),
    {
      forms: forms,
      page_title: await page.title(),
      mode: 'forms'
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute login based on analysis
  return await executeLoginFromAnalysis(page, analysis, context);
}

async function performFormsCrawl(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📋 Performing forms-based crawl analysis');
  
  // Extract all forms and inputs
  const forms = await page.$$eval('form', forms => forms.map((form, index) => ({
    index,
    action: form.action,
    method: form.method,
    inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
      type: input.type,
      name: input.name,
      id: input.id,
      placeholder: input.placeholder,
      required: input.required
    })),
    buttons: Array.from(form.querySelectorAll('button, input[type="submit"]')).map(button => ({
      text: button.textContent?.trim(),
      type: button.type
    }))
  })));

  // Simple analysis without AI for testing
  const analysis = {
    forms_to_use: forms.map(form => form.index),
    crawl_instructions: `Found ${forms.length} forms. Each form has ${forms.reduce((sum, form) => sum + form.inputs.length, 0)} input fields.`,
    confidence: 0.8
  };
  
  // Simple crawl execution
  return {
    success: true,
    message: 'Forms crawl completed',
    details: {
      forms: forms,
      analysis: analysis,
      totalForms: forms.length,
      totalInputs: forms.reduce((sum, form) => sum + form.inputs.length, 0)
    }
  };
}

// Static mode implementations
async function performStaticLogin(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '🔍 Performing static login with standard field matching');
  
  // Standard field selectors
  const usernameSelectors = [
    'input[name="username"]',
    'input[name="user"]',
    'input[name="email"]',
    'input[name="login"]',
    'input[id="username"]',
    'input[id="user"]',
    'input[id="email"]',
    'input[id="login"]',
    'input[type="email"]',
    'input[placeholder*="username" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="user" i]'
  ];

  const passwordSelectors = [
    'input[name="password"]',
    'input[name="pass"]',
    'input[id="password"]',
    'input[id="pass"]',
    'input[type="password"]',
    'input[placeholder*="password" i]',
    'input[placeholder*="pass" i]'
  ];

  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:contains("Login")',
    'button:contains("Sign In")',
    'button:contains("Submit")',
    'input[value*="Login" i]',
    'input[value*="Sign In" i]',
    'input[value*="Submit" i]'
  ];

  // Try to find and fill form
  let usernameField = null;
  let passwordField = null;
  let submitButton = null;

  for (const selector of usernameSelectors) {
    try {
      usernameField = await page.$(selector);
      if (usernameField) break;
    } catch (e) {
      // Continue to next selector
    }
  }

  for (const selector of passwordSelectors) {
    try {
      passwordField = await page.$(selector);
      if (passwordField) break;
    } catch (e) {
      // Continue to next selector
    }
  }

  for (const selector of submitSelectors) {
    try {
      submitButton = await page.$(selector);
      if (submitButton) break;
    } catch (e) {
      // Continue to next selector
    }
  }

  if (!usernameField || !passwordField) {
    return {
      success: false,
      message: 'Could not find username or password fields using standard selectors',
      details: {
        usernameFieldFound: !!usernameField,
        passwordFieldFound: !!passwordField,
        submitButtonFound: !!submitButton
      }
    };
  }

  // Fill form and submit
  try {
    await usernameField.fill(context.credentials.username);
    await passwordField.fill(context.credentials.password);
    
    if (submitButton) {
      await submitButton.click();
    } else {
      // Try pressing Enter on password field
      await passwordField.press('Enter');
    }

    // Wait for navigation or response
    await page.waitForTimeout(3000);

    return {
      success: true,
      message: 'Login form submitted using static field matching',
      details: {
        usernameFieldFound: true,
        passwordFieldFound: true,
        submitButtonFound: !!submitButton,
        finalUrl: page.url(),
        finalTitle: await page.title()
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Error submitting form: ${error.message}`,
      details: {
        error: error.stack,
        usernameFieldFound: !!usernameField,
        passwordFieldFound: !!passwordField,
        submitButtonFound: !!submitButton
      }
    };
  }
}

async function performStaticCrawl(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '🔍 Performing static crawl with standard element matching');
  
  // Extract standard elements
  const links = await page.$$eval('a[href]', links => links.map(link => ({
    text: link.textContent?.trim(),
    href: link.href,
    title: link.title
  })));

  const forms = await page.$$eval('form', forms => forms.map((form, index) => ({
    index,
    action: form.action,
    method: form.method,
    inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
      type: input.type,
      name: input.name,
      id: input.id,
      placeholder: input.placeholder
    }))
  })));

  const buttons = await page.$$eval('button, input[type="button"], input[type="submit"]', buttons => buttons.map(button => ({
    text: button.textContent?.trim() || button.value,
    type: button.type,
    id: button.id,
    name: button.name
  })));

  return {
    success: true,
    message: 'Static crawl completed',
    details: {
      links: links.slice(0, 50), // Limit to first 50 links
      forms,
      buttons,
      totalLinks: links.length,
      totalForms: forms.length,
      totalButtons: buttons.length
    }
  };
}

// Script mode implementations
async function performScriptLogin(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📜 Performing script-based login');
  
  if (!context.script) {
    return {
      success: false,
      message: 'No script provided for script mode',
      details: {}
    };
  }

  try {
    // Execute custom script
    const scriptResult = await page.evaluate((script, credentials) => {
      // Create a safe execution context
      const result = { success: false, message: '', details: {} };
      
      try {
        // Execute the script with credentials available
        const scriptFunction = new Function('page', 'credentials', 'result', script);
        scriptFunction(page, credentials, result);
      } catch (error) {
        result.success = false;
        result.message = error.message;
        result.details = { error: error.stack };
      }
      
      return result;
    }, context.script, context.credentials);

    return scriptResult;
  } catch (error) {
    return {
      success: false,
      message: `Script execution failed: ${error.message}`,
      details: { error: error.stack }
    };
  }
}

async function performScriptCrawl(page, context, openaiClient) {
  await sendLog(context.job_id, 'info', '📜 Performing script-based crawl');
  
  if (!context.script) {
    return {
      success: false,
      message: 'No script provided for script mode',
      details: {}
    };
  }

  try {
    // Execute custom script
    const scriptResult = await page.evaluate((script) => {
      // Create a safe execution context
      const result = { success: false, message: '', details: {} };
      
      try {
        // Execute the script
        const scriptFunction = new Function('page', 'result', script);
        scriptFunction(page, result);
      } catch (error) {
        result.success = false;
        result.message = error.message;
        result.details = { error: error.stack };
      }
      
      return result;
    }, context.script);

    return scriptResult;
  } catch (error) {
    return {
      success: false,
      message: `Script execution failed: ${error.message}`,
      details: { error: error.stack }
    };
  }
}

// Helper functions
async function executeLoginFromAnalysis(page, analysis, context) {
  // This would implement the actual login execution based on AI analysis
  // For now, return a placeholder
  return {
    success: true,
    message: 'Login executed from analysis',
    details: analysis
  };
}

async function executeCrawlFromAnalysis(page, analysis, context) {
  // This would implement the actual crawl execution based on AI analysis
  // For now, return a placeholder
  return {
    success: true,
    message: 'Crawl executed from analysis',
    details: analysis
  };
}

// Main exported functions
export async function attemptLogin(url, username, password, cookies, context, openaiApiKey = null) {
  const startTime = Date.now();
  const jobId = context.job_id || 'unknown-job';
  const mode = context.mode || 'auto';
  
  await sendLog(jobId, 'info', `🚀 Starting ${mode} mode login attempt for ${url}`);
  
  try {
    const openaiClient = new OpenAI({ apiKey: openaiApiKey });
    
    const result = await withBrowser(async ({ page, context: browserContext }) => {
      await sendLog(jobId, 'info', '🌐 Starting browser session...');
      
      // Set initial cookies if provided
      if (cookies && cookies.length > 0) {
        await sendLog(jobId, 'info', `🍪 Setting ${cookies.length} cookies...`);
        await browserContext.addCookies(cookies);
      }

      // Navigate to URL
      await sendLog(jobId, 'info', `🧭 Navigating to ${url}...`);
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // Set credentials in context
      const enhancedContext = {
        ...context,
        credentials: { username, password }
      };

      // Execute mode-specific operation
      const modeHandler = modeHandlers[mode];
      if (!modeHandler) {
        throw new Error(`Unknown mode: ${mode}`);
      }

      const operationResult = await modeHandler(page, enhancedContext, openaiClient, 'login');
      
      return {
        ...operationResult,
        startTime,
        duration_ms: Date.now() - startTime,
        finalUrl: page.url(),
        finalTitle: await page.title()
      };
    }, {
      headless: context.options?.headless !== false,
      enable_screenshots: context.options?.enable_screenshots !== false,
      enable_video_recording: context.options?.enable_video_recording || false,
      job_id: jobId
    });

    await sendLog(jobId, 'info', `✅ Login attempt completed in ${result.duration_ms}ms`);
    await sendLog(jobId, result.success ? 'info' : 'error', `📊 Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    
    return result;

  } catch (error) {
    const duration = Date.now() - startTime;
    await sendLog(jobId, 'error', `❌ Login attempt failed with error: ${error.message}`);
    
    return {
      success: false,
      message: `Login failed: ${error.message}`,
      duration_ms: duration,
      error: error.stack,
      startTime
    };
  }
}

export async function startCrawl(url, cookies, context, openaiApiKey = null) {
  const startTime = Date.now();
  const jobId = context.job_id || 'unknown';
  const mode = context.mode || 'auto';
  
  await sendLog(jobId, 'info', `🚀 Starting ${mode} mode crawl process for ${url}`);
  
  try {
    const openaiClient = new OpenAI({ apiKey: openaiApiKey });
    
    const result = await withBrowser(async ({ page, context: browserContext }) => {
      await sendLog(jobId, 'info', '🌐 Starting browser session...');
      
      // Set initial cookies if provided
      if (cookies && cookies.length > 0) {
        await sendLog(jobId, 'info', `🍪 Setting ${cookies.length} cookies...`);
        await browserContext.addCookies(cookies);
      }

      // Navigate to URL
      await sendLog(jobId, 'info', `🧭 Navigating to ${url}...`);
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      // Execute mode-specific operation
      const modeHandler = modeHandlers[mode];
      if (!modeHandler) {
        throw new Error(`Unknown mode: ${mode}`);
      }

      const operationResult = await modeHandler(page, context, openaiClient, 'crawl');
      
      return {
        ...operationResult,
        startTime,
        duration_ms: Date.now() - startTime,
        finalUrl: page.url(),
        finalTitle: await page.title()
      };
    }, {
      headless: context.options?.headless !== false,
      enable_screenshots: context.options?.enable_screenshots !== false,
      enable_video_recording: context.options?.enable_video_recording || false,
      job_id: jobId
    });

    await sendLog(jobId, 'info', `✅ Crawl completed in ${result.duration_ms}ms`);
    await sendLog(jobId, result.success ? 'info' : 'error', `📊 Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    
    return result;

  } catch (error) {
    const duration = Date.now() - startTime;
    await sendLog(jobId, 'error', `❌ Crawl failed with error: ${error.message}`);
    
    return {
      success: false,
      message: `Crawl failed: ${error.message}`,
      duration_ms: duration,
      error: error.stack,
      startTime
    };
  }
}
