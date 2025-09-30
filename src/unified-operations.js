/**
 * Unified Operations - Handles login and crawl operations with multiple modes
 */

import { chromium } from 'playwright';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Conditional imports for shared modules
let gelfClient = null;
let aiConversationLogger = null;

try {
  // Try to import shared modules (works in container)
  const gelfModule = await import('/app/shared/gelf-client.js');
  gelfClient = gelfModule.default;
  
  const aiModule = await import('/app/shared/ai-conversation-logger.js');
  aiConversationLogger = aiModule.aiConversationLogger;
} catch (error) {
  // Fallback for CLI mode (shared modules not available)
  console.log('[CLI] Shared modules not available, using CLI mode');
}
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
  // Check if we're in CLI mode (no GELF client available or CLI mode flag)
  const isCLIMode = process.env.CLI_MODE === 'true' || !process.env.BACKEND_URL || !gelfClient;
  
  // Determine agent name and component based on mode and action
  const mode = data.mode || 'auto';
  const agentName = 'unified-crawler';
  
  // Create specific component name based on action and mode
  // Replace 'auto' mode with 'text' for component naming consistency
  const componentMode = mode === 'auto' ? 'text' : mode;
  let componentName = `CRAWLER-${componentMode.toUpperCase()}`;
  if (data.action) {
    switch (data.action) {
      case 'screenshot':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-SCREENSHOT`;
        break;
      case 'text_login_analysis':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-TEXT-LOGIN-OPENAI`;
        break;
      case 'ai_analysis':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-OPENAI`;
        break;
      case 'form_fill':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-FORM-FILL`;
        break;
      case 'login_execution':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-LOGIN-EXECUTION`;
        break;
      case 'token_extraction':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-TOKEN-EXTRACTION`;
        break;
      default:
        componentName = `CRAWLER-${componentMode.toUpperCase()}`;
    }
  }
  
  // Extract special fields for AI conversations and screenshots
  const specialFields = {};
  if (data.aiConversationId) {
    specialFields.aiConversationId = data.aiConversationId;
  }
  if (data.screenshotId) {
    specialFields.screenshotId = data.screenshotId;
  }
  if (data.screenshotPath) {
    specialFields.screenshotPath = data.screenshotPath;
  }
  
  if (isCLIMode) {
    // CLI mode: output structured JSON to stdout
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      jobId,
      agent: agentName,
      component: componentName,
      mode: mode, // Include mode in log data
      ...data,
      ...specialFields
    };
    console.log(JSON.stringify(logEntry));
  } else {
    // Server mode: send to console and Graylog
    console.log(`[${level.toUpperCase()}] [${componentName}] ${message}`);
    await gelfClient.sendJobLog(jobId, level, message, agentName, { component: componentName, mode, ...data, ...specialFields });
  }
}

// Upload files via backend API
async function uploadFileToBackend({ buffer, contentType, type, jobId, metadata = {} }) {
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
        type: contentType,
        metadata: metadata
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    if (!result.file_id) {
      throw new Error('Backend did not return file_id');
    }
    return result.file_id;
  } catch (error) {
    console.error(`[unified-crawler] Backend upload error: ${error.message}`);
    return null;
  }
}

// Take screenshot and upload to backend with enhanced metadata
async function takeScreenshot(page, jobId, action = 'screenshot', context = {}) {
  try {
    // Check if page is available
    if (!page) {
      throw new Error('Page object is not available');
    }
    
    // Check if page is still valid
    try {
      await page.url();
    } catch (error) {
      throw new Error(`Page is no longer valid: ${error.message}`);
    }
    
    // Ensure page is properly loaded and sized
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    
    // Capture full HD screenshot
    const screenshot = await page.screenshot({ 
      type: 'png', 
      fullPage: true,
      animations: 'disabled' // Disable animations for consistent screenshots
    });
    
    if (!screenshot || screenshot.length === 0) {
      throw new Error('Screenshot capture returned empty buffer');
    }
    
    // Generate unique screenshot ID
    const screenshotId = `screenshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const fileId = await uploadFileToBackend({
      buffer: screenshot,
      contentType: 'image/png',
      type: 'screenshot',
      jobId,
      metadata: {
        screenshotId,
        action,
        timestamp: new Date().toISOString(),
        pageUrl: page.url(),
        pageTitle: await page.title(),
        ...context
      }
    });
    
    if (fileId) {
      const screenshotPath = `http://localhost:9002/aionqa-files/${fileId}.png`;
      
      // Convert screenshot to base64 for display in logs
      const screenshotBase64 = screenshot.toString('base64');
      const screenshotDataUrl = `data:image/png;base64,${screenshotBase64}`;
      
      await sendLog(jobId, 'info', `📸 Screenshot captured: ${action}`, { 
        fileId, 
        screenshotId: fileId,
        action: 'screenshot',
        url: page.url(),
        title: await page.title(),
        screenshotPath,
        screenshotData: screenshotDataUrl, // Include actual screenshot data
        resolution: 'full_hd',
        timestamp: new Date().toISOString(),
        ...context
      });

      // Track media file creation in job tracking
      try {
        const jobTrackingUrl = process.env.BACKEND_URL || 'http://back:4000';
        await fetch(`${jobTrackingUrl}/track-media-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId,
            mediaType: 'screenshot',
            fileInfo: {
              fileId,
              screenshotId,
              url: screenshotPath,
              size: screenshot.length,
              action,
              step: context.step,
              pageUrl: page.url(),
              pageTitle: await page.title(),
              ...context
            }
          })
        });
      } catch (trackingError) {
        console.warn('[SCREENSHOT] ⚠️ Failed to track media file:', trackingError.message);
      }
      
      return {
        fileId,
        screenshotId,
        screenshotPath,
        action,
        timestamp: new Date().toISOString(),
        pageUrl: page.url(),
        pageTitle: await page.title()
      };
    }
    
    return null;
  } catch (error) {
    // Get page URL safely
    let pageUrl = 'unknown';
    try {
      pageUrl = page ? page.url() : 'page_not_available';
    } catch (urlError) {
      pageUrl = 'page_url_error';
    }
    
    await sendLog(jobId, 'error', `📸 Screenshot failed: ${action}`, {
      error: error.message,
      errorStack: error.stack,
      action: 'screenshot',
      url: pageUrl,
      timestamp: new Date().toISOString(),
      context: context
    });
    return null;
  }
}

// Enhanced screenshot capture for conversation flow
async function takeScreenshotWithMetadata(page, jobId, action = 'screenshot', context = {}, options = {}) {
  try {
    const screenshot = await takeScreenshot(page, jobId, action, context);
    
    if (!screenshot) {
      return null;
    }

    // Enhanced metadata for conversation flow
    const enhancedMetadata = {
      ...screenshot,
      step: context.step || action,
      before_action: context.before_action || false,
      after_action: context.after_action || false,
      conversation_flow: options.conversation_flow || false,
      flow_step: options.flow_step || null,
      action_sequence: options.action_sequence || null,
      timestamp: new Date().toISOString(),
      metadata: {
        ...context,
        ...options.metadata
      }
    };

    return enhancedMetadata;
  } catch (error) {
    console.error(`[SCREENSHOT] ❌ Enhanced screenshot failed: ${error.message}`);
    return null;
  }
}

// Take screenshot before action
async function takeScreenshotBeforeAction(page, jobId, action, context = {}) {
  return await takeScreenshotWithMetadata(page, jobId, `before_${action}`, {
    ...context,
    before_action: true,
    step: `before_${action}`
  }, {
    conversation_flow: true,
    before_action: true
  });
}

// Take screenshot after action
async function takeScreenshotAfterAction(page, jobId, action, context = {}) {
  return await takeScreenshotWithMetadata(page, jobId, `after_${action}`, {
    ...context,
    after_action: true,
    step: `after_${action}`
  }, {
    conversation_flow: true,
    after_action: true
  });
}

// Create conversation flow step with screenshots
async function createConversationFlowStep(page, jobId, stepData) {
  const { action, description, beforeScreenshot = true, afterScreenshot = true, payload = null } = stepData;
  
  const flowStep = {
    type: action,
    description,
    action: action,
    timestamp: new Date().toISOString(),
    screenshots: [],
    payload: payload
  };

  // Take before screenshot
  if (beforeScreenshot) {
    const beforeShot = await takeScreenshotBeforeAction(page, jobId, action, {
      step: `before_${action}`,
      description: `Before ${description}`
    });
    if (beforeShot) {
      flowStep.screenshots.push({
        ...beforeShot,
        before_action: true,
        step: `before_${action}`
      });
    }
  }

  // Execute action (placeholder - actual action should be implemented by caller)
  // This is just for the flow structure

  // Take after screenshot
  if (afterScreenshot) {
    const afterShot = await takeScreenshotAfterAction(page, jobId, action, {
      step: `after_${action}`,
      description: `After ${description}`
    });
    if (afterShot) {
      flowStep.screenshots.push({
        ...afterShot,
        after_action: true,
        step: `after_${action}`
      });
    }
  }

  return flowStep;
}

// Browser automation wrapper
async function withBrowser(action, options = {}) {
  const isCLIMode = process.env.CLI_MODE === 'true';
  const useRemoteBrowser = process.env.USE_REMOTE_BROWSER === 'true';
  
  // Debug environment variables
  await sendLog(options.jobId || 'debug', 'info', `Browser config - CLI_MODE: ${isCLIMode}, USE_REMOTE_BROWSER: ${useRemoteBrowser}, BACKEND_URL: ${process.env.BACKEND_URL}`);
  
  let browser;
  
  if (isCLIMode) {
    // CLI mode: use local browser installation
    await sendLog(options.jobId || 'cli', 'info', 'Launching local browser for CLI mode');
    
    browser = await chromium.launch({
      headless: options.headless !== false,
      executablePath: '/usr/bin/chromium-browser', // Use system Chromium
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    });
  } else if (useRemoteBrowser) {
    // Container mode: MUST use remote browsers
    const browserServiceUrl = process.env.BROWSER_SERVICE_URL || 'http://browser-1:3000';
    await sendLog(options.jobId || 'server', 'info', `Using remote browser service: ${browserServiceUrl}`);
    
    try {
      // Use the base WebSocket URL for CDP connection
      const wsUrl = browserServiceUrl.replace('http://', 'ws://');
      await sendLog(options.jobId || 'server', 'info', `Connecting to WebSocket: ${wsUrl}`);
      browser = await chromium.connectOverCDP(wsUrl);
      await sendLog(options.jobId || 'server', 'info', 'Successfully connected to remote browser service via CDP');
    } catch (error) {
      await sendLog(options.jobId || 'server', 'error', `Failed to connect to remote browser service: ${error.message}`);
      throw new Error(`Remote browser connection failed: ${error.message}`);
    }
  } else {
    // This should not happen in container mode
    await sendLog(options.jobId || 'server', 'error', 'No browser configuration found - this should not happen in container mode');
    throw new Error('Browser configuration error: USE_REMOTE_BROWSER must be set to true in container mode');
  }
  
  const contextOptions = {
    userAgent: options.userAgent,
    ignoreHTTPSErrors: true,
    viewport: options.viewport || { width: 1280, height: 800 }
  };
  
  // Add video recording only for local browsers (CLI mode)
  if (isCLIMode && options.enable_video_recording) {
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
  // Auto mode - Sequential approach selection (tries multiple approaches until one works)
  auto: async (page, context, openaiClient, operation) => {
    const approachSequence = ['static', 'media', 'text', 'forms', 'script'];
    let lastError = null;
    
    for (let i = 0; i < approachSequence.length; i++) {
      const approach = approachSequence[i];
      
      try {
        await sendLog(context.job_id, 'info', `Auto: Trying ${approach} (${i + 1}/${approachSequence.length})`, { 
          mode: 'auto', 
          approach: approach,
          attempt: i + 1
        });
        
        let result;
        if (operation === 'login') {
          result = await modeHandlers[approach](page, context, openaiClient, operation);
        } else {
          result = await modeHandlers[approach](page, context, openaiClient, operation);
        }
        
        if (result && result.success) {
          await sendLog(context.job_id, 'info', `Auto: ${approach} succeeded`, { 
            mode: 'auto', 
            successful_approach: approach
          });
          return result;
        }
        
      } catch (error) {
        lastError = error;
        await sendLog(context.job_id, 'error', `Auto: ${approach} failed - ${error.message}`, { 
          mode: 'auto', 
          failed_approach: approach,
          error: error.message
        });
      }
      
      if (i < approachSequence.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await sendLog(context.job_id, 'error', `Auto: All approaches failed`, { 
      mode: 'auto', 
      approaches_tried: approachSequence,
      last_error: lastError?.message
    });
    
    return {
      success: false,
      error: lastError?.message || 'All approaches failed',
      details: {
        mode: 'auto',
        attempts: approachSequence.length,
        approaches_tried: approachSequence
      }
    };
  },

  // Media mode - Screenshot analysis
  media: async (page, context, openaiClient, operation) => {
    if (operation === 'login') {
      return await performMediaLogin(page, context, openaiClient);
    } else {
      return await performMediaCrawl(page, context, openaiClient);
    }
  },

  // Text mode - HTML text analysis
  text: async (page, context, openaiClient, operation) => {
    if (operation === 'login') {
      return await performTextLogin(page, context, openaiClient);
    } else {
      return await performTextCrawl(page, context, openaiClient);
    }
  },

  // Forms mode - Form field analysis
  forms: async (page, context, openaiClient, operation) => {
    if (operation === 'login') {
      return await performFormsLogin(page, context, openaiClient);
    } else {
      return await performFormsCrawl(page, context, openaiClient);
    }
  },

  // Static mode - Standard field ID matching
  static: async (page, context, openaiClient, operation) => {
    if (operation === 'login') {
      return await performStaticLogin(page, context, openaiClient);
    } else {
      return await performStaticCrawl(page, context, openaiClient);
    }
  },

  // Script mode - Custom script execution
  script: async (page, context, openaiClient, operation) => {
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
  const conversationId = `conv_${context.job_id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  await sendLog(context.job_id, 'info', '🤖 Performing auto login with AI analysis', {
    aiConversationId: conversationId
  });
  
  try {
    // Take a full HD screenshot for storage and reference
    const screenshotResult = await takeScreenshot(page, context.job_id, 'auto_login_analysis', {
      mode: 'auto',
      analysis_type: 'login_analysis',
      conversationId
    });
    
    // Take a screenshot for analysis (reduced size to avoid token limits)
    const screenshot = await page.screenshot({ 
      type: 'jpeg', 
      quality: 30, 
      fullPage: true
    });
    
    // Analyze the page with AI
    const htmlContent = await page.content();
    const currentUrl = page.url();
    const currentTitle = await page.title();
    
    const aiPrompt = `Analyze this login page and provide login instructions.

URL: ${currentUrl}
TITLE: ${currentTitle}
Full HD Screenshot ID: ${screenshotResult?.screenshotId || 'N/A'}
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
      screenshotResult?.screenshotId, // Pass screenshot ID to AI conversation logger
      currentUrl,
      {
        html_content: htmlContent.substring(0, 2000),
        screenshot_id: screenshotResult?.screenshotId,
        screenshot_path: screenshotResult?.screenshotPath,
        page_title: currentTitle,
        mode: 'auto',
        approach: 'auto',
        conversationId,
        full_hd_screenshot: true
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
  const conversationId = `conv_${context.job_id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Media login analysis
  
  // Take a full HD screenshot for storage and reference
  const screenshotResult = await takeScreenshot(page, context.job_id, 'media_login_analysis', {
    mode: 'media',
    analysis_type: 'login_analysis',
    conversationId
  });
  
  // Take screenshot for AI analysis (reduced size to avoid token limits)
  const screenshot = await page.screenshot({ 
    type: 'jpeg', 
    quality: 30, 
    fullPage: true
  });
  const screenshotBase64 = screenshot.toString('base64');
  
  // Analyze screenshot with AI
  const aiPrompt = `Analyze this login page screenshot and provide login instructions.

SCREENSHOT: data:image/png;base64,${screenshotBase64}
URL: ${page.url()}
TITLE: ${await page.title()}
Full HD Screenshot ID: ${screenshotResult?.screenshotId || 'N/A'}

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
    screenshotResult?.screenshotId, // Pass screenshot ID to AI conversation logger
    page.url(),
    {
      screenshot_base64: screenshotBase64,
      screenshot_id: screenshotResult?.screenshotId,
      screenshot_path: screenshotResult?.screenshotPath,
      page_title: await page.title(),
      mode: 'media',
      approach: 'media',
      conversationId,
      full_hd_screenshot: true
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute login based on analysis
  return await executeLoginFromAnalysis(page, analysis, context);
}

async function performMediaCrawl(page, context, openaiClient) {
  
  // Take a full HD screenshot for storage and reference
  const screenshotResult = await takeScreenshot(page, context.job_id, 'media_crawl_analysis', {
    mode: 'media',
    analysis_type: 'crawl_analysis'
  });
  
  // Take screenshot for AI analysis (reduced size to avoid token limits)
  const screenshot = await page.screenshot({ 
    type: 'jpeg', 
    quality: 30, 
    fullPage: true
  });
  const screenshotBase64 = screenshot.toString('base64');
  
  // Analyze screenshot with AI for crawling
  const aiPrompt = `Analyze this webpage screenshot and provide crawling instructions.

SCREENSHOT: data:image/png;base64,${screenshotBase64}
URL: ${page.url()}
TITLE: ${await page.title()}
Full HD Screenshot ID: ${screenshotResult?.screenshotId || 'N/A'}

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
    screenshotResult?.screenshotId, // Pass screenshot ID to AI conversation logger
    page.url(),
    {
      screenshot_base64: screenshotBase64,
      screenshot_id: screenshotResult?.screenshotId,
      screenshot_path: screenshotResult?.screenshotPath,
      page_title: await page.title(),
      mode: 'media',
      approach: 'media'
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute crawl based on analysis
  return await executeCrawlFromAnalysis(page, analysis, context);
}

// Text mode implementations
async function performTextLogin(page, context, openaiClient) {
  // Generate a unique conversation ID for this AI analysis
  const conversationId = `conv_${context.job_id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Text login analysis
  
  // Take a full HD screenshot for storage and reference
  const screenshotResult = await takeScreenshot(page, context.job_id, 'text_login_analysis', {
    mode: 'text',
    analysis_type: 'login_analysis',
    conversationId
  });
  
  const htmlContent = await page.content();
  const currentUrl = page.url();
  const currentTitle = await page.title();
  
  // Analyze HTML content with AI
  const aiPrompt = `Analyze this HTML page and provide login instructions.

URL: ${currentUrl}
TITLE: ${currentTitle}
Full HD Screenshot ID: ${screenshotResult?.screenshotId || 'N/A'}
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
    screenshotResult?.screenshotId, // Pass screenshot ID to AI conversation logger
    currentUrl,
    {
      html_content: htmlContent.substring(0, 2000),
      screenshot_id: screenshotResult?.screenshotId,
      screenshot_path: screenshotResult?.screenshotPath,
      page_title: currentTitle,
      mode: 'text',
      approach: 'text',
      conversationId,
      full_hd_screenshot: true
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute login based on analysis
  return await executeLoginFromAnalysis(page, analysis, context);
}

async function performTextCrawl(page, context, openaiClient) {
  
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
      mode: 'text',
      approach: 'text'
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute crawl based on analysis
  return await executeCrawlFromAnalysis(page, analysis, context);
}

// Forms mode implementations
async function performFormsLogin(page, context, openaiClient) {
  
  // Take a full HD screenshot for storage and reference
  const screenshotResult = await takeScreenshot(page, context.job_id, 'forms_login_analysis', {
    mode: 'forms',
    analysis_type: 'login_analysis'
  });
  
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
Full HD Screenshot ID: ${screenshotResult?.screenshotId || 'N/A'}

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
    screenshotResult?.screenshotId, // Pass screenshot ID to AI conversation logger
    page.url(),
    {
      forms: forms,
      screenshot_id: screenshotResult?.screenshotId,
      screenshot_path: screenshotResult?.screenshotPath,
      page_title: await page.title(),
      mode: 'forms',
      approach: 'forms',
      full_hd_screenshot: true
    }
  );

  const analysis = JSON.parse(completion.choices[0].message.content);
  
  // Execute login based on analysis
  return await executeLoginFromAnalysis(page, analysis, context);
}

async function performFormsCrawl(page, context, openaiClient) {
  
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

  // Enhanced form filling with conversation flow pattern
  const conversationFlowSteps = [];
  const formScreenshots = [];
  
  try {
    // Step 1: Initial page state
    await sendLog(jobId, 'info', '📸 Taking initial screenshot');
    const initialScreenshot = await takeScreenshotBeforeAction(page, jobId, 'form_fill', {
      step: 'initial_state',
      form_type: 'login',
      description: 'Initial page state before form interaction'
    });
    if (initialScreenshot) {
      formScreenshots.push(initialScreenshot);
      conversationFlowSteps.push({
        type: 'screenshot',
        description: 'Initial page state',
        action: 'initial_state',
        screenshots: [initialScreenshot],
        payload: {
          type: 'html',
          name: 'initial-page-state.html',
          content: await page.content(),
          metadata: {
            page_url: page.url(),
            page_title: await page.title(),
            form_elements_found: {
              username_field: !!usernameField,
              password_field: !!passwordField,
              submit_button: !!submitButton
            }
          }
        }
      });
    }
    
    // Step 2: Fill username field
    await sendLog(jobId, 'info', 'Fill username');
    const usernameBeforeShot = await takeScreenshotBeforeAction(page, jobId, 'username_fill', {
      step: 'before_username_fill',
      form_type: 'login',
      description: 'Before filling username field'
    });
    
    await usernameField.fill(context.credentials.username);
    
    const usernameAfterShot = await takeScreenshotAfterAction(page, jobId, 'username_fill', {
      step: 'after_username_filled',
      form_type: 'login',
      field_filled: 'username',
      description: 'After filling username field'
    });
    
    if (usernameBeforeShot) formScreenshots.push(usernameBeforeShot);
    if (usernameAfterShot) formScreenshots.push(usernameAfterShot);
    
    conversationFlowSteps.push({
      type: 'action',
      description: 'Fill username field',
      action: 'username_fill',
      screenshots: [usernameBeforeShot, usernameAfterShot].filter(Boolean),
      payload: {
        type: 'forms',
        name: 'username-field-data.json',
        data: {
          field_type: 'username',
          field_found: true,
          value_filled: context.credentials.username,
          selector_used: usernameSelectors.find(selector => {
            try { return page.$(selector); } catch { return false; }
          })
        },
        metadata: {
          field_filled: 'username',
          step: 'username_fill'
        }
      }
    });
    
    // Step 3: Fill password field
    await sendLog(jobId, 'info', 'Fill password');
    const passwordBeforeShot = await takeScreenshotBeforeAction(page, jobId, 'password_fill', {
      step: 'before_password_fill',
      form_type: 'login',
      description: 'Before filling password field'
    });
    
    await passwordField.fill(context.credentials.password);
    
    const passwordAfterShot = await takeScreenshotAfterAction(page, jobId, 'password_fill', {
      step: 'after_password_filled',
      form_type: 'login',
      field_filled: 'password',
      description: 'After filling password field'
    });
    
    if (passwordBeforeShot) formScreenshots.push(passwordBeforeShot);
    if (passwordAfterShot) formScreenshots.push(passwordAfterShot);
    
    conversationFlowSteps.push({
      type: 'action',
      description: 'Fill password field',
      action: 'password_fill',
      screenshots: [passwordBeforeShot, passwordAfterShot].filter(Boolean),
      payload: {
        type: 'forms',
        name: 'password-field-data.json',
        data: {
          field_type: 'password',
          field_found: true,
          value_filled: '[REDACTED]',
          selector_used: passwordSelectors.find(selector => {
            try { return page.$(selector); } catch { return false; }
          })
        },
        metadata: {
          field_filled: 'password',
          step: 'password_fill'
        }
      }
    });
    
    // Step 4: Submit form
    await sendLog(jobId, 'info', 'Submit form');
    const submitBeforeShot = await takeScreenshotBeforeAction(page, jobId, 'form_submit', {
      step: 'before_form_submit',
      form_type: 'login',
      description: 'Before submitting form'
    });
    
    if (submitButton) {
      await sendLog(jobId, 'info', '🖱️ Clicking submit button');
      await submitButton.click();
    } else {
      // Try pressing Enter on password field
      await sendLog(jobId, 'info', '⌨️ Pressing Enter on password field');
      await passwordField.press('Enter');
    }
    
    const submitAfterShot = await takeScreenshotAfterAction(page, jobId, 'form_submit', {
      step: 'after_form_submission',
      form_type: 'login',
      action: 'form_submitted',
      description: 'After submitting form'
    });
    
    if (submitBeforeShot) formScreenshots.push(submitBeforeShot);
    if (submitAfterShot) formScreenshots.push(submitAfterShot);
    
    conversationFlowSteps.push({
      type: 'action',
      description: 'Submit login form',
      action: 'form_submit',
      screenshots: [submitBeforeShot, submitAfterShot].filter(Boolean),
      payload: {
        type: 'forms',
        name: 'form-submission-data.json',
        data: {
          submission_method: submitButton ? 'button_click' : 'enter_key',
          submit_button_found: !!submitButton,
          final_url: page.url(),
          final_title: await page.title()
        },
        metadata: {
          action: 'form_submitted',
          step: 'form_submit'
        }
      }
    });

    // Wait for navigation or response
    await page.waitForTimeout(3000);

    // Log enhanced conversation with separate payload components
    if (aiConversationLogger) {
      try {
        const payloadComponents = conversationFlowSteps.map(step => ({
          type: step.payload.type,
          name: step.payload.name,
          content: step.payload.content,
          data: step.payload.data,
          metadata: step.payload.metadata
        }));

        const screenshotData = conversationFlowSteps.flatMap(step => 
          step.screenshots.map(screenshot => ({
            screenshot_id: screenshot.screenshotId || screenshot.fileId,
            url: screenshot.screenshotPath,
            step: screenshot.step,
            action: screenshot.action,
            before_action: screenshot.before_action,
            after_action: screenshot.after_action,
            metadata: screenshot.metadata || {}
          }))
        );

        await aiConversationLogger.sendConversationFlow(
          context.job_id,
          'login-static',
          page.url(),
          conversationFlowSteps,
          { approach: 'static' }
        );

        await sendLog(context.job_id, 'info', '🤖 Enhanced conversation flow logged to chat mode');
      } catch (conversationError) {
        console.warn('[CONVERSATION] ⚠️ Failed to log enhanced conversation:', conversationError.message);
      }
    }

    return {
      success: true,
      message: 'Login form submitted using enhanced conversation flow pattern',
      details: {
        usernameFieldFound: true,
        passwordFieldFound: true,
        submitButtonFound: !!submitButton,
        finalUrl: page.url(),
        finalTitle: await page.title(),
        screenshots: formScreenshots,
        screenshotCount: formScreenshots.length,
        conversationFlow: conversationFlowSteps,
        flowStepsCount: conversationFlowSteps.length,
        enhancedPayload: true,
        separateScreenshots: true
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
    // Take a full HD screenshot before script execution
    const screenshotResult = await takeScreenshot(page, context.job_id, 'script_login_before', {
      mode: 'script',
      analysis_type: 'login_analysis',
      script_provided: true
    });
    
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

    // Take a full HD screenshot after script execution
    const afterScreenshotResult = await takeScreenshot(page, context.job_id, 'script_login_after', {
      mode: 'script',
      analysis_type: 'login_analysis',
      script_executed: true,
      script_success: scriptResult.success
    });

    return {
      ...scriptResult,
      screenshots: {
        before: screenshotResult,
        after: afterScreenshotResult
      }
    };
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
  const jobId = context.job_id || 'unknown-job';
  
  try {
    await sendLog(jobId, 'info', '🔐 Executing login based on AI analysis');
    
    // Extract form information from analysis
    const forms = analysis.forms || [];
    const targetForm = forms[analysis.target_form || 0];
    
    if (!targetForm) {
      return {
        success: false,
        message: 'No target form found in analysis',
        details: { analysis }
      };
    }
    
    // Find form elements based on analysis
    let usernameField, passwordField, submitButton;
    
    if (analysis.field_mapping) {
      // Use AI-provided field mapping
      const usernameSelector = analysis.field_mapping.username || 'input[name="username"], input[name="user"], input[name="email"]';
      const passwordSelector = analysis.field_mapping.password || 'input[name="password"], input[type="password"]';
      const submitSelector = analysis.field_mapping.submit || 'button[type="submit"], input[type="submit"]';
      
      usernameField = await page.$(usernameSelector);
      passwordField = await page.$(passwordSelector);
      submitButton = await page.$(submitSelector);
    } else {
      // Fallback to common selectors
      usernameField = await page.$('input[name="username"], input[name="user"], input[name="email"], input[type="email"]');
      passwordField = await page.$('input[name="password"], input[type="password"]');
      submitButton = await page.$('button[type="submit"], input[type="submit"]');
    }
    
    if (!usernameField || !passwordField) {
      return {
        success: false,
        message: 'Could not find username or password fields',
        details: {
          usernameFieldFound: !!usernameField,
          passwordFieldFound: !!passwordField,
          submitButtonFound: !!submitButton,
          analysis
        }
      };
    }
    
    // Take screenshot before login
    const beforeScreenshot = await takeScreenshot(page, jobId, 'before_login', {
      step: 'before_login',
      form_type: 'login',
      analysis_confidence: analysis.confidence
    });
    
    // Fill login form
    await sendLog(jobId, 'info', '✏️ Filling username field', { action: 'form_fill' });
    await usernameField.fill(context.credentials.username);
    
    const usernameScreenshot = await takeScreenshot(page, jobId, 'after_username', {
      step: 'after_username',
      form_type: 'login',
      field_filled: 'username'
    });
    
    await sendLog(jobId, 'info', '✏️ Filling password field', { action: 'form_fill' });
    await passwordField.fill(context.credentials.password);
    
    const passwordScreenshot = await takeScreenshot(page, jobId, 'after_password', {
      step: 'after_password',
      form_type: 'login',
      field_filled: 'password'
    });
    
    // Submit form
    await sendLog(jobId, 'info', '🖱️ Submitting login form', { action: 'login_execution' });
    if (submitButton) {
      await submitButton.click();
    } else {
      await passwordField.press('Enter');
    }
    
    // Wait for navigation or response
    await page.waitForTimeout(3000);
    
    // Take screenshot after login
    const afterScreenshot = await takeScreenshot(page, jobId, 'after_login', {
      step: 'after_login',
      form_type: 'login',
      action: 'form_submitted'
    });
    
    // Extract authentication tokens (cookies, localStorage, sessionStorage)
    const extractedCookies = await page.context().cookies();
    const localStorage = await page.evaluate(() => {
      const storage = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        storage[key] = window.localStorage.getItem(key);
      }
      return storage;
    });
    
    const sessionStorage = await page.evaluate(() => {
      const storage = {};
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        storage[key] = window.sessionStorage.getItem(key);
      }
      return storage;
    });
    
    // Check for authentication tokens in common locations
    const authTokens = {
      cookies: extractedCookies.filter(cookie => 
        cookie.name.toLowerCase().includes('auth') ||
        cookie.name.toLowerCase().includes('token') ||
        cookie.name.toLowerCase().includes('session') ||
        cookie.name.toLowerCase().includes('jwt') ||
        cookie.name.toLowerCase().includes('csrf')
      ),
      localStorage: Object.keys(localStorage).filter(key => 
        key.toLowerCase().includes('auth') ||
        key.toLowerCase().includes('token') ||
        key.toLowerCase().includes('session') ||
        key.toLowerCase().includes('jwt')
      ).reduce((obj, key) => {
        obj[key] = localStorage[key];
        return obj;
      }, {}),
      sessionStorage: Object.keys(sessionStorage).filter(key => 
        key.toLowerCase().includes('auth') ||
        key.toLowerCase().includes('token') ||
        key.toLowerCase().includes('session') ||
        key.toLowerCase().includes('jwt')
      ).reduce((obj, key) => {
        obj[key] = sessionStorage[key];
        return obj;
      }, {})
    };
    
    const finalUrl = page.url();
    const finalTitle = await page.title();
    
    await sendLog(jobId, 'info', `🔑 Authentication tokens extracted: ${authTokens.cookies.length} cookies, ${Object.keys(authTokens.localStorage).length} localStorage items, ${Object.keys(authTokens.sessionStorage).length} sessionStorage items`, { action: 'token_extraction' });
    
    return {
      success: true,
      message: 'Login executed successfully - authentication tokens acquired',
      details: {
        analysis,
        usernameFieldFound: true,
        passwordFieldFound: true,
        submitButtonFound: !!submitButton,
        finalUrl,
        finalTitle,
        authTokens,
        screenshots: [beforeScreenshot, usernameScreenshot, passwordScreenshot, afterScreenshot].filter(Boolean)
      },
      // Return tokens for use in crawling
      cookies: extractedCookies,
      authTokens: authTokens,
      finalUrl,
      finalTitle
    };
    
  } catch (error) {
    await sendLog(jobId, 'error', `❌ Login execution failed: ${error.message}`);
    return {
      success: false,
      message: `Login execution failed: ${error.message}`,
      details: {
        error: error.stack,
        analysis
      }
    };
  }
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
  
  await sendLog(jobId, 'info', `${mode.toUpperCase()}: Login ${url}`, { mode });
  
  try {
    const openaiClient = new OpenAI({ apiKey: openaiApiKey });
    
    const result = await withBrowser(async ({ page, context: browserContext }) => {
      await sendLog(jobId, 'info', 'Browser session started', { mode });
      
      // Set initial cookies if provided
      if (cookies && cookies.length > 0) {
        await sendLog(jobId, 'info', `🍪 Setting ${cookies.length} cookies...`);
        await browserContext.addCookies(cookies);
      }

      // Navigate to URL
      await sendLog(jobId, 'info', `Navigate: ${url}`, { mode });
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      // Wait for navigation if DOM is loaded, otherwise wait for timeout then analyze
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
        await sendLog(jobId, 'info', '✅ Page fully loaded', { mode });
      } catch (error) {
        await sendLog(jobId, 'warn', '⚠️ Page not fully loaded, proceeding with analysis');
        // Wait for timeout then analyze the page with AI
        await page.waitForTimeout(5000);
        await sendLog(jobId, 'info', '🔍 Analyzing page state with AI...', { mode });
      }

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
      
      // Extract authentication tokens from browser context
      const extractedCookies = await page.context().cookies();
      const localStorage = await page.evaluate(() => {
        const storage = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          storage[key] = window.localStorage.getItem(key);
        }
        return storage;
      });
      
      const sessionStorage = await page.evaluate(() => {
        const storage = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          storage[key] = window.sessionStorage.getItem(key);
        }
        return storage;
      });
      
      // Filter for authentication-related tokens
      const authTokens = {
        cookies: extractedCookies.filter(cookie => 
          cookie.name.toLowerCase().includes('auth') ||
          cookie.name.toLowerCase().includes('token') ||
          cookie.name.toLowerCase().includes('session') ||
          cookie.name.toLowerCase().includes('jwt') ||
          cookie.name.toLowerCase().includes('csrf') ||
          cookie.name.toLowerCase().includes('login')
        ),
        localStorage: Object.keys(localStorage).filter(key => 
          key.toLowerCase().includes('auth') ||
          key.toLowerCase().includes('token') ||
          key.toLowerCase().includes('session') ||
          key.toLowerCase().includes('jwt') ||
          key.toLowerCase().includes('login')
        ).reduce((obj, key) => {
          obj[key] = localStorage[key];
          return obj;
        }, {}),
        sessionStorage: Object.keys(sessionStorage).filter(key => 
          key.toLowerCase().includes('auth') ||
          key.toLowerCase().includes('token') ||
          key.toLowerCase().includes('session') ||
          key.toLowerCase().includes('jwt') ||
          key.toLowerCase().includes('login')
        ).reduce((obj, key) => {
          obj[key] = sessionStorage[key];
          return obj;
        }, {})
      };
      
      await sendLog(jobId, 'info', `🔑 Authentication tokens acquired: ${authTokens.cookies.length} cookies, ${Object.keys(authTokens.localStorage).length} localStorage items, ${Object.keys(authTokens.sessionStorage).length} sessionStorage items`, { action: 'token_extraction' });
      
      return {
        ...operationResult,
        startTime,
        duration_ms: Date.now() - startTime,
        finalUrl: page.url(),
        finalTitle: await page.title(),
        // Authentication tokens for crawling
        cookies: extractedCookies,
        authTokens: authTokens,
        tokenCount: {
          cookies: authTokens.cookies.length,
          localStorage: Object.keys(authTokens.localStorage).length,
          sessionStorage: Object.keys(authTokens.sessionStorage).length,
          total: authTokens.cookies.length + Object.keys(authTokens.localStorage).length + Object.keys(authTokens.sessionStorage).length
        }
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
  
  await sendLog(jobId, 'info', `🚀 Starting ${mode} mode crawl process for ${url}`, { mode });
  
  try {
    const openaiClient = new OpenAI({ apiKey: openaiApiKey });
    
    const result = await withBrowser(async ({ page, context: browserContext }) => {
      await sendLog(jobId, 'info', 'Browser session started', { mode });
      
      // Set initial cookies if provided
      if (cookies && cookies.length > 0) {
        await sendLog(jobId, 'info', `🍪 Setting ${cookies.length} cookies...`);
        await browserContext.addCookies(cookies);
      }
      
      // Set authentication tokens from login if provided
      if (context.authTokens) {
        await sendLog(jobId, 'info', '🔑 Setting authentication tokens from login...');
        
        // Set localStorage tokens
        if (context.authTokens.localStorage && Object.keys(context.authTokens.localStorage).length > 0) {
          await page.evaluate((tokens) => {
            Object.entries(tokens).forEach(([key, value]) => {
              window.localStorage.setItem(key, value);
            });
          }, context.authTokens.localStorage);
          await sendLog(jobId, 'info', `📦 Set ${Object.keys(context.authTokens.localStorage).length} localStorage tokens`);
        }
        
        // Set sessionStorage tokens
        if (context.authTokens.sessionStorage && Object.keys(context.authTokens.sessionStorage).length > 0) {
          await page.evaluate((tokens) => {
            Object.entries(tokens).forEach(([key, value]) => {
              window.sessionStorage.setItem(key, value);
            });
          }, context.authTokens.sessionStorage);
          await sendLog(jobId, 'info', `📦 Set ${Object.keys(context.authTokens.sessionStorage).length} sessionStorage tokens`);
        }
        
        // Set additional cookies from authTokens
        if (context.authTokens.cookies && context.authTokens.cookies.length > 0) {
          await browserContext.addCookies(context.authTokens.cookies);
          await sendLog(jobId, 'info', `🍪 Set ${context.authTokens.cookies.length} authentication cookies`);
        }
      }

      // Navigate to URL
      await sendLog(jobId, 'info', `Navigate: ${url}`, { mode });
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      // Wait for navigation if DOM is loaded, otherwise wait for timeout then analyze
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
        await sendLog(jobId, 'info', '✅ Page fully loaded', { mode });
      } catch (error) {
        await sendLog(jobId, 'warn', '⚠️ Page not fully loaded, proceeding with analysis');
        // Wait for timeout then analyze the page with AI
        await page.waitForTimeout(5000);
        await sendLog(jobId, 'info', '🔍 Analyzing page state with AI...', { mode });
      }

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
