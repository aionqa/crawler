/**
 * Unified Operations - Handles login and crawl operations with multiple modes
 */

import { chromium } from 'playwright';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import * as backendLogger from './backend-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Conditional imports for shared modules
let aiConversationLogger = null;

try {
  // Try to import shared modules (works in container)
  const aiModule = await import('/app/shared/ai-conversation-logger.js');
  aiConversationLogger = aiModule.aiConversationLogger;
} catch (error) {
  // Fallback for CLI mode (shared modules not available)
  console.log('[CLI] Shared modules not available, using CLI mode');
}

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

// Set agent name
process.env.AGENT_NAME = 'unified-crawler';

// Sequence tracking per job (for ordered logging)
const jobSequences = new Map(); // jobId -> sequenceNumber

function getNextSequence(jobId) {
  if (!jobSequences.has(jobId)) {
    jobSequences.set(jobId, 0);
  }
  const seq = jobSequences.get(jobId);
  jobSequences.set(jobId, seq + 1);
  return seq;
}

// Helper function to remove ASCII graphics from log messages
function cleanLogMessage(message) {
  // Remove box drawing characters
  message = message.replace(/[╔╗╚╝═║│┌┐└┘─├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]/g, '');
  // Remove decorative emojis at start of lines (but keep meaningful ones)
  message = message.replace(/^[🌍📍⏳🔗📊📋🔍📄🎯💬✓✅🚀🎉📸🎥🔐⚠️❌]/gm, '');
  // Clean up excessive whitespace
  message = message.replace(/\n{3,}/g, '\n\n');
  message = message.trim();
  return message;
}

// Helper function to send logs to backend via HTTP
// Send basic page data to backend first (creates page document)
// Returns the pageId from the backend
async function sendBasicPageToBackend(jobId, pageUrl, pageTitle) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    console.log(`[INCREMENTAL-STORAGE] Creating basic page document: ${pageUrl}`);
    const response = await fetch(`${backendUrl}/jobs/${jobId}/discovered-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jobId,
        page: {
          url: pageUrl,
          title: pageTitle,
          content: '', // Will be filled later
          analyzed: false // Will be updated after analysis
        }
      })
    });
    if (!response.ok) {
      console.error(`[INCREMENTAL-STORAGE] Backend returned ${response.status}`);
      return null;
    } else {
      const result = await response.json();
      console.log(`[INCREMENTAL-STORAGE] ✅ Basic page created: ${pageUrl} (ID: ${result.pageId})`);
      return result.pageId; // Return the MongoDB page ID
    }
  } catch (error) {
    console.error(`[INCREMENTAL-STORAGE] Failed to create basic page: ${error.message}`);
    return null;
  }
}

// Send discovered page to backend immediately (incremental storage)
// Returns the pageId from the backend
async function sendDiscoveredPageToBackend(jobId, pageData) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    console.log(`[INCREMENTAL-STORAGE] Sending page to backend: ${pageData.url}`);
    const response = await fetch(`${backendUrl}/jobs/${jobId}/discovered-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jobId,
        page: pageData
      })
    });
    if (!response.ok) {
      console.error(`[INCREMENTAL-STORAGE] Backend returned ${response.status}`);
      return null;
    } else {
      const result = await response.json();
      console.log(`[INCREMENTAL-STORAGE] ✅ Page stored: ${pageData.url} (ID: ${result.pageId})`);
      return result.pageId; // Return the MongoDB page ID
    }
  } catch (error) {
    console.error(`[INCREMENTAL-STORAGE] Failed to send discovered page to backend: ${error.message}`);
    return null;
  }
}

/**
 * Send log to backend - SINGLE ENDPOINT ONLY
 * Backend determines collection based on metadata:
 * - No page_url & no conversationId → logs_jobs
 * - Has page_url, no conversationId → logs_pages  
 * - Has conversationId → logs_aichats
 */
async function sendLog(jobId, level, message, data = {}, conversationId = null) {
  // Clean log message
  const cleanedMessage = cleanLogMessage(message);
  
  // Determine component name
  const mode = data.mode || 'auto';
  const componentMode = mode === 'auto' ? 'text' : mode;
  let componentName = `CRAWLER-${componentMode.toUpperCase()}`;
  
  if (data.action) {
    switch (data.action) {
      case 'screenshot':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-SCREENSHOT`;
        break;
      case 'ai_analysis':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-OPENAI`;
        break;
      case 'ai_request':
        componentName = 'OPENAI-REQUEST';
        break;
      case 'ai_response':
        componentName = 'OPENAI-RESPONSE';
        break;
      default:
        componentName = `CRAWLER-${componentMode.toUpperCase()}`;
    }
  }
  
  // Always log to console for docker logs (human-readable)
  console.log(`[${level.toUpperCase()}] [${componentName}] ${cleanedMessage}`);
  
  try {
    const pageUrl = data.page_url;
    const convId = conversationId || data.aiConversationId;
    
    // Prepare metadata
    const metadata = { 
      mode, 
      ...data,
      sequenceNumber: getNextSequence(jobId)
    };
    
    // Route based on presence of page_url and conversationId
    if (convId && pageUrl) {
      // AI chat log
      await backendLogger.appendAIChatLog(
        jobId,
        pageUrl,
        convId,
        level,
        cleanedMessage,
        data.chatContextId || null,
        componentName,
        metadata,
        data.requestPayload || null,
        data.responsePayload || null
      );
    } else if (pageUrl) {
      // Page log
      await backendLogger.appendPageLog(
        jobId,
        pageUrl,
        level,
        cleanedMessage,
        data.pageContextId || null,
        componentName,
        metadata
      );
    } else {
      // Job log
      await backendLogger.appendJobLog(
        jobId,
        level,
        cleanedMessage,
        componentName,
        metadata
      );
    }
    
  } catch (error) {
    console.error(`Failed to send log: ${error.message}`);
  }
}

// Upload files via backend API (legacy - used for fallback only)
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
    return {
      fileId: result.file_id,
      objectName: result.object_name
    };
  } catch (error) {
    console.error(`[unified-crawler] Backend upload error: ${error.message}`);
    return null;
  }
}

// Async video upload with proper logging (rule 38-video-recording-mandatory.mdc)
async function uploadVideoAsync(jobId, videoBuffer) {
  const uploadStartTime = Date.now();
  
  try {
    // Step 1: Log upload start
    await sendLog(jobId, 'info', '🎥 Preparing video upload...');
    
    // Step 2: Get presigned URL from backend
    const prepareResult = await backendLogger.prepareVideoUpload(jobId, {
      size: videoBuffer.length,
      format: 'webm'
    });
    
    if (!prepareResult.ok || !prepareResult.key || !prepareResult.uploadUrl) {
      throw new Error('Failed to prepare video upload - backend did not return key/uploadUrl');
    }
    
    const { key, uploadUrl, publicUrl } = prepareResult;
    
    // Step 3: Upload to MinIO via presigned URL
    await sendLog(jobId, 'info', `🎥 Uploading video to MinIO (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)...`);
    
    const uploadSuccess = await backendLogger.uploadVideoToPresignedUrl(uploadUrl, videoBuffer);
    
    if (!uploadSuccess) {
      throw new Error('Failed to upload video to MinIO via presigned URL');
    }
    
    // Step 4: Log upload completion with URL
    const uploadDuration = Date.now() - uploadStartTime;
    await sendLog(jobId, 'info', `🎥 Video uploaded successfully in ${(uploadDuration / 1000).toFixed(1)}s`, {
      videoKey: key,
      videoUrl: publicUrl,
      videoSize: videoBuffer.length,
      uploadDurationMs: uploadDuration,
      isVideo: true
    });
    
    // Step 5: Track media file in backend
    try {
      const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
      await fetch(`${backendUrl}/track-media-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          mediaType: 'video',
          fileInfo: {
            videoKey: key,
            objectName: key,
            url: publicUrl,
            size: videoBuffer.length,
            duration: uploadDuration,
            format: 'webm'
          }
        })
      });
    } catch (trackingError) {
      console.warn('[VIDEO] ⚠️ Failed to track media file:', trackingError.message);
    }
    
    return { success: true, key, publicUrl };
    
  } catch (error) {
    await sendLog(jobId, 'error', `🎥 Video upload failed: ${error.message}`, {
      error: error.message,
      uploadDurationMs: Date.now() - uploadStartTime
    });
    throw error;
  }
}

// Detect captcha on page
async function detectCaptcha(page, jobId) {
  try {
    // Common captcha selectors and indicators
    const captchaIndicators = [
      // reCAPTCHA
      'iframe[src*="recaptcha"]',
      'div.g-recaptcha',
      'div[class*="recaptcha"]',
      // hCaptcha
      'iframe[src*="hcaptcha"]',
      'div.h-captcha',
      'div[class*="hcaptcha"]',
      // Cloudflare Turnstile
      'iframe[src*="turnstile"]',
      'div[class*="turnstile"]',
      // Generic captcha indicators
      'div[id*="captcha"]',
      'div[class*="captcha"]',
      'img[src*="captcha"]',
      'input[name*="captcha"]'
    ];
    
    for (const selector of captchaIndicators) {
      const element = await page.$(selector);
      if (element) {
        const captchaType = selector.includes('recaptcha') ? 'reCAPTCHA' :
                           selector.includes('hcaptcha') ? 'hCaptcha' :
                           selector.includes('turnstile') ? 'Cloudflare Turnstile' :
                           'Generic Captcha';
        
        await sendLog(jobId, 'warn', `⚠️ CAPTCHA DETECTED: ${captchaType} found on page`, {
          captcha_type: captchaType,
          selector: selector,
          page_url: page.url(),
          action: 'captcha_detection'
        });
        
        return {
          detected: true,
          type: captchaType,
          selector: selector
        };
      }
    }
    
    return { detected: false };
  } catch (error) {
    console.error(`Captcha detection error: ${error.message}`);
    return { detected: false, error: error.message };
  }
}

// Attempt to handle captcha
async function handleCaptcha(page, jobId, captchaInfo) {
  try {
    await sendLog(jobId, 'info', `🔐 Attempting to handle ${captchaInfo.type}...`, {
      captcha_type: captchaInfo.type,
      action: 'captcha_handling'
    });
    
    // Wait for potential manual intervention or automatic solving
    // In a real scenario, this would integrate with a captcha solving service
    await page.waitForTimeout(5000);
    
    // Check if captcha is still present
    const stillPresent = await page.$(captchaInfo.selector);
    
    if (!stillPresent) {
      await sendLog(jobId, 'info', `✅ CAPTCHA PASSED: ${captchaInfo.type} was resolved`, {
        captcha_type: captchaInfo.type,
        action: 'captcha_passed',
        page_url: page.url()
      });
      return { passed: true };
    } else {
      await sendLog(jobId, 'warn', `⚠️ CAPTCHA STILL PRESENT: ${captchaInfo.type} requires manual intervention`, {
        captcha_type: captchaInfo.type,
        action: 'captcha_failed',
        page_url: page.url()
      });
      return { passed: false };
    }
  } catch (error) {
    await sendLog(jobId, 'error', `❌ Captcha handling error: ${error.message}`);
    return { passed: false, error: error.message };
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
    
    // Detect captcha before taking screenshot
    const captchaInfo = await detectCaptcha(page, jobId);
    if (captchaInfo.detected) {
      context.captcha_detected = true;
      context.captcha_type = captchaInfo.type;
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
    
    // Step 1: Get presigned URL and key from backend (backend generates filename)
    const pageUrl = page.url();
    const prepareResult = await backendLogger.prepareScreenshotUpload(jobId, pageUrl, {
      action,
      pageTitle: await page.title(),
      ...context
    });
    
    if (!prepareResult.ok || !prepareResult.key || !prepareResult.uploadUrl) {
      throw new Error('Failed to prepare screenshot upload - backend did not return key/uploadUrl');
    }
    
    const { key, uploadUrl, publicUrl } = prepareResult;
    
    // Step 2: Upload directly to MinIO via presigned URL
    const uploadSuccess = await backendLogger.uploadScreenshotToPresignedUrl(uploadUrl, screenshot);
    
    if (!uploadSuccess) {
      throw new Error('Failed to upload screenshot to MinIO via presigned URL');
    }
    
    // Step 3: Use backend-provided public URL (backend knows MinIO configuration)
    const screenshotPath = publicUrl || key; // Fallback to key if publicUrl not provided
    
    // Step 4: Log the screenshot with backend-generated key
    await sendLog(jobId, 'info', `📸 Screenshot captured: ${action}`, { 
      page_url: pageUrl, // Add page_url to route to logs_pages
      screenshotKey: key,
      screenshotId: key, // Use backend-generated key as screenshotId
      action: 'screenshot',
      url: pageUrl,
      title: await page.title(),
      screenshotPath,
      resolution: 'full_hd',
      timestamp: new Date().toISOString(),
      ...context
    });

    // Step 5: Track media file creation in job tracking
    try {
      const jobTrackingUrl = process.env.BACKEND_URL || 'http://back:4000';
      await fetch(`${jobTrackingUrl}/track-media-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          mediaType: 'screenshot',
          fileInfo: {
            screenshotId: key,
            objectName: key,
            url: screenshotPath,
            size: screenshot.length,
            action,
            step: context.step,
            pageUrl: pageUrl,
            pageTitle: await page.title(),
            ...context
          }
        })
      });
    } catch (trackingError) {
      console.warn('[SCREENSHOT] ⚠️ Failed to track media file:', trackingError.message);
    }
    
    return {
      screenshotKey: key,
      screenshotId: key,
      screenshotPath,
      action,
      timestamp: new Date().toISOString(),
      pageUrl: pageUrl,
      pageTitle: await page.title()
    };
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

// Generic AI validation function for ANY operation
async function validateActionSuccessWithAI(page, context, openaiClient, approach, operation, expectedOutcome = null) {
  const jobId = context.job_id || 'unknown';
  const currentUrl = page.url();
  const pageContext = { page_url: currentUrl, mode: context.mode || 'auto' };
  
  try {
    await sendLog(jobId, 'info', `🤖 AI validating ${operation} success...`, pageContext);
    
    // Take screenshot for AI validation
    const validationScreenshot = await takeScreenshot(page, jobId, `${operation}_validation`, {
      mode: 'auto',
      approach: approach,
      validation_type: `ai_${operation}_confirmation`,
      operation: operation
    });
    
    // Get page information
    const currentUrl = page.url();
    const currentTitle = await page.title();
    const pageContent = await page.content();
    
    // Extract all cookies
    const allCookies = await page.context().cookies();
    
    // Get localStorage and sessionStorage
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
    
    // Build operation-specific prompts
    let operationPrompts = {
      login: `You are validating whether a login attempt was successful.

IMPORTANT: Consider login SUCCESSFUL if the page content clearly shows success indicators,
EVEN IF no cookies were collected. Many test/demo sites don't set authentication cookies.

SUCCESS INDICATORS (ANY of these means login succeeded):
✅ Page title contains: "logged in", "success", "dashboard", "welcome", "home", "profile"
✅ Page content contains: "logged in successfully", "welcome", "logout", "sign out"
✅ URL changed from login page to different page
✅ Cookies/tokens collected (bonus, but NOT required)`,

      crawl: `You are validating whether a page crawl/analysis was successful.

SUCCESS INDICATORS:
✅ Page loaded completely (no errors)
✅ Page content is accessible
✅ Interactive elements are visible
✅ No access denied or error messages`,

      form_test: `You are validating whether a form submission was successful.

SUCCESS INDICATORS:
✅ Form submitted without errors
✅ Success message or confirmation displayed
✅ Page changed or updated after submission
✅ No validation errors shown`,

      link_click: `You are validating whether a link click/navigation was successful.

SUCCESS INDICATORS:
✅ Navigation completed to new page
✅ New page loaded successfully  
✅ No 404 or error pages
✅ Content is accessible`,

      page_analysis: `You are validating whether a page analysis was successful.

SUCCESS INDICATORS:
✅ Page content extracted successfully
✅ Interactive elements identified
✅ Forms and links detected
✅ No parsing or access errors`
    };

    const operationInstructions = operationPrompts[operation] || operationPrompts['page_analysis'];
    const expectedInfo = expectedOutcome ? `\n\nEXPECTED OUTCOME:\n${expectedOutcome}` : '';
    
    const aiPrompt = `${operationInstructions}

CURRENT STATE:
URL: ${currentUrl}
TITLE: ${currentTitle}
COOKIES: ${allCookies.length} total
AUTH COOKIES: ${allCookies.filter(c => c.name.toLowerCase().includes('auth') || c.name.toLowerCase().includes('session')).length}

PAGE CONTENT:
${pageContent.substring(0, 1500)}${pageContent.length > 1500 ? '...[truncated]' : ''}${expectedInfo}

Respond with JSON:
{
  "confirmed": true/false,
  "confidence": 0.0-1.0,
  "reason": "explanation focusing on page content",
  "evidence": ["evidence from page content"],
  "auth_tokens_collected": {
    "cookies": ["cookie names"],
    "localStorage_keys": [],
    "sessionStorage_keys": []
  },
  "recommendations": [],
  "action_completed": true/false
}`;

    // Create AI conversation for validation
    const completion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      jobId,
      'unified-crawler',
      `${operation}_validation`,
      {
        model: "gpt-4o-mini",
        messages: [{ 
          role: "user", 
          content: aiPrompt 
        }],
        response_format: { type: "json_object" }
      },
      validationScreenshot?.fileId,
      currentUrl,
      {
        approach: approach,
        operation: operation,
        validation_type: `${operation}_success`,
        page_title: currentTitle,
        cookies_count: allCookies.length,
        localStorage_count: Object.keys(localStorage).length,
        sessionStorage_count: Object.keys(sessionStorage).length,
        screenshot_id: validationScreenshot?.screenshotId,
        screenshot_path: validationScreenshot?.screenshotPath
      }
    );

    const validation = JSON.parse(completion.choices[0].message.content);
    
    await sendLog(jobId, 'info', `🤖 AI Validation Complete: ${validation.confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'}`, {
      ...pageContext,
      confidence: validation.confidence,
      reason: validation.reason,
      evidence_count: validation.evidence?.length || 0
    });
    
    return {
      confirmed: validation.confirmed || false,
      confidence: validation.confidence || 0,
      reason: validation.reason || 'No reason provided',
      evidence: validation.evidence || [],
      authTokensCollected: validation.auth_tokens_collected || {},
      recommendations: validation.recommendations || [],
      allCookies: allCookies,
      localStorage: localStorage,
      sessionStorage: sessionStorage,
      validationScreenshot: validationScreenshot,
      currentUrl: currentUrl,
      currentTitle: currentTitle
    };
    
  } catch (error) {
    await sendLog(jobId, 'error', `❌ AI validation failed: ${error.message}`);
    return {
      confirmed: false,
      confidence: 0,
      reason: `Validation error: ${error.message}`,
      evidence: [],
      authTokensCollected: {},
      recommendations: ['Retry login with different approach'],
      error: error.stack
    };
  }
}

// Backward compatibility wrapper for login validation
async function validateLoginSuccessWithAI(page, context, openaiClient, approach) {
  return await validateActionSuccessWithAI(page, context, openaiClient, approach, 'login');
}

// Browser automation wrapper
async function withBrowser(action, options = {}) {
  const useRemoteBrowser = process.env.USE_REMOTE_BROWSER === 'true';
  
  // Always use remote browser (crawler runs in Docker container)
  const inContainer = !!process.env.BACKEND_URL || useRemoteBrowser;
  
  // Debug environment variables
  await sendLog(options.jobId || 'debug', 'info', `Browser config - USE_REMOTE_BROWSER: ${useRemoteBrowser}, inContainer: ${inContainer}`);
  
  let browser;
  
  // Container mode: ALWAYS use remote browsers
  // Use backend-assigned browser endpoint if provided, otherwise use environment default
  const browserServiceUrl = options.browserServiceUrl || process.env.BROWSER_SERVICE_URL || 'http://browser-1:3000';
  const source = options.browserServiceUrl ? 'backend-assigned' : 'environment-default';
  await sendLog(options.jobId || 'server', 'info', `Using remote browser: ${browserServiceUrl} (${source})`);
  
  try {
    // Use the base WebSocket URL for CDP connection with timeout parameter
    // Browserless accepts timeout via query parameter (in milliseconds)
    const wsUrl = browserServiceUrl.replace('http://', 'ws://') + '?timeout=900000'; // 15 minute timeout
    await sendLog(options.jobId || 'server', 'info', `Connecting to WebSocket: ${wsUrl}`);
    browser = await chromium.connectOverCDP(wsUrl);
    await sendLog(options.jobId || 'server', 'info', 'Successfully connected to remote browser service via CDP (15min timeout)');
  } catch (error) {
    await sendLog(options.jobId || 'server', 'error', `Failed to connect to remote browser service: ${error.message}`);
    throw new Error(`Remote browser connection failed: ${error.message}`);
  }
  
  const contextOptions = {
    userAgent: options.userAgent,
    ignoreHTTPSErrors: true,
    viewport: options.viewport || { width: 1920, height: 1080 }
  };
  
  // Video recording is MANDATORY per rule 38-video-recording-mandatory.mdc
  // Record for ALL browser interactions (local and remote)
  const enableRecording = options.enable_video_recording !== false; // Default to true
  
  if (enableRecording) {
    contextOptions.recordVideo = { 
      dir: '/tmp/aionqa_videos',
      size: { width: 1920, height: 1080 }
    };
    await sendLog(options.job_id || 'unknown', 'info', '🎥 Video recording enabled for this session');
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
        const screenshot = await page.screenshot({ 
          type: 'png', 
          fullPage: true 
        });
        
        // Use presigned URL flow (architecture compliant)
        let pageUrl;
        try {
          pageUrl = page.url();
        } catch (error) {
          pageUrl = 'unknown';
        }
        const prepareResult = await backendLogger.prepareScreenshotUpload(options.job_id, pageUrl);
        
        if (prepareResult.ok && prepareResult.key && prepareResult.uploadUrl) {
          const { key, uploadUrl } = prepareResult;
          const uploadSuccess = await backendLogger.uploadScreenshotToPresignedUrl(uploadUrl, screenshot);
          
          if (uploadSuccess) {
            screenshotFileId = key;
            await sendLog(options.job_id || 'unknown', 'info', `📸 Screenshot captured successfully: ${key}`, {
              screenshotKey: key,
              screenshotId: key,
              action: 'screenshot',
              isScreenshot: true
            });
          } else {
            await sendLog(options.job_id || 'unknown', 'warn', `📸 Screenshot upload to MinIO failed`);
          }
        } else {
          await sendLog(options.job_id || 'unknown', 'warn', `📸 Screenshot prepared but backend did not return presigned URL`);
        }
      } catch (error) {
        await sendLog(options.job_id || 'unknown', 'error', `📸 Screenshot capture failed: ${error.message}`);
      }
    }
    
    // Handle video recording - MANDATORY per rule 38-video-recording-mandatory.mdc
    // Upload asynchronously with proper logging
    if (page && page.video) {
      try {
        await sendLog(options.job_id || 'unknown', 'info', '🎥 Processing video recording...');
        
        // Get video object (synchronous call)
        let video;
        try {
          video = page.video();
        } catch (videoError) {
          await sendLog(options.job_id || 'unknown', 'warn', `🎥 Could not get video object: ${videoError.message}`);
          video = null;
        }
        
        if (video) {
          const tempPath = `/tmp/run_${options.job_id || Date.now()}_${Date.now()}.webm`;
          
          // Save video with timeout
          const savePromise = video.saveAs(tempPath);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Video save timeout after 30s')), 30000)
          );
          
          await Promise.race([savePromise, timeoutPromise]);
          
          const fs = await import('fs');
          const videoBuffer = fs.readFileSync(tempPath);
          const videoSize = videoBuffer.length;
          
          // Clean up temp file immediately
          fs.unlinkSync(tempPath);
          
          // Upload video asynchronously (non-blocking per rule 38)
          // Log upload start immediately
          await sendLog(options.job_id || 'unknown', 'info', `🎥 Starting video upload (${(videoSize / 1024 / 1024).toFixed(2)} MB)...`);
          
          // Start async upload without awaiting
          uploadVideoAsync(options.job_id, videoBuffer).catch(error => {
            sendLog(options.job_id || 'unknown', 'error', `🎥 Video upload failed: ${error.message}`);
          });
          
          videoFileId = `uploading-${Date.now()}`; // Placeholder while uploading
          await sendLog(options.job_id || 'unknown', 'info', '🎥 Video upload started in background');
        } else {
          await sendLog(options.job_id || 'unknown', 'warn', '🎥 No video recording available (video object is null)');
        }
      } catch (error) {
        await sendLog(options.job_id || 'unknown', 'error', `🎥 Video recording failed: ${error.message}`);
      }
    } else {
      await sendLog(options.job_id || 'unknown', 'info', '🎥 Video recording not available for this page');
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
  // Simplified mode - Comprehensive approach (best of all methods)
  simplified: async (page, context, openaiClient, operation) => {
    await sendLog(context.job_id, 'info', '🚀 Using simplified mode (comprehensive approach)');
    if (operation === 'login') {
      return await performStaticLogin(page, context, openaiClient);
    } else {
      return await performStaticCrawl(page, context, openaiClient);
    }
  },

  // Auto mode - Sequential approach selection (tries multiple approaches until one works)
  auto: async (page, context, openaiClient, operation) => {
    const approachSequence = ['static', 'forms', 'text', 'media', 'script'];
    const currentUrl = page.url();
    const pageContext = { page_url: currentUrl, mode: 'auto' };
    let lastError = null;
    
    for (let i = 0; i < approachSequence.length; i++) {
      const approach = approachSequence[i];
      
      try {
        await sendLog(context.job_id, 'info', `Auto: Trying ${approach} (${i + 1}/${approachSequence.length})`, { 
          ...pageContext,
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
          // For login operations, validate IMMEDIATELY before considering it successful
          if (operation === 'login') {
            await sendLog(context.job_id, 'info', '🤖 Validating login success with OpenAI...', {
              ...pageContext,
              approach: approach,
              action: 'ai_login_validation'
            });
            
            const validationResult = await validateLoginSuccessWithAI(page, context, openaiClient, approach);
            
            // Update result with validation information
            result.loginValidation = validationResult;
            result.loginConfirmed = validationResult.confirmed;
            result.approach = approach; // Tag result with winning approach
            
            if (validationResult.confirmed) {
              // SUCCESS + VALIDATED - stop immediately
              await sendLog(context.job_id, 'info', `✅ Auto: ${approach} succeeded and VALIDATED - STOPPING all further attempts`, {
                ...pageContext,
                approach: approach,
                successful_approach: approach,
                stopped_at_attempt: i + 1,
                confidence: validationResult.confidence,
                reason: validationResult.reason
              });
              
              // Return immediately - don't try any more approaches
              return result;
            } else {
              // Appeared to succeed but validation failed - try next approach
              await sendLog(context.job_id, 'warn', `⚠️ Auto: ${approach} appeared to succeed but validation FAILED: ${validationResult.reason} - Trying next approach`, {
                mode: 'auto',
                approach: approach,
                failed_validation: true,
                confidence: validationResult.confidence
              });
              
              // Continue to next approach (don't return yet)
              continue;
            }
          } else {
            // For non-login operations (crawl, form_test, link_click, etc.), ALSO validate with AI
            await sendLog(context.job_id, 'info', `🤖 Validating ${operation} success with AI...`, {
              mode: 'auto',
              approach: approach,
              action: `ai_${operation}_validation`
            });
            
            const validationResult = await validateActionSuccessWithAI(page, context, openaiClient, approach, operation, expectedOutcome);
            
            // Update result with validation information
            result.validation = validationResult;
            result.confirmed = validationResult.confirmed;
            result.approach = approach; // Tag result with winning approach
            
            if (validationResult.confirmed) {
              // SUCCESS + VALIDATED - stop immediately
              await sendLog(context.job_id, 'info', `✅ Auto: ${approach} succeeded and VALIDATED for ${operation} - STOPPING all further attempts`, {
                mode: 'auto',
                approach: approach,
                operation: operation,
                successful_approach: approach,
                stopped_at_attempt: i + 1,
                confidence: validationResult.confidence,
                reason: validationResult.reason
              });
              
              // Return immediately - don't try any more approaches
              return result;
            } else {
              // Appeared to succeed but validation failed - try next approach
              await sendLog(context.job_id, 'warn', `⚠️ Auto: ${approach} appeared to succeed but ${operation} validation FAILED: ${validationResult.reason} - Trying next approach`, {
                mode: 'auto',
                approach: approach,
                operation: operation,
                failed_validation: true,
                confidence: validationResult.confidence
              });
              
              // Continue to next approach (don't return yet)
              continue;
            }
          }
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
    
    await sendLog(context.job_id, 'error', `Auto: All approaches failed (none validated successfully)`, { 
      mode: 'auto', 
      approaches_tried: approachSequence,
      last_error: lastError?.message
    });
    
    return {
      success: false,
      error: lastError?.message || 'All approaches failed validation',
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
    
    const aiPrompt = `Analyze this login page and provide login instructions in JSON format.

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
  const aiPrompt = `Analyze this login page screenshot and provide login instructions in JSON format.

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
  const result = await executeLoginFromAnalysis(page, analysis, context);
  // Tag with approach name
  if (result) {
    result.approach = 'media';
  }
  return result;
}

async function performMediaCrawl(page, context, openaiClient) {
  const jobId = context.job_id;
  await sendLog(jobId, 'info', '🚀 Starting MEDIA mode recursive crawl');
  
  const startUrl = page.url();
  
  // Perform recursive crawl with approach name
  const analyzedPages = await recursiveCrawl(page, jobId, startUrl, 'media', openaiClient, {
    max_depth: context.options?.max_depth ?? 3,
    max_pages: context.options?.max_pages ?? 50
  });
  
  // Build overall conclusion
  const totalLinks = analyzedPages.reduce((sum, p) => sum + p.total_links, 0);
  const totalForms = analyzedPages.reduce((sum, p) => sum + p.total_forms, 0);
  const totalFormInputs = analyzedPages.reduce((sum, p) => sum + p.total_form_inputs, 0);
  
  const conclusion = {
    crawl_started_at: new Date().toISOString(),
    start_url: startUrl,
    approach: 'media',
    
    pages_summary: {
      total_analyzed: analyzedPages.length,
      pages: analyzedPages.map(p => ({ url: p.url, title: p.title, forms: p.total_forms, links: p.total_links }))
    },
    
    overall_stats: {
      total_links: totalLinks,
      total_forms: totalForms,
      total_form_inputs: totalFormInputs,
      unique_pages: analyzedPages.length
    },
    
    recommendations: [
      `Media-based analysis of ${analyzedPages.length} pages`,
      `Found ${totalForms} forms across all pages`,
      `Ready for visual testing`
    ]
  };

  await sendLog(jobId, 'info', `✅ Media crawl complete: ${analyzedPages.length} pages`, { conclusion });

  return {
    success: true,
    message: `Media crawl completed: ${analyzedPages.length} pages analyzed`,
    details: {
      discovered_pages: analyzedPages, // Changed from analyzed_pages to match backend expectation
      total_pages: analyzedPages.length,
      total_links: totalLinks,
      total_forms: totalForms
    },
    conclusion,
    discovered_pages: analyzedPages.map(p => ({
      url: p.url,
      title: p.title,
      forms: p.forms,
      links: p.links,
      internal_links: p.internal_links,
      interactive_elements: p.interactive_elements,
      non_interactive_elements: p.non_interactive_elements,
      screenshot_file_id: p.screenshot_file_id,
      analyzed_at: p.analyzed_at
    }))
  };
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
  const aiPrompt = `Analyze this HTML page and provide login instructions in JSON format.

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
  const result = await executeLoginFromAnalysis(page, analysis, context);
  // Tag with approach name
  if (result) {
    result.approach = 'text';
  }
  return result;
}

async function performTextCrawl(page, context, openaiClient) {
  const jobId = context.job_id;
  await sendLog(jobId, 'info', '🚀 Starting TEXT mode recursive crawl');
  
  const startUrl = page.url();
  
  // Perform recursive crawl with approach name
  const analyzedPages = await recursiveCrawl(page, jobId, startUrl, 'text', openaiClient, {
    max_depth: context.options?.max_depth ?? 3,
    max_pages: context.options?.max_pages ?? 50
  });
  
  // Build overall conclusion
  const totalLinks = analyzedPages.reduce((sum, p) => sum + p.total_links, 0);
  const totalForms = analyzedPages.reduce((sum, p) => sum + p.total_forms, 0);
  const totalFormInputs = analyzedPages.reduce((sum, p) => sum + p.total_form_inputs, 0);
  
  const conclusion = {
    crawl_started_at: new Date().toISOString(),
    start_url: startUrl,
    approach: 'text',
    
    pages_summary: {
      total_analyzed: analyzedPages.length,
      pages: analyzedPages.map(p => ({ url: p.url, title: p.title, forms: p.total_forms, links: p.total_links }))
    },
    
    overall_stats: {
      total_links: totalLinks,
      total_forms: totalForms,
      total_form_inputs: totalFormInputs,
      unique_pages: analyzedPages.length
    },
    
    recommendations: [
      `Text-based analysis of ${analyzedPages.length} pages`,
      `Found ${totalForms} forms across all pages`,
      `Ready for automated testing`
    ]
  };

  await sendLog(jobId, 'info', `✅ Text crawl complete: ${analyzedPages.length} pages`, { conclusion });

  return {
    success: true,
    message: `Text crawl completed: ${analyzedPages.length} pages analyzed`,
    details: {
      discovered_pages: analyzedPages, // Changed from analyzed_pages to match backend expectation
      total_pages: analyzedPages.length,
      total_links: totalLinks,
      total_forms: totalForms
    },
    conclusion,
    discovered_pages: analyzedPages.map(p => ({
      url: p.url,
      title: p.title,
      forms: p.forms,
      links: p.links,
      internal_links: p.internal_links,
      interactive_elements: p.interactive_elements,
      non_interactive_elements: p.non_interactive_elements,
      screenshot_file_id: p.screenshot_file_id,
      analyzed_at: p.analyzed_at
    }))
  };
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
  const aiPrompt = `Analyze these forms and provide login instructions in JSON format.

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
  const jobId = context.job_id;
  await sendLog(jobId, 'info', '🚀 Starting FORMS mode recursive crawl');
  
  const startUrl = page.url();
  
  // Perform recursive crawl with approach name
  const analyzedPages = await recursiveCrawl(page, jobId, startUrl, 'forms', openaiClient, {
    max_depth: context.options?.max_depth ?? 3,
    max_pages: context.options?.max_pages ?? 50
  });
  
  // Build overall conclusion
  const totalLinks = analyzedPages.reduce((sum, p) => sum + p.total_links, 0);
  const totalForms = analyzedPages.reduce((sum, p) => sum + p.total_forms, 0);
  const totalFormInputs = analyzedPages.reduce((sum, p) => sum + p.total_form_inputs, 0);
  
  const conclusion = {
    crawl_started_at: new Date().toISOString(),
    start_url: startUrl,
    approach: 'forms',
    
    pages_summary: {
      total_analyzed: analyzedPages.length,
      pages: analyzedPages.map(p => ({ url: p.url, title: p.title, forms: p.total_forms, links: p.total_links }))
    },
    
    overall_stats: {
      total_links: totalLinks,
      total_forms: totalForms,
      total_form_inputs: totalFormInputs,
      unique_pages: analyzedPages.length
    },
    
    recommendations: [
      `Forms-focused analysis of ${analyzedPages.length} pages`,
      `Found ${totalForms} forms with ${totalFormInputs} inputs`,
      `Ready for form testing automation`
    ]
  };

  await sendLog(jobId, 'info', `✅ Forms crawl complete: ${analyzedPages.length} pages`, { conclusion });

  return {
    success: true,
    message: `Forms crawl completed: ${analyzedPages.length} pages analyzed`,
    details: {
      discovered_pages: analyzedPages, // Changed from analyzed_pages to match backend expectation
      total_pages: analyzedPages.length,
      total_links: totalLinks,
      total_forms: totalForms,
      total_form_inputs: totalFormInputs
    },
    conclusion,
    discovered_pages: analyzedPages.map(p => ({
      url: p.url,
      title: p.title,
      forms: p.forms,
      links: p.links,
      internal_links: p.internal_links,
      interactive_elements: p.interactive_elements,
      non_interactive_elements: p.non_interactive_elements,
      screenshot_file_id: p.screenshot_file_id,
      analyzed_at: p.analyzed_at
    }))
  };
}

// Extract interactive and non-interactive elements
async function extractPageElements(page, jobId) {
  try {
    await sendLog(jobId, 'info', '🔍 Extracting page elements...');
    
    // Extract interactive elements
    const interactive = await page.$$eval('button, a, input, select, textarea', elements => 
      elements.map(el => ({
        type: el.tagName.toLowerCase(),
        text: el.textContent?.trim() || el.value || '',
        href: el.href || null,
        selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : el.tagName.toLowerCase(),
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null
      }))
    );
    
    // Extract non-interactive elements
    const nonInteractive = await page.$$eval('p, h1, h2, h3, h4, h5, h6, span, div, label', elements => 
      elements.filter(el => {
        const text = el.textContent?.trim() || '';
        return text.length > 0 && text.length < 500; // Filter out empty or very long text
      }).slice(0, 50).map(el => ({ // Limit to 50 elements
        type: el.tagName.toLowerCase(),
        text: el.textContent?.trim() || '',
        selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : el.tagName.toLowerCase()
      }))
    );
    
    await sendLog(jobId, 'info', `📊 Extracted ${interactive.length} interactive and ${nonInteractive.length} non-interactive elements`);
    
    return { interactive, nonInteractive };
  } catch (error) {
    await sendLog(jobId, 'error', `Failed to extract elements: ${error.message}`);
    return { interactive: [], nonInteractive: [] };
  }
}

// Static mode implementations
async function performStaticLogin(page, context, openaiClient) {
  const jobId = context.job_id;
  const currentUrl = page.url();
  const pageContext = { page_url: currentUrl, mode: 'static' };
  
  await sendLog(jobId, 'info', '🔍 Performing static login with standard field matching', pageContext);
  
  // Detect captcha first
  const captchaInfo = await detectCaptcha(page, jobId);
  if (captchaInfo.detected) {
    const captchaResult = await handleCaptcha(page, jobId, captchaInfo);
    if (!captchaResult.passed) {
      return {
        success: false,
        message: `Captcha detected but not resolved: ${captchaInfo.type}`,
        details: { captchaInfo }
      };
    }
  }
  
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
    'input[type="text"]', // Added for practice test automation site
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
    'button[id="submit"]',
    'input[id="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign In")',
    'button:has-text("Submit")',
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
    await sendLog(jobId, 'info', '📸 Taking initial screenshot', pageContext);
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
    await sendLog(jobId, 'info', 'Fill username', pageContext);
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
    await sendLog(jobId, 'info', 'Fill password', pageContext);
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
    await sendLog(jobId, 'info', 'Submit form', pageContext);
    const submitBeforeShot = await takeScreenshotBeforeAction(page, jobId, 'form_submit', {
      step: 'before_form_submit',
      form_type: 'login',
      description: 'Before submitting form'
    });
    
    if (submitButton) {
      await sendLog(jobId, 'info', '🖱️ Clicking submit button', pageContext);
      await submitButton.click();
    } else {
      // Try pressing Enter on password field
      await sendLog(jobId, 'info', '⌨️ Pressing Enter on password field', pageContext);
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
    
    // Extract and log all cookies
    const allCookiesCollected = await page.context().cookies();
    await sendLog(jobId, 'info', `🍪 Collected ${allCookiesCollected.length} cookies from login session`, {
      ...pageContext,
      action: 'cookies_collected',
      cookie_count: allCookiesCollected.length,
      cookie_names: allCookiesCollected.map(c => c.name).join(', ')
    });

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

        await sendLog(context.job_id, 'info', '🤖 Enhanced conversation flow logged to chat mode', pageContext);
      } catch (conversationError) {
        console.warn('[CONVERSATION] ⚠️ Failed to log enhanced conversation:', conversationError.message);
      }
    }

    return {
      success: true,
      approach: 'static', // Tag with approach name
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
      approach: 'static',
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

// Comprehensive link extraction
async function extractAllLinks(page, jobId, baseUrl) {
  try {
    await sendLog(jobId, 'info', '🔗 Extracting all links from page...');
    
    const links = await page.$$eval('a[href]', (anchors, baseUrl) => {
      return anchors.map(link => {
        const href = link.href;
        const text = link.textContent?.trim() || '';
        
        // Parse URL to check if it's within domain
        let isInternal = false;
        let fullUrl = href;
        try {
          const linkUrl = new URL(href);
          const baseUrlObj = new URL(baseUrl);
          isInternal = linkUrl.hostname === baseUrlObj.hostname;
          fullUrl = linkUrl.href;
        } catch (e) {
          // Relative URL or invalid
          if (href.startsWith('/') || href.startsWith('./') || !href.includes('://')) {
            isInternal = true;
            try {
              fullUrl = new URL(href, baseUrl).href;
            } catch (e2) {
              fullUrl = href;
            }
          }
        }
        
        return {
          text: text,
          href: fullUrl,
          title: link.title || '',
          isInternal: isInternal,
          target: link.target || '',
          rel: link.rel || ''
        };
      }).filter(link => link.href && !link.href.startsWith('javascript:') && !link.href.startsWith('#'));
    }, baseUrl);
    
    const internalLinks = links.filter(l => l.isInternal);
    const externalLinks = links.filter(l => !l.isInternal);
    
    await sendLog(jobId, 'info', `📊 Found ${links.length} total links (${internalLinks.length} internal, ${externalLinks.length} external)`);
    
    return {
      all: links,
      internal: internalLinks,
      external: externalLinks,
      total: links.length
    };
  } catch (error) {
    await sendLog(jobId, 'error', `Failed to extract links: ${error.message}`);
    return { all: [], internal: [], external: [], total: 0 };
  }
}

// Enhanced form extraction - detects both <form> tags and logical form groups
async function extractFormsAndLogicalGroups(page, jobId) {
  try {
    await sendLog(jobId, 'info', '📋 Extracting forms and logical form groups...');
    
    // Extract traditional <form> elements
    const traditionalForms = await page.$$eval('form', forms => forms.map((form, index) => ({
      type: 'form_tag',
      index,
      action: form.action,
      method: form.method || 'GET',
      id: form.id || '',
      className: form.className || '',
      inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
        type: input.type || 'text',
        name: input.name || '',
        id: input.id || '',
        placeholder: input.placeholder || '',
        required: input.required,
        value: input.value || '',
        className: input.className || ''
      })),
      buttons: Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]')).map(button => ({
        text: button.textContent?.trim() || button.value || '',
        type: button.type || 'button',
        id: button.id || '',
        name: button.name || ''
      }))
    })));
    
    // Extract logical form groups (divs/containers with inputs and submit buttons)
    const logicalForms = await page.$$eval('div[id*="form"], div[class*="form"], div:has(input[type="password"])', containers => {
      return containers.map((container, index) => {
        const inputs = Array.from(container.querySelectorAll('input, textarea, select')).filter(input => {
          // Filter out hidden inputs and those already in actual forms
          return !input.closest('form') && input.type !== 'hidden';
        });
        
        const buttons = Array.from(container.querySelectorAll('button, input[type="submit"], input[type="button"]')).filter(button => {
          return !button.closest('form');
        });
        
        // Only consider it a logical form if it has inputs and buttons
        if (inputs.length > 0 && buttons.length > 0) {
          return {
            type: 'logical_group',
            index,
            id: container.id || '',
            className: container.className || '',
            inputs: inputs.map(input => ({
              type: input.type || 'text',
              name: input.name || '',
              id: input.id || '',
              placeholder: input.placeholder || '',
              required: input.required,
              value: input.value || '',
              className: input.className || ''
            })),
            buttons: buttons.map(button => ({
              text: button.textContent?.trim() || button.value || '',
              type: button.type || 'button',
              id: button.id || '',
              name: button.name || ''
            }))
          };
        }
        return null;
      }).filter(Boolean);
    });
    
    // Combine both types
    const allForms = [...traditionalForms, ...logicalForms];
    
    await sendLog(jobId, 'info', `📊 Found ${traditionalForms.length} traditional forms and ${logicalForms.length} logical form groups (total: ${allForms.length})`);
    
    return allForms;
  } catch (error) {
    await sendLog(jobId, 'error', `Failed to extract forms: ${error.message}`);
    return [];
  }
}

// Analyze a single page and extract all data with detailed logging
async function analyzeSinglePage(page, jobId, baseUrl, approach, openaiClient, pageId = null) {
  // Verify page is still valid before analysis
  try {
    if (!page || page.isClosed()) {
      throw new Error('Page is closed - cannot analyze');
    }
  } catch (checkError) {
    throw new Error(`Page validation failed: ${checkError.message}`);
  }
  
  let currentUrl, currentTitle;
  try {
    currentUrl = page.url();
    currentTitle = await page.title();
  } catch (error) {
    throw new Error(`Failed to get page info: ${error.message}`);
  }
  
  // Generate unique conversation ID for this page's analysis
  const conversationId = `conv_${jobId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Context data to include in all logs for this page
  const pageContext = { 
    page_url: currentUrl, 
    mode: approach,
    pageId: pageId // Include pageId if available
  };
  
  await sendLog(jobId, 'info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, pageContext);
  await sendLog(jobId, 'info', `📄 ANALYZING PAGE: ${currentTitle}`, pageContext);
  await sendLog(jobId, 'info', `🔗 URL: ${currentUrl}`, pageContext);
  await sendLog(jobId, 'info', `🎯 Approach: ${approach}`, pageContext);
  await sendLog(jobId, 'info', `💬 Conversation ID: ${conversationId}`, pageContext);
  await sendLog(jobId, 'info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, pageContext);
  
  // Step 1: Detect captcha
  await sendLog(jobId, 'info', `🔍 Step 1/6: Checking for captcha...`, pageContext);
  let captchaInfo = { detected: false };
  try {
    captchaInfo = await detectCaptcha(page, jobId);
    if (captchaInfo.detected) {
      await sendLog(jobId, 'warn', `⚠️  Captcha detected: ${captchaInfo.type}`, pageContext);
      await handleCaptcha(page, jobId, captchaInfo);
    } else {
      await sendLog(jobId, 'info', `✓ No captcha detected`, pageContext);
    }
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Captcha detection failed: ${error.message}`, pageContext);
  }
  
  // Step 2: Extract links
  await sendLog(jobId, 'info', `🔍 Step 2/6: Extracting links from page...`, pageContext);
  let linksData = { all: [], internal: [], external: [], total: 0 };
  try {
    linksData = await extractAllLinks(page, jobId, currentUrl);
    await sendLog(jobId, 'info', `✓ Found ${linksData.total} links (${linksData.internal.length} internal, ${linksData.external.length} external)`, pageContext);
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Link extraction failed: ${error.message}`, pageContext);
  }
  
  // Step 3: Extract forms
  await sendLog(jobId, 'info', `🔍 Step 3/6: Extracting forms and form groups...`, pageContext);
  let forms = [];
  let totalInputs = 0;
  try {
    forms = await extractFormsAndLogicalGroups(page, jobId);
    totalInputs = forms.reduce((sum, f) => sum + f.inputs.length, 0);
    await sendLog(jobId, 'info', `✓ Found ${forms.length} forms with ${totalInputs} total inputs`, pageContext);
    
    // Log each form's details
    for (let idx = 0; idx < forms.length; idx++) {
      const form = forms[idx];
      await sendLog(jobId, 'info', `  📋 Form ${idx + 1}: ${form.type} (${form.id || form.className || 'unnamed'}) - ${form.inputs.length} inputs, ${form.buttons?.length || 0} buttons`, pageContext);
    }
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Form extraction failed: ${error.message}`, pageContext);
  }
  
  // Step 4: Extract interactive elements
  await sendLog(jobId, 'info', `🔍 Step 4/6: Extracting interactive elements...`, pageContext);
  let pageElements = { interactive: [], nonInteractive: [] };
  try {
    pageElements = await extractPageElements(page, jobId);
    await sendLog(jobId, 'info', `✓ Found ${pageElements.interactive.length} interactive elements`, pageContext);
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Failed to extract elements: ${error.message}`, pageContext);
    // Continue with empty elements
  }
  
  // Step 5: Take screenshot
  await sendLog(jobId, 'info', `🔍 Step 5/6: Capturing screenshot...`, pageContext);
  let screenshotResult = null;
  try {
    screenshotResult = await takeScreenshot(page, jobId, 'page_analysis', {
      url: currentUrl,
      title: currentTitle,
      approach: approach,
      conversationId: conversationId
    });
    await sendLog(jobId, 'info', `✓ Screenshot captured: ${screenshotResult?.fileId || 'none'}`, pageContext);
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Screenshot capture failed: ${error.message}`, pageContext);
    // Continue without screenshot
  }
  
  // Step 6: Approach-specific AI analysis
  await sendLog(jobId, 'info', `🔍 Step 6/6: Analyzing with ${approach} approach...`, pageContext);
  
  let pageContent = '';
  try {
    pageContent = await page.content();
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Failed to get page content: ${error.message}`, pageContext);
    // Continue with empty content
  }
  
  // Approach-specific AI analysis
  if (aiConversationLogger && openaiClient && pageContent) {
    try {
      let aiPrompt, aiMessages;
      
      if (approach === 'media') {
        // MEDIA: Use vision API with screenshot
        await sendLog(jobId, 'info', `📸 Using AI vision to analyze screenshot...`, pageContext);
        
        let screenshot, screenshotBase64;
        try {
          screenshot = await page.screenshot({ 
            type: 'png', 
            fullPage: true,  // Capture full page for complete analysis
            animations: 'disabled'
          });
          screenshotBase64 = screenshot.toString('base64');
        } catch (screenshotError) {
          await sendLog(jobId, 'warn', `⚠️ Failed to capture screenshot for AI: ${screenshotError.message}`, pageContext);
          return; // Skip AI analysis if screenshot fails
        }
        
        aiMessages = [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this webpage screenshot and provide insights in JSON format:

URL: ${currentUrl}
Title: ${currentTitle}
Approach: MEDIA (Screenshot Analysis)

Focus on visual elements, layout, forms, and interactive elements you can see.
Provide brief analysis and testing recommendations.

Required JSON format:
{
  "visual_elements": ["..."],
  "forms_visible": number,
  "interactive_elements": ["..."],
  "recommendations": ["..."]
}`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${screenshotBase64}`,
                detail: "low"
              }
            }
          ]
        }];
        
      } else if (approach === 'text') {
        // TEXT: HTML analysis only
        await sendLog(jobId, 'info', `📝 Using AI to analyze HTML content...`, pageContext);
        const htmlSnippet = pageContent.length > 15000 
          ? pageContent.substring(0, 15000) + '...[truncated]' 
          : pageContent;
          
        aiPrompt = `Analyze this webpage HTML and provide insights in JSON format:

URL: ${currentUrl}
Title: ${currentTitle}
Approach: TEXT (HTML Analysis)

HTML Content:
${htmlSnippet}

Forms found: ${forms.length}
Links found: ${linksData.total}

Provide brief analysis and testing recommendations.

Required JSON format:
{
  "content_analysis": "...",
  "forms_detected": number,
  "testing_recommendations": ["..."]
}`;

        aiMessages = [{ role: "user", content: aiPrompt }];
        
      } else {
        // STATIC/OTHER: Basic summary
        await sendLog(jobId, 'info', `⚡ Using ${approach} approach - AI logging page summary...`, pageContext);
        aiPrompt = `Page analyzed with ${approach} approach:

URL: ${currentUrl}
Title: ${currentTitle}
Forms: ${forms.length}
Links: ${linksData.total} (${linksData.internal.length} internal)

Provide brief summary in JSON format with testing recommendations.`;

        aiMessages = [{ role: "user", content: aiPrompt }];
      }

      const completion = await aiConversationLogger.createChatCompletion(
        openaiClient,
        jobId,
        'unified-crawler',
        `page_analysis_${approach}`,
        {
          model: approach === 'media' ? "gpt-4o" : "gpt-4o-mini",  // Use vision model for media
          messages: aiMessages,
          response_format: { type: "json_object" },
          max_tokens: approach === 'media' ? 500 : 300
        },
        screenshotResult?.fileId,
        currentUrl,
        {
          approach: approach,
          conversationId: conversationId,
          page_title: currentTitle,
          forms_count: forms.length,
          links_count: linksData.total,
          has_forms: forms.length > 0,
          has_internal_links: linksData.internal.length > 0,
          analysis_mode: approach === 'media' ? 'vision' : 'text'
        }
      );
      
      await sendLog(jobId, 'info', `✓ AI ${approach} analysis complete (ID: ${conversationId})`, pageContext);
    } catch (aiError) {
      await sendLog(jobId, 'warn', `⚠️  AI conversation logging failed: ${aiError.message}`, pageContext);
    }
  }
  
  // Build page analysis
  const pageAnalysis = {
    url: currentUrl,
    title: currentTitle,
    content: pageContent,
    timestamp: new Date().toISOString(),
    screenshot_file_id: screenshotResult?.fileId || null,
    conversation_id: conversationId,
    approach: approach,
    
    // Links data
    links: linksData.all,
    internal_links: linksData.internal,
    external_links: linksData.external,
    total_links: linksData.total,
    
    // Forms data
    forms: forms,
    total_forms: forms.length,
    total_form_inputs: totalInputs,
    
    // Elements data
    interactive_elements: pageElements.interactive,
    non_interactive_elements: pageElements.nonInteractive,
    
    // Metadata
    captcha_detected: captchaInfo.detected,
    captcha_type: captchaInfo.type || null,
    analyzed_at: new Date().toISOString()
  };
  
  await sendLog(jobId, 'info', `✅ COMPLETED: ${currentTitle} - ${forms.length} forms, ${linksData.total} links, ${linksData.internal.length} to crawl`, pageContext);
  await sendLog(jobId, 'info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, pageContext);
  
  return pageAnalysis;
}

// Recursive crawler - visits all internal links up to max depth
async function recursiveCrawl(page, jobId, startUrl, approach, openaiClient, options = {}) {
  const maxDepth = options.max_depth || 3;
  const maxPages = options.max_pages || 50;
  
  const visitedUrls = new Set();
  const analyzedPages = [];
  const urlQueue = [{ url: startUrl, depth: 0 }];
  
  await sendLog(jobId, 'info', `╔═══════════════════════════════════════════════════════════════════╗`);
  await sendLog(jobId, 'info', `║  🌐 STARTING RECURSIVE CRAWL`);
  await sendLog(jobId, 'info', `║  Start URL: ${startUrl}`);
  await sendLog(jobId, 'info', `║  Approach: ${approach}`);
  await sendLog(jobId, 'info', `║  Max Depth: ${maxDepth}`);
  await sendLog(jobId, 'info', `║  Max Pages: ${maxPages}`);
  await sendLog(jobId, 'info', `╚═══════════════════════════════════════════════════════════════════╝`);
  
  while (urlQueue.length > 0 && analyzedPages.length < maxPages) {
    const { url: currentUrl, depth } = urlQueue.shift();
    
    // Skip if already visited
    if (visitedUrls.has(currentUrl)) {
      await sendLog(jobId, 'info', `⏭️  Skipping (already visited): ${currentUrl}`, { page_url: currentUrl, mode: approach });
      continue;
    }
    
    // Skip if max depth reached
    if (depth > maxDepth) {
      await sendLog(jobId, 'info', `⏭️  Skipping (max depth ${maxDepth} reached): ${currentUrl}`, { page_url: currentUrl, mode: approach });
      continue;
    }
    
    try {
      // Mark as visited
      visitedUrls.add(currentUrl);
      
      // Create page context for this URL
      const currentPageContext = { page_url: currentUrl, mode: approach };
      
      await sendLog(jobId, 'info', ``, currentPageContext);
      await sendLog(jobId, 'info', `🌍 ═══ PAGE ${analyzedPages.length + 1}/${maxPages} (Depth ${depth}/${maxDepth}) ═══`, currentPageContext);
      await sendLog(jobId, 'info', `📍 Navigating to: ${currentUrl}`, currentPageContext);
      
      // Check if page/browser is still valid before navigating
      try {
        if (!page || page.isClosed()) {
          throw new Error('Page is closed - cannot continue crawl');
        }
      } catch (checkError) {
        await sendLog(jobId, 'error', `❌ Browser context closed, stopping crawl at page ${analyzedPages.length + 1}`, currentPageContext);
        break; // Exit the while loop
      }
      
      // Navigate to URL
      await page.goto(currentUrl, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      await sendLog(jobId, 'info', `⏳ Waiting for page to fully load...`, currentPageContext);
      
      // Wait for page to settle
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1000);
      
      await sendLog(jobId, 'info', `✓ Page loaded successfully`, currentPageContext);
      
      // Get basic page info first
      let pageTitle, pageUrl;
      try {
        pageTitle = await page.title();
        pageUrl = await page.url();
        await sendLog(jobId, 'info', `📍 Navigating to: ${currentUrl} - ${pageTitle}`, currentPageContext);
      } catch (error) {
        await sendLog(jobId, 'error', `❌ Failed to get page info: ${error.message}`, currentPageContext);
        continue;
      }
      
      // Create basic page document in backend FIRST
      let pageId = await sendBasicPageToBackend(jobId, pageUrl, pageTitle);
      
      // Update page context with pageId for all subsequent logs
      if (pageId) {
        currentPageContext.pageId = pageId;
        currentPageContext.page_id = pageId;
      }
      
      // Log that basic page was created
      if (pageId) {
        await sendLog(jobId, 'info', `✓ Basic page created in database`, {
          ...currentPageContext,
          pageId: pageId
        });
      }
      
      // Now analyze this page with detailed logging (pageId available for all logs)
      let pageAnalysis;
      try {
        pageAnalysis = await analyzeSinglePage(page, jobId, currentUrl, approach, openaiClient, pageId);
        analyzedPages.push(pageAnalysis);
        
        // Update the page with full analysis data
        if (pageId) {
          await sendDiscoveredPageToBackend(jobId, pageAnalysis);
          await sendLog(jobId, 'info', `✓ Page analysis complete and stored`, {
            ...currentPageContext,
            pageId: pageId
          });
        }
      } catch (analysisError) {
        await sendLog(jobId, 'error', `❌ Failed to analyze page: ${analysisError.message}`, currentPageContext);
        
        // Check if browser is still alive
        try {
          await page.url();
        } catch (pageCheckError) {
          await sendLog(jobId, 'error', `❌ Browser context lost, stopping crawl`);
          break; // Exit the while loop
        }
        
        // Continue to next page if browser is still alive
        continue;
      }
      
      // Add internal links to queue for next depth level
      if (depth < maxDepth && pageAnalysis.internal_links && pageAnalysis.internal_links.length > 0) {
        let newLinksAdded = 0;
        for (const link of pageAnalysis.internal_links) {
          if (!visitedUrls.has(link.href) && !urlQueue.find(item => item.url === link.href)) {
            urlQueue.push({ url: link.href, depth: depth + 1 });
            newLinksAdded++;
          }
        }
        await sendLog(jobId, 'info', `📋 Queue updated: +${newLinksAdded} new links | Total in queue: ${urlQueue.length} | Visited: ${visitedUrls.size}`);
      } else if (depth >= maxDepth) {
        await sendLog(jobId, 'info', `⚠️  Max depth reached - not adding more links from this page`);
      }
      
      // Cleanup: Clear any dialogs or popups
      try {
        const openDialogs = page.context().pages().length;
        if (openDialogs > 1) {
          await sendLog(jobId, 'info', `🧹 Cleaning up ${openDialogs - 1} extra pages/dialogs`);
          const pages = page.context().pages();
          for (let i = 1; i < pages.length; i++) {
            await pages[i].close().catch(() => {});
          }
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      // Small delay between pages to prevent memory issues
      if (analyzedPages.length < maxPages && urlQueue.length > 0) {
        await sendLog(jobId, 'info', `⏸️ Brief pause before next page (analyzed ${analyzedPages.length}/${maxPages})...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (error) {
      await sendLog(jobId, 'error', `❌ Failed to crawl ${currentUrl}: ${error.message}`);
      await sendLog(jobId, 'error', `   Stack: ${error.stack}`);
      
      // Check if this is a browser closure error
      if (error.message.includes('Target page, context or browser has been closed') ||
          error.message.includes('Browser has been closed')) {
        await sendLog(jobId, 'error', `❌ Browser closed unexpectedly, stopping crawl`);
        break; // Stop crawling
      }
      
      // Continue with next URL for other errors
      continue;
    }
  }
  
  await sendLog(jobId, 'info', ``);
  await sendLog(jobId, 'info', `╔═══════════════════════════════════════════════════════════════════╗`);
  await sendLog(jobId, 'info', `║  🎉 RECURSIVE CRAWL COMPLETE`);
  await sendLog(jobId, 'info', `║  Pages Analyzed: ${analyzedPages.length}`);
  await sendLog(jobId, 'info', `║  URLs Visited: ${visitedUrls.size}`);
  await sendLog(jobId, 'info', `║  URLs Remaining in Queue: ${urlQueue.length}`);
  await sendLog(jobId, 'info', `╚═══════════════════════════════════════════════════════════════════╝`);
  
  return analyzedPages;
}

async function performStaticCrawl(page, context, openaiClient) {
  const jobId = context.job_id;
  await sendLog(jobId, 'info', '🚀 Starting STATIC mode recursive crawl');
  
  const startUrl = page.url();
  
  // Perform recursive crawl with approach name
  const analyzedPages = await recursiveCrawl(page, jobId, startUrl, 'static', openaiClient, {
    max_depth: context.options?.max_depth ?? 3,
    max_pages: context.options?.max_pages ?? 50
  });
  
  // Build overall conclusion
  const totalLinks = analyzedPages.reduce((sum, p) => sum + p.total_links, 0);
  const totalForms = analyzedPages.reduce((sum, p) => sum + p.total_forms, 0);
  const totalFormInputs = analyzedPages.reduce((sum, p) => sum + p.total_form_inputs, 0);
  
  const conclusion = {
    crawl_started_at: new Date().toISOString(),
    start_url: startUrl,
    approach: 'static',
    
    pages_summary: {
      total_analyzed: analyzedPages.length,
      pages: analyzedPages.map(p => ({
        url: p.url,
        title: p.title,
        forms: p.total_forms,
        links: p.total_links
      }))
    },
    
    overall_stats: {
      total_links: totalLinks,
      total_forms: totalForms,
      total_form_inputs: totalFormInputs,
      unique_pages: analyzedPages.length
    },
    
    recommendations: [
      `Analyzed ${analyzedPages.length} pages from the website`,
      `Found ${totalForms} forms across all pages`,
      `Discovered ${totalLinks} total links`,
      `Ready for comprehensive testing`
    ]
  };

  await sendLog(jobId, 'info', `✅ Crawl complete: ${analyzedPages.length} pages, ${totalForms} forms, ${totalLinks} links`, {
    conclusion: conclusion
  });

  const returnValue = {
    success: true,
    message: `Recursive crawl completed: ${analyzedPages.length} pages analyzed`,
    details: {
      discovered_pages: analyzedPages, // Changed from analyzed_pages to match backend expectation
      total_pages: analyzedPages.length,
      total_links: totalLinks,
      total_forms: totalForms,
      total_form_inputs: totalFormInputs
    },
    conclusion: conclusion,
    discovered_pages: analyzedPages.map(p => ({
      url: p.url,
      title: p.title,
      forms: p.forms,
      links: p.links,
      internal_links: p.internal_links,
      interactive_elements: p.interactive_elements,
      non_interactive_elements: p.non_interactive_elements,
      screenshot_file_id: p.screenshot_file_id,
      analyzed_at: p.analyzed_at
    }))
  };
  
  console.log(`[PERFORM-STATIC-CRAWL] Returning with success=${returnValue.success}, pages=${analyzedPages.length}`);
  return returnValue;
}

// Script mode implementations
async function performScriptLogin(page, context, openaiClient) {
  const currentUrl = page.url();
  const pageContext = { page_url: currentUrl, mode: 'script' };
  
  await sendLog(context.job_id, 'info', '📜 Performing script-based login', pageContext);
  
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
  const currentUrl = page.url();
  const pageContext = { page_url: currentUrl, mode: 'script' };
  
  await sendLog(context.job_id, 'info', '📜 Performing script-based crawl', pageContext);
  
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
  const currentUrl = page.url();
  const pageContext = { page_url: currentUrl, mode: 'analysis' };
  
  try {
    await sendLog(jobId, 'info', '🔐 Executing login based on AI analysis', pageContext);
    
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
    await sendLog(jobId, 'info', '✏️ Filling username field', { ...pageContext, action: 'form_fill' });
    await usernameField.fill(context.credentials.username);
    
    const usernameScreenshot = await takeScreenshot(page, jobId, 'after_username', {
      step: 'after_username',
      form_type: 'login',
      field_filled: 'username'
    });
    
    await sendLog(jobId, 'info', '✏️ Filling password field', { ...pageContext, action: 'form_fill' });
    await passwordField.fill(context.credentials.password);
    
    const passwordScreenshot = await takeScreenshot(page, jobId, 'after_password', {
      step: 'after_password',
      form_type: 'login',
      field_filled: 'password'
    });
    
    // Submit form
    await sendLog(jobId, 'info', '🖱️ Submitting login form', { ...pageContext, action: 'login_execution' });
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
    
    // Log all cookies for project storage (combined log to avoid duplication)
    await sendLog(jobId, 'info', `🔑 Auth tokens extracted: ${authTokens.cookies.length} auth cookies, ${extractedCookies.length} total cookies, ${Object.keys(authTokens.localStorage).length} localStorage, ${Object.keys(authTokens.sessionStorage).length} sessionStorage`, {
      action: 'token_extraction',
      total_cookies: extractedCookies.length,
      auth_cookies: authTokens.cookies.length,
      localStorage_items: Object.keys(authTokens.localStorage).length,
      sessionStorage_items: Object.keys(authTokens.sessionStorage).length,
      cookies: extractedCookies.map(c => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        value_length: c.value.length
      }))
    });
    
    return {
      success: true,
      message: `Login executed successfully - ${extractedCookies.length} cookies and authentication tokens acquired`,
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
      // Return ALL cookies for use in crawling and storage with project
      cookies: extractedCookies,
      authTokens: authTokens,
      finalUrl,
      finalTitle,
      // Summary
      cookiesCollected: extractedCookies.length,
      authCookiesCollected: authTokens.cookies.length
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
      // Navigate first to get the URL
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
      
      // Now we have the page URL, create pageContext
      const currentUrl = page.url();
      const pageContext = { page_url: currentUrl, mode };
      
      // Wait for navigation if DOM is loaded, otherwise wait for timeout then analyze
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
        await sendLog(jobId, 'info', '✅ Page fully loaded', pageContext);
      } catch (error) {
        await sendLog(jobId, 'warn', '⚠️ Page not fully loaded, proceeding with analysis', pageContext);
        // Wait for timeout then analyze the page with AI
        await page.waitForTimeout(5000);
        await sendLog(jobId, 'info', '🔍 Analyzing page state with AI...', pageContext);
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
      
      // Single comprehensive log for token acquisition
      if (extractedCookies.length > 0) {
        await sendLog(jobId, 'info', `📦 ${extractedCookies.length} cookies ready for project storage (${authTokens.cookies.length} auth-related)`, {
          action: 'cookies_for_storage',
          total_cookies: extractedCookies.length,
          auth_cookies: authTokens.cookies.length,
          localStorage_items: Object.keys(authTokens.localStorage).length,
          sessionStorage_items: Object.keys(authTokens.sessionStorage).length,
          cookie_names: extractedCookies.map(c => c.name).join(', ')
        });
      } else {
        await sendLog(jobId, 'warn', `⚠️ No cookies were collected during login`, {
          ...pageContext,
          action: 'cookies_for_storage',
          auth_cookies: authTokens.cookies.length,
          localStorage_items: Object.keys(authTokens.localStorage).length,
          sessionStorage_items: Object.keys(authTokens.sessionStorage).length
        });
      }
      
      return {
        ...operationResult,
        startTime,
        duration_ms: Date.now() - startTime,
        finalUrl: page.url(),
        finalTitle: await page.title(),
        // ALL cookies for storage with project
        cookies: extractedCookies,
        // Authentication tokens for crawling (filtered subset)
        authTokens: authTokens,
        tokenCount: {
          cookies: authTokens.cookies.length,
          localStorage: Object.keys(authTokens.localStorage).length,
          sessionStorage: Object.keys(authTokens.sessionStorage).length,
          total: authTokens.cookies.length + Object.keys(authTokens.localStorage).length + Object.keys(authTokens.sessionStorage).length
        },
        // Summary for project storage
        storageReady: {
          totalCookies: extractedCookies.length,
          authCookies: authTokens.cookies.length,
          localStorageItems: Object.keys(authTokens.localStorage).length,
          sessionStorageItems: Object.keys(authTokens.sessionStorage).length,
          readyForStorage: extractedCookies.length > 0
        }
      };
    }, {
      headless: context.options?.headless !== false,
      enable_screenshots: context.options?.enable_screenshots !== false,
      enable_video_recording: true, // MANDATORY per rule 38-video-recording-mandatory.mdc
      job_id: jobId,
      browserServiceUrl: context.browserServiceUrl
    });

    // Create page context for final logs
    const finalPageContext = { page_url: result.finalUrl || url, mode };
    
    await sendLog(jobId, 'info', `✅ Login attempt completed in ${result.duration_ms}ms`, finalPageContext);
    await sendLog(jobId, result.success ? 'info' : 'error', `📊 Result: ${result.success ? 'SUCCESS' : 'FAILED'}`, finalPageContext);
    
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
      
      // Extract page elements for storage (may fail if browser already closed after long crawl)
      let pageElements = { interactive: [], nonInteractive: [] };
      try {
        pageElements = await extractPageElements(page, jobId);
      } catch (error) {
        await sendLog(jobId, 'warn', `⚠️ Could not extract final page elements (browser may have closed): ${error.message}`);
        // Not a critical error - we already have all the page data from recursive crawl
      }
      
      console.log(`[START-CRAWL] operationResult.success = ${operationResult.success}`);
      
      const finalResult = {
        ...operationResult,
        startTime,
        duration_ms: Date.now() - startTime,
        finalUrl: operationResult.url || 'unknown', // Use URL from operation result if page is closed
        finalTitle: operationResult.title || 'unknown', // Use title from operation result if page is closed
        interactive_elements: pageElements.interactive || operationResult.details?.interactive_elements || [],
        non_interactive_elements: pageElements.nonInteractive || operationResult.details?.non_interactive_elements || []
      };
      
      console.log(`[START-CRAWL] finalResult.success = ${finalResult.success}`);
      return finalResult;
    }, {
      headless: context.options?.headless !== false,
      enable_screenshots: context.options?.enable_screenshots !== false,
      enable_video_recording: true, // MANDATORY per rule 38-video-recording-mandatory.mdc
      job_id: jobId,
      browserServiceUrl: context.browserServiceUrl
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
