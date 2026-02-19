/**
 * Unified Operations - Handles login and crawl operations with multiple modes
 */

import { chromium } from 'playwright';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import * as backendLogger from '../backend-logger.js';
import fs from 'fs';
import { createOpenAIClient } from '../openai-client-factory.js';
import ffmpeg from 'fluent-ffmpeg';
import WorkflowAnalyzer from '../workflow/analysis/workflow-analyzer.js';
import WorkflowExecutor from '../workflow/execution/workflow-executor.js';
import OptimizedWorkflowAnalyzer from '../workflow/analysis/optimized-workflow-analyzer.js';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Conditional imports for shared modules
let aiConversationLogger = null;

/**
 * Check job status from backend
 */
async function checkJobStatus(jobId, runnerToken = null) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    const headers = {};
    if (runnerToken) {
      headers['Authorization'] = `Bearer ${runnerToken}`;
    }
    // Use /api/jobs/:id which doesn't require authentication (runner-friendly endpoint)
    const response = await axios.get(`${backendUrl}/api/jobs/${jobId}`, {
      headers,
      timeout: 5000
    });
    return response.data?.status || 'unknown';
  } catch (error) {
    console.error(`❌ [UNIFIED-OPERATIONS] Error checking job status:`, error.message);
    if (error.response?.status === 401) {
      console.error(`   Status: 401 Unauthorized - Authentication failed`);
      console.error(`   Runner token provided: ${runnerToken ? 'Yes (length: ' + runnerToken.length + ')' : 'NO - THIS IS THE PROBLEM!'}`);
    }
    return 'unknown';
  }
}

try {
  // Try to import shared modules (works in container)
  const aiModule = await import('../../shared/ai-conversation-logger.js');
  aiConversationLogger = aiModule.aiConversationLogger;
  
  console.log('[UNIFIED-CRAWLER] ✅ AI conversation logger loaded');
} catch (error) {
  // Fallback for CLI mode (shared modules not available)
  console.log('[CLI] Shared modules not available, using CLI mode');
}

/**
 * Clean script to remove markdown code blocks and function declarations
 */
function cleanScript(script) {
  if (!script || typeof script !== 'string') {
    return script;
  }
  
  let cleaned = script.trim();
  
  // First, extract code from markdown code blocks if present
  const codeBlockRegex = /```[\w]*\s*\n?([\s\S]*?)\n?```/g;
  const codeBlockMatches = [...cleaned.matchAll(codeBlockRegex)];
  if (codeBlockMatches.length > 0) {
    cleaned = codeBlockMatches.map(match => match[1]).join('\n\n');
  } else {
    cleaned = cleaned.replace(/^```[\w]*\s*\n?/gm, '');
    cleaned = cleaned.replace(/\n?\s*```$/gm, '');
    cleaned = cleaned.replace(/^\s*```[\w]*\s*$/gm, '');
    cleaned = cleaned.replace(/```[\w]*/g, '');
  }
  
  // Extract function bodies instead of removing functions completely
  const extractFunctionBodies = (text) => {
    const patterns = [
      /async\s+function\s*\([^)]*\)\s*\{/g,
      /async\s+function\s+\w+\s*\([^)]*\)\s*\{/g,
      /function\s*\([^)]*\)\s*\{/g,
      /function\s+\w+\s*\([^)]*\)\s*\{/g
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index;
        const openBracePos = match.index + match[0].length - 1;
        let braceCount = 1;
        let pos = openBracePos + 1;
        const bodyStart = pos;
        
        while (braceCount > 0 && pos < text.length) {
          if (text[pos] === '{') braceCount++;
          else if (text[pos] === '}') braceCount--;
          pos++;
        }
        
        if (braceCount === 0) {
          const bodyEnd = pos - 1;
          const functionBody = text.slice(bodyStart, bodyEnd).trim();
          text = text.slice(0, start) + functionBody + text.slice(pos);
          pattern.lastIndex = 0;
        }
      }
    }
    
    return text;
  };
  
  cleaned = extractFunctionBodies(cleaned);
  
  // Remove IIFE wrappers
  cleaned = cleaned.replace(/\(async\s*\([^)]*\)\s*=>\s*\{/g, '');
  cleaned = cleaned.replace(/\(async\s+function\s*\([^)]*\)\s*\{[^}]*\}\)\s*\(\)/g, '');
  cleaned = cleaned.replace(/\(async\s*\(\)\s*=>\s*\{[^}]*\}\)\s*\(\)/g, '');
  
  // Remove require statements
  cleaned = cleaned.replace(/const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+\w+\s*=\s*require\s*\([^)]*\)\s*;?\s*/g, '');
  cleaned = cleaned.replace(/require\s*\([^)]*\)\s*;?\s*/g, '');
  
  // Remove module.exports
  cleaned = cleaned.replace(/module\.exports\s*=\s*[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/module\.exports\s*=\s*async\s+function[^}]*\}/g, '');
  
  // Remove browser/page creation
  cleaned = cleaned.replace(/const\s+browser\s*=\s*await\s+chromium\.launch[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+browser\.newPage[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+context\s*=\s*await\s+browser\.newContext[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/const\s+page\s*=\s*await\s+context\.newPage[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/await\s+browser\.close[^;]+;?\s*/g, '');
  cleaned = cleaned.replace(/await\s+context\.close[^;]+;?\s*/g, '');
  
  // Remove template variables
  cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, '');
  
  // Remove comments
  cleaned = cleaned.replace(/\/\/[^\n]*/g, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Clean up extra whitespace
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n');
  cleaned = cleaned.trim();
  
  // If the script is wrapped in braces, unwrap them
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  
  return cleaned;
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

// Helper function to remove ASCII graphics from log messages (but preserve emojis)
function cleanLogMessage(message) {
  if (!message) {
    return '';
  }
  // Convert non-string values to string (handles objects, arrays, etc.)
  if (typeof message !== 'string') {
    try {
      // For objects/arrays, use JSON.stringify with formatting
      if (typeof message === 'object') {
        message = JSON.stringify(message, null, 2);
      } else {
        message = String(message);
      }
    } catch (error) {
      // Fallback if stringification fails
      message = String(message);
    }
  }
  // Remove box drawing characters (but preserve emojis)
  message = message.replace(/[╔╗╚╝═║│┌┐└┘─├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]/g, '');
  // DO NOT remove emojis - they are important visual indicators
  // Clean up excessive whitespace
  message = message.replace(/\n{3,}/g, '\n\n');
  message = message.trim();
  return message;
}

// Helper function to check if URL is within the same domain.
// When allowSubdomains=true, treat sibling subdomains as internal as long as the
// registrable domain (naively: last 2 labels) matches.
function isWithinDomain(pageUrl, baseUrl, allowSubdomains = false) {
  try {
    const pageUrlObj = new URL(pageUrl);
    const baseUrlObj = new URL(baseUrl);
    
    // Check if hostname matches (including www vs non-www)
    const pageHostname = pageUrlObj.hostname.replace(/^www\./, '');
    const baseHostname = baseUrlObj.hostname.replace(/^www\./, '');

    if (pageHostname === baseHostname) return true;

    if (!allowSubdomains) return false;

    const getBaseDomain = (hostname) => {
      const parts = String(hostname || '').split('.').filter(Boolean);
      if (parts.length < 2) return String(hostname || '');
      return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    };

    return getBaseDomain(pageHostname) === getBaseDomain(baseHostname);
  } catch (error) {
    // If URL parsing fails, treat as external
    return false;
  }
}

// Helper function to send logs to backend via HTTP
// Send basic page data to backend first (creates page document)
// Returns the pageId from the backend
async function sendBasicPageToBackend(jobId, pageUrl, pageTitle, projectId = null, baseUrl = null, lighthouseResults = null, allowSubdomains = false) {
  try {
    // Domain filtering: Only send internal pages to backend
    if (baseUrl && !isWithinDomain(pageUrl, baseUrl, allowSubdomains)) {
      console.log(`[INCREMENTAL-STORAGE] ⏭️ Skipping external page (not in domain): ${pageUrl}`);
      return null;
    }
    
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    console.log(`[INCREMENTAL-STORAGE] Creating basic page document: ${pageUrl}`);
    
    // Prepare request body with Lighthouse data if available
    const requestBody = {
      project_id: projectId,
      job_id: jobId,
      url: pageUrl,
      title: pageTitle,
      analyzed: false // Will be updated after analysis
    };
    
    // Add performance metrics if available
    if (lighthouseResults && lighthouseResults.success) {
      requestBody.lighthouse_metrics = {
        performance_score: lighthouseResults.metrics.performance,
        accessibility_score: lighthouseResults.metrics.accessibility || 0,
        best_practices_score: lighthouseResults.metrics.bestPractices || 0,
        seo_score: lighthouseResults.metrics.seo || 0,
        first_contentful_paint: lighthouseResults.metrics.firstContentfulPaint,
        largest_contentful_paint: lighthouseResults.metrics.largestContentfulPaint,
        speed_index: lighthouseResults.metrics.speedIndex,
        cumulative_layout_shift: lighthouseResults.metrics.cumulativeLayoutShift || 0,
        total_blocking_time: lighthouseResults.metrics.totalBlockingTime || 0,
        interactive: lighthouseResults.metrics.interactive,
        server_response_time: lighthouseResults.metrics.serverResponseTime,
        dom_size: lighthouseResults.metrics.domSize,
        page_load_time: lighthouseResults.metrics.pageLoadTime,
        dns_time: lighthouseResults.metrics.dnsTime,
        tcp_time: lighthouseResults.metrics.tcpTime,
        ssl_time: lighthouseResults.metrics.sslTime,
        download_time: lighthouseResults.metrics.downloadTime,
        resource_count: lighthouseResults.metrics.resourceCount,
        analysis_duration: lighthouseResults.analysisDuration,
        timestamp: lighthouseResults.timestamp
      };
    }
    
    const response = await fetch(`${backendUrl}/api/pages/discover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[INCREMENTAL-STORAGE] Backend returned ${response.status}: ${errorText}`);
      return null;
    }
    
    const result = await response.json();
    const pageId = result.page?._id;
    const isNewPage = result.isNew;
    console.log(`[INCREMENTAL-STORAGE] ✅ Basic page ${isNewPage ? 'created' : 'found'}: ${pageUrl} (ID: ${pageId})`);
    return { pageId, isNewPage }; // Return both page ID and whether it's new
  } catch (error) {
    console.error(`[INCREMENTAL-STORAGE] Failed to create basic page: ${error.message}`);
    return null;
  }
}

// Send discovered page to backend immediately (incremental storage)
// Returns the pageId from the backend
async function sendDiscoveredPageToBackend(jobId, pageData, baseUrl = null, allowSubdomains = false) {
  try {
    // Domain filtering: Only send internal pages to backend
    if (baseUrl && !isWithinDomain(pageData.url, baseUrl, allowSubdomains)) {
      console.log(`[INCREMENTAL-STORAGE] ⏭️ Skipping external page (not in domain): ${pageData.url}`);
      return null;
    }
    
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
 * Update job substatus in real-time
 * @param {string} jobId - Job ID
 * @param {string} substatus - Current substatus (e.g., "openai_calculation", "playwright_execution", "collecting_info")
 * @param {object} progress - Progress details (optional)
 */
async function updateJobSubstatus(jobId, substatus, progress = {}) {
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    await fetch(`${backendUrl}/jobs/${jobId}/substatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        substatus, 
        ...progress,
        timestamp: new Date().toISOString()
      })
    }).catch(err => {
      console.error(`Failed to update substatus: ${err.message}`);
    });
  } catch (error) {
    // Silent fail - don't block execution
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
  
  // Skip sending empty messages to backend (prevents 400 errors)
  if (!cleanedMessage || cleanedMessage.trim().length === 0) {
    return;
  }
  
  // Determine component name
  const mode = data.mode || 'auto';
  const componentMode = mode === 'auto' ? 'text' : mode;
  let componentName = `CRAWLER-${componentMode.toUpperCase()}`;
  
  if (data.action) {
    switch (data.action) {
      case 'screenshot':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-SCREENSHOT`;
        break;
      case 'video':
        componentName = `CRAWLER-${componentMode.toUpperCase()}-VIDEO`;
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
  console.log(`${cleanedMessage}`);
  
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

// Per-page video recording using CDP Page.startScreencast + ffmpeg
async function recordPageVideo(page, jobId, pageUrl, action) {
  let videoKey = null;
  let cdpSession = null;
  const frames = [];
  const framesDir = `/tmp/aionqa_videos/${jobId}_${Date.now()}`;
  
  try {
    // Ensure directory exists
    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }
    
    // Create CDP session
    cdpSession = await page.context().newCDPSession(page);
    
    // Track start time for frame timing
    const recordingStartTime = Date.now();
    let frameWidth = null;
    let frameHeight = null;
    
    // Frame comparison for intelligent skipping (Requirement 6: skip 90% of frames with no changes)
    let lastFrameHash = null;
    let skippedFramesCount = 0;
    let lastKeptFrameIndex = -1;
    const frameHashes = new Map(); // Store hashes for comparison
    
    // Simple hash function for frame comparison (using first/last bytes and size)
    const getFrameHash = (buffer) => {
      if (buffer.length < 100) return null;
      // Use first 100 bytes, last 100 bytes, and size as hash
      const start = buffer.slice(0, 100).toString('hex');
      const end = buffer.slice(-100).toString('hex');
      return `${buffer.length}_${start.substring(0, 20)}_${end.substring(0, 20)}`;
    };
    
    // Listen for screencast frames
    cdpSession.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      try {
        const frameBuffer = Buffer.from(data, 'base64');
        const frameHash = getFrameHash(frameBuffer);
        const frameTimestamp = Date.now() - recordingStartTime;
        
        // Capture actual frame dimensions from first frame
        if (frames.length === 0 && metadata) {
          frameWidth = metadata.deviceWidth || metadata.pageScaleFactor * metadata.viewportWidth || 1920;
          frameHeight = metadata.deviceHeight || metadata.pageScaleFactor * metadata.viewportHeight || 1080;
          await sendLog(jobId, 'debug', `📐 Video dimensions: ${frameWidth}x${frameHeight}`, { page_url: pageUrl });
        }
        
        // Compare with last frame (Requirement 6: skip 90% of frames with no changes)
        const isSimilar = lastFrameHash && frameHash === lastFrameHash;
        const shouldSkip = isSimilar && (frames.length - lastKeptFrameIndex) < 10; // Keep 1 every 10 similar frames
        
        if (shouldSkip) {
          skippedFramesCount++;
          // Acknowledge frame but don't save it
          await cdpSession.send('Page.screencastFrameAck', { sessionId });
          return;
        }
        
        // Frame has changed or we need to keep this one - save it
        const frameIndex = frames.length;
        const framePath = path.join(framesDir, `frame_${String(frameIndex).padStart(6, '0')}.jpg`);
        
        // If we skipped frames, mark this frame as having skipped frames before it
        if (skippedFramesCount > 0) {
          // We'll add text overlay during encoding
        }
        
        fs.writeFileSync(framePath, frameBuffer);
        
        frames.push({ 
          path: framePath, 
          metadata, 
          sessionId,
          timestamp: frameTimestamp,
          skippedBefore: skippedFramesCount, // Track how many frames were skipped before this one
          isSimilar: isSimilar
        });
        
        lastFrameHash = frameHash;
        lastKeptFrameIndex = frameIndex;
        skippedFramesCount = 0; // Reset counter
        
        // Acknowledge frame receipt
        await cdpSession.send('Page.screencastFrameAck', { sessionId });
      } catch (e) {
        console.error(`Error saving frame: ${e.message}`);
      }
    });
    
    // Start screencast with higher frame capture rate
    // Note: everyNthFrame doesn't guarantee actual FPS, just reduces frame skipping
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1 // Capture every frame (don't skip any)
    });
    
    await sendLog(jobId, 'info', '🎥 Video recording started for page', { page_url: pageUrl });
    
    // Execute the action (navigate, analyze, etc.)
    const result = await action();
    
    // Stop screencast
    await sendLog(jobId, 'info', '🎥 Stopping video recording...', { page_url: pageUrl });
    await cdpSession.send('Page.stopScreencast');
    
    // Give time for final frames to arrive
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Convert frames to video using ffmpeg
    if (frames.length > 0) {
      const recordingDuration = (Date.now() - recordingStartTime) / 1000;
      const actualFPS = frames.length / recordingDuration;
      
      await sendLog(jobId, 'info', `📹 Captured ${frames.length} frames in ${recordingDuration.toFixed(1)}s (${actualFPS.toFixed(2)} FPS avg), encoding to video...`, { 
        page_url: pageUrl,
        frames_captured: frames.length,
        duration_seconds: recordingDuration.toFixed(1),
        avg_fps: actualFPS.toFixed(2)
      });
      
      const videoPath = path.join('/tmp/aionqa_videos', `${jobId}_${Date.now()}.mp4`);
      
      // Create a concat file with proper timing for each frame
      const concatFile = path.join(framesDir, 'concat.txt');
      const concatContent = [];
      
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const nextFrame = frames[i + 1];
        
        // Calculate how long this frame should be shown (in seconds)
        // If frames were skipped before this one, extend duration to represent skipped time
        let duration;
        if (nextFrame) {
          duration = (nextFrame.timestamp - frame.timestamp) / 1000;
        } else {
          // Last frame - show for 1 second
          duration = 1.0;
        }
        
        // If frames were skipped, add time to represent the skipped period
        if (frame.skippedBefore > 0) {
          // Estimate skipped time (assuming ~30fps, each skipped frame is ~0.033s)
          const estimatedSkippedTime = (frame.skippedBefore * 0.033);
          duration += estimatedSkippedTime;
        }
        
        // Minimum frame duration of 0.5 seconds for visibility
        duration = Math.max(duration, 0.5);
        
        concatContent.push(`file '${path.basename(frame.path)}'`);
        concatContent.push(`duration ${duration.toFixed(3)}`);
      }
      
      // Add last frame again (concat demuxer requirement)
      if (frames.length > 0) {
        concatContent.push(`file '${path.basename(frames[frames.length - 1].path)}'`);
      }
      
      fs.writeFileSync(concatFile, concatContent.join('\n'));
      
      // Use ffmpeg concat demuxer to preserve timing
        // Add text overlay for frames with skipped content (Requirement 6: informative video)
        // Create a subtitle file for frames that had skipped content
        const totalSkipped = frames.reduce((sum, f) => sum + (f.skippedBefore || 0), 0);
        let subtitleFile = null;
        
        if (totalSkipped > 0) {
          // Create SRT subtitle file for frames with skipped content
          subtitleFile = path.join(framesDir, 'skipped_frames.srt');
          const subtitleLines = [];
          let subtitleIndex = 1;
          let currentTime = 0;
          
          for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const nextFrame = frames[i + 1];
            
            if (frame.skippedBefore > 0) {
              // Calculate timing for this frame
              const startTime = currentTime;
              const duration = nextFrame 
                ? ((nextFrame.timestamp - frame.timestamp) / 1000) + (frame.skippedBefore * 0.033)
                : 1.0;
              const endTime = startTime + duration;
              
              // Format time for SRT (HH:MM:SS,mmm)
              const formatTime = (seconds) => {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                const secs = Math.floor(seconds % 60);
                const millis = Math.floor((seconds % 60 - secs) * 1000);
                return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
              };
              
              subtitleLines.push(`${subtitleIndex}`);
              subtitleLines.push(`${formatTime(startTime)} --> ${formatTime(endTime)}`);
              subtitleLines.push(`No visible changes detected (${frame.skippedBefore} frames skipped)`);
              subtitleLines.push('');
              subtitleIndex++;
            }
            
            // Update current time
            if (nextFrame) {
              currentTime += ((nextFrame.timestamp - frame.timestamp) / 1000) + ((frame.skippedBefore || 0) * 0.033);
            } else {
              currentTime += 1.0;
            }
          }
          
          fs.writeFileSync(subtitleFile, subtitleLines.join('\n'));
        }
        
        await new Promise((resolve, reject) => {
          const ffmpegCmd = ffmpeg()
            .input(concatFile)
            .inputOptions(['-f concat', '-safe 0'])
            .videoCodec('libx264')
            .outputOptions([
              '-pix_fmt yuv420p',
              '-crf 28',
              '-preset faster',
              '-vsync vfr' // Variable framerate to preserve timing
            ]);
          
          // If we detected frame dimensions, scale video to match
          if (frameWidth && frameHeight) {
            // Ensure dimensions are even (required for h264)
            const evenWidth = Math.floor(frameWidth / 2) * 2;
            const evenHeight = Math.floor(frameHeight / 2) * 2;
            ffmpegCmd.size(`${evenWidth}x${evenHeight}`);
          }
          
          // Burn subtitles into video if we have skipped frames (Requirement 6)
          if (subtitleFile && fs.existsSync(subtitleFile)) {
            ffmpegCmd
              .input(subtitleFile)
              .inputOptions(['-f srt'])
              .videoFilters([
                {
                  filter: 'subtitles',
                  options: {
                    filename: subtitleFile,
                    force_style: 'FontSize=24,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=2'
                  }
                }
              ]);
          }
          
          ffmpegCmd
            .output(videoPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
        });
      
      // Check if video file was created
      if (fs.existsSync(videoPath)) {
        const stats = fs.statSync(videoPath);
        const videoSize = stats.size;
        
        if (videoSize > 0) {
          await sendLog(jobId, 'info', `✅ Video encoded (${(videoSize / 1024 / 1024).toFixed(2)} MB)`, { page_url: pageUrl });
        
        // Read video file
        const videoBuffer = fs.readFileSync(videoPath);
        
        // Upload to MinIO
        const prepareResult = await backendLogger.prepareVideoUpload(jobId, {
          size: videoSize,
          format: 'mp4',
          source: 'per_page_recording',
          pageUrl: pageUrl
        });
        
        if (prepareResult.ok && prepareResult.uploadUrl) {
          const { key, uploadUrl, publicUrl } = prepareResult;
          
          const uploadSuccess = await backendLogger.uploadVideoToPresignedUrl(uploadUrl, videoBuffer);
          
          if (uploadSuccess) {
            videoKey = key;
            
            // Track video media with backend
            try {
              await backendLogger.trackMediaUpload(
                jobId,
                'video',
                {
                  videoId: key,
                  videoKey: key,
                  objectName: key,
                  url: publicUrl,
                  size: videoSize,
                  format: 'mp4',
                  pageUrl: pageUrl
                }
              );
            } catch (trackError) {
              console.error(`Failed to track video media: ${trackError.message}`);
            }
            
            // Log to JOB logs (without page_url) - matches screenshot pattern
            await sendLog(jobId, 'info', `🎥 Video captured for page: ${pageUrl}`, {
              videoKey: key,
              videoId: key,
              action: 'video',
              isVideo: true,
              video_url: publicUrl,
              video_size_mb: (videoSize / 1024 / 1024).toFixed(2),
              pageUrl: pageUrl,
              frames_captured: frames.length,
              duration_seconds: recordingDuration.toFixed(1),
              avg_fps: actualFPS.toFixed(2),
              frameWidth: frameWidth,
              frameHeight: frameHeight,
              format: 'mp4'
            });
            
            // Also log to PAGE logs (with page_url) for page-specific context
            await sendLog(jobId, 'info', `🎥 Video recorded successfully`, {
              page_url: pageUrl,
              videoKey: key,
              videoId: key,
              video_url: publicUrl,
              video_size_mb: (videoSize / 1024 / 1024).toFixed(2),
              action: 'video',
              isVideo: true
            });
          } else {
            await sendLog(jobId, 'error', '❌ Video upload failed', { page_url: pageUrl });
          }
        }
        
          // Clean up temp files
          try {
            fs.unlinkSync(videoPath);
            fs.rmSync(framesDir, { recursive: true, force: true });
          } catch (e) {
            // Ignore cleanup errors
          }
        } else {
          await sendLog(jobId, 'warn', '⚠️ Video file is empty', { page_url: pageUrl });
        }
      } else {
        await sendLog(jobId, 'warn', '⚠️ Video file was not created', { page_url: pageUrl });
      }
    } else {
      await sendLog(jobId, 'info', '⚠️ No frames captured - video not created', { page_url: pageUrl });
    }
    
    return { result, videoKey };
    
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Video recording failed: ${error.message}`, { 
      page_url: pageUrl,
      errorStack: error.stack
    });
    
    // Clean up temp files on error
    try {
      if (fs.existsSync(framesDir)) {
        fs.rmSync(framesDir, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    
    // Execute action anyway even if recording fails
    try {
      const result = await action();
      return { result, videoKey: null };
    } catch (actionError) {
      throw actionError;
    }
  } finally {
    // Cleanup CDP session
    if (cdpSession) {
      try {
        await cdpSession.detach();
      } catch (e) {
        // Ignore detach errors
      }
    }
  }
}

// Detect captcha on page
async function detectCaptcha(page, jobId) {
  try {
    // reCAPTCHA v3 often shows only the "protected by reCAPTCHA" badge.
    // That is not an interactive challenge and should not be treated as a blocker.
    const recaptchaBadgeVisible = await page.locator('.grecaptcha-badge').first().isVisible().catch(() => false);
    if (recaptchaBadgeVisible) {
      await sendLog(jobId, 'info', `ℹ️ reCAPTCHA badge detected (likely v3) — not treating as a blocking captcha`, {
        captcha_type: 'reCAPTCHA badge',
        selector: '.grecaptcha-badge',
        page_url: page.url(),
        action: 'captcha_badge_detected'
      });
    }

    // Common captcha selectors and indicators
    const captchaIndicators = [
      // Mailpoet Captcha (specific detection)
      'form#mailpoet_captcha_form',
      'form[id*="mailpoet"]',
      'form[class*="mailpoet"]',
      'form[id*="captcha"][class*="mailpoet"]',
      'div[id*="mailpoet"][id*="captcha"]',
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
      'input[name*="captcha"]',
      // Some apps expose a hidden token field that must be populated (e.g. FMClarity)
      '#captcha-token',
      'input[name="captcha_token"]'
    ];
    
    for (const selector of captchaIndicators) {
      const loc = page.locator(selector).first();
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      const bbox = await loc.boundingBox().catch(() => null);
      if (!bbox || bbox.width < 8 || bbox.height < 8) {
        continue;
      }

      // Heuristic: reCAPTCHA v3 renders a small badge in the bottom-right corner (often iframe or div).
      // That badge is not a "challenge" and should not trigger captcha handling.
      if (selector.includes('recaptcha') && bbox.width <= 270 && bbox.height <= 70) {
        await sendLog(jobId, 'info', `ℹ️ reCAPTCHA widget looks like v3 badge (non-blocking)`, {
          captcha_type: 'reCAPTCHA badge',
          selector,
          page_url: page.url(),
          action: 'captcha_badge_widget_detected',
          bbox
        });
        continue;
      }

      // Heuristic: Some sites label the badge container generically as "captcha" (e.g. div[class*="captcha"])
      // even though it's just the passive badge. Treat tiny widgets as non-blocking unless it's a real input/form.
      const selectorIsActionableCaptcha =
        selector.startsWith('input') ||
        selector.startsWith('form') ||
        selector.includes('#captcha-token') ||
        selector.includes('captcha_token') ||
        selector.includes('mailpoet');
      if (!selectorIsActionableCaptcha && selector.includes('captcha') && bbox.width <= 270 && bbox.height <= 70) {
        await sendLog(jobId, 'info', `ℹ️ Small captcha-labeled widget looks like passive badge (non-blocking)`, {
          captcha_type: 'captcha badge',
          selector,
          page_url: page.url(),
          action: 'captcha_badge_widget_detected',
          bbox
        });
        continue;
      }
        const captchaType = selector.includes('mailpoet') ? 'Mailpoet Captcha' :
                           selector.includes('recaptcha') ? 'reCAPTCHA' :
                           selector.includes('hcaptcha') ? 'hCaptcha' :
                           selector.includes('turnstile') ? 'Cloudflare Turnstile' :
                           'Generic Captcha';
        
        await sendLog(jobId, 'warn', `⚠️ CAPTCHA DETECTED: ${captchaType} found on page`, {
          captcha_type: captchaType,
          selector: selector,
          page_url: page.url(),
          action: 'captcha_detection',
          visible: true,
          bbox
        });
        
        return {
          detected: true,
          type: captchaType,
          selector: selector,
          visible: true,
          bbox
        };
    }
    
    return { detected: false };
  } catch (error) {
    console.error(`Captcha detection error: ${error.message}`);
    return { detected: false, error: error.message };
  }
}

// Attempt to handle captcha with human-like behavior
async function handleCaptcha(page, jobId, captchaInfo) {
  try {
    // If it's not visible, it's not actionable. Avoid claiming "captcha still present".
    if (captchaInfo && captchaInfo.visible === false) {
      await sendLog(jobId, 'info', `ℹ️ Captcha indicator not visible — skipping captcha handling`, {
        captcha_type: captchaInfo.type,
        selector: captchaInfo.selector,
        action: 'captcha_not_visible_skip'
      });
      return { passed: true, skipped: true };
    }

    await sendLog(jobId, 'info', `🔐 Attempting to handle ${captchaInfo.type} with human-like behavior...`, {
      captcha_type: captchaInfo.type,
      action: 'captcha_handling'
    });
    
    // Add human-like behavior: random mouse movements and scrolling
    try {
      // Random scroll (humans scroll to see the page)
      const scrollAmount = 100 + Math.random() * 200;
      await page.evaluate((amount) => {
        window.scrollBy(0, amount);
      }, scrollAmount);
      await page.waitForTimeout(500 + Math.random() * 1000);
      
      // Random mouse movement (humans move mouse even when not clicking)
      await page.mouse.move(100 + Math.random() * 500, 100 + Math.random() * 500);
      await page.waitForTimeout(200 + Math.random() * 500);
    } catch (behaviorError) {
      // Ignore behavior errors, continue with captcha handling
      console.warn(`[CAPTCHA] Human behavior injection warning: ${behaviorError.message}`);
    }
    
    // Try to interact with CAPTCHA if it's clickable
    try {
      // For reCAPTCHA, try clicking the checkbox
      if (captchaInfo.type.includes('reCAPTCHA') || captchaInfo.selector.includes('recaptcha')) {
        const recaptchaFrame = page.locator('iframe[src*="recaptcha"]').first();
        const isVisible = await recaptchaFrame.isVisible().catch(() => false);
        if (isVisible) {
          await sendLog(jobId, 'info', `🖱️ Attempting to interact with reCAPTCHA checkbox...`, {
            action: 'captcha_interaction'
          });
          
          // Click the iframe region (best-effort; iframe contents are cross-origin)
          const box = await recaptchaFrame.boundingBox().catch(() => null);
          if (box) {
            // Move mouse to checkbox with human-like delay
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
            await page.waitForTimeout(300 + Math.random() * 500);
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(2000 + Math.random() * 3000); // Wait for challenge to appear/solve
          }
        }
      }
      
      // For hCaptcha, try clicking the checkbox
      if (captchaInfo.type.includes('hCaptcha') || captchaInfo.selector.includes('hcaptcha')) {
        const hcaptchaCheckbox = await page.$('iframe[src*="hcaptcha"]').catch(() => null);
        if (hcaptchaCheckbox) {
          await sendLog(jobId, 'info', `🖱️ Attempting to interact with hCaptcha checkbox...`, {
            action: 'captcha_interaction'
          });
          
          const box = await hcaptchaCheckbox.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
            await page.waitForTimeout(300 + Math.random() * 500);
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(2000 + Math.random() * 3000);
          }
        }
      }
      
      // For Cloudflare Turnstile, try clicking
      if (captchaInfo.type.includes('Turnstile') || captchaInfo.selector.includes('turnstile')) {
        const turnstileElement = await page.$(captchaInfo.selector).catch(() => null);
        if (turnstileElement) {
          await sendLog(jobId, 'info', `🖱️ Attempting to interact with Turnstile...`, {
            action: 'captcha_interaction'
          });
          
          await turnstileElement.click({ timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(2000 + Math.random() * 3000);
        }
      }
    } catch (interactionError) {
      console.warn(`[CAPTCHA] Interaction attempt warning: ${interactionError.message}`);
    }

    // Some apps (including SSO wrappers) require a hidden captcha token field to be populated.
    // This isn't a "solver" but we can wait for the token to appear (best-effort).
    try {
      if (captchaInfo.selector === '#captcha-token' || captchaInfo.selector === 'input[name="captcha_token"]') {
        await sendLog(jobId, 'info', `⏳ Waiting for captcha token field to populate...`, {
          action: 'captcha_token_wait',
          selector: captchaInfo.selector
        });
        for (let i = 0; i < 30; i++) {
          const token = await page.$eval(
            captchaInfo.selector,
            (el) => (el && 'value' in el ? String(el.value || '') : ''),
          ).catch(() => '');
          if (token && token.trim().length > 10) {
            await sendLog(jobId, 'info', `✅ Captcha token populated (${token.trim().length} chars)`, {
              action: 'captcha_token_ready',
              selector: captchaInfo.selector
            });
            break;
          }
          await page.waitForTimeout(500);
        }
      }
    } catch (tokenWaitError) {
      console.warn(`[CAPTCHA] Token wait warning: ${tokenWaitError.message}`);
    }
    
    // Wait longer for potential automatic solving or manual intervention
    // Increased wait time to give more chance for CAPTCHA to be solved
    await page.waitForTimeout(8000 + Math.random() * 4000);
    
    // Check if captcha is still present
    const stillPresent = await page.locator(captchaInfo.selector).first().isVisible().catch(() => false);
    
    if (!stillPresent) {
      await sendLog(jobId, 'info', `✅ CAPTCHA PASSED: ${captchaInfo.type} was resolved`, {
        captcha_type: captchaInfo.type,
        action: 'captcha_passed',
        page_url: page.url()
      });
      return { passed: true };
    } else {
      // Check if CAPTCHA challenge appeared (iframe might have loaded)
      const challengeIframeVisible = await page
        .locator('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenges"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (challengeIframeVisible) {
        await sendLog(jobId, 'info', `⏳ CAPTCHA challenge appeared, waiting for resolution...`, {
          action: 'captcha_challenge_waiting'
        });
        // Wait longer for challenge to be solved
        await page.waitForTimeout(15000 + Math.random() * 10000);
      }
      
      const stillPresentAfterWait = await page.locator(captchaInfo.selector).first().isVisible().catch(() => false);
      if (!stillPresentAfterWait) {
        await sendLog(jobId, 'info', `✅ CAPTCHA PASSED after challenge: ${captchaInfo.type} was resolved`, {
          captcha_type: captchaInfo.type,
          action: 'captcha_passed',
          page_url: page.url()
        });
        return { passed: true };
      }
      
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
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
      console.warn('Page DOM not fully loaded after 30s, continuing anyway');
    });
    
    // Scroll to bottom and back to top to ensure full page is loaded
    try {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(100);
    } catch (scrollError) {
      // Ignore scroll errors
    }
    
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
    // Include screenshot URL in metadata so UI can display it as thumbnail
    await sendLog(jobId, 'info', `📸 Screenshot captured: ${action}`, { 
      page_url: pageUrl, // Add page_url to route to logs_pages
      screenshotKey: key,
      screenshotId: key, // Use backend-generated key as screenshotId
      screenshot_file_id: key, // Alternative field name for UI detection
      screenshot_url: screenshotPath, // Direct URL to screenshot (preferred)
      screenshotPath: screenshotPath, // Also include as screenshotPath for compatibility
      action: 'screenshot',
      url: pageUrl,
      title: await page.title(),
      resolution: 'full_hd',
      timestamp: new Date().toISOString(),
      isScreenshot: true, // Flag to indicate this is a screenshot log
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
const VALIDATION_PROMPT_SLUGS = {
  login: 'validate-login-success',
  crawl: 'validate-crawl-success',
  form_test: 'validate-form-success',
  link_click: 'validate-navigation-success',
  page_analysis: 'validate-analysis-success'
};

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
    
    // Get localStorage and sessionStorage safely
    const localStorage = await safeGetLocalStorage(page);
    const sessionStorage = await safeGetSessionStorage(page);
    
    const promptSlug = VALIDATION_PROMPT_SLUGS[operation] || VALIDATION_PROMPT_SLUGS.page_analysis;
    const urlPath = new URL(currentUrl).pathname || '/';
    const authCookies = allCookies.filter(c => {
      const name = (c.name || '').toLowerCase();
      return name.includes('auth') || name.includes('session');
    });

    const promptPayload = {
      page_url: currentUrl,
      page_title: currentTitle,
      url_path: urlPath,
      page_content: pageContent.substring(0, 50000),
      expected_outcome: expectedOutcome || '',
      approach,
      operation,
      cookies_total: allCookies.length,
      auth_cookie_names: authCookies.map(c => c.name).join(', '),
      cookies_json: JSON.stringify(allCookies, null, 2),
      local_storage_json: JSON.stringify(localStorage, null, 2),
      session_storage_json: JSON.stringify(sessionStorage, null, 2),
      screenshot_available: Boolean(validationScreenshot?.screenshotId),
      additional_prompt_text: context.additional_prompt_text || ''
    };

    const validation = await aiConversationLogger.makeAICallWithPrompt(
      promptSlug,
      promptPayload,
      jobId,
      'unified-crawler',
      currentUrl,
      validationScreenshot?.screenshotId,
      {
        approach,
        operation,
        validation_type: `${operation}_success`,
        page_title: currentTitle,
        cookies_count: allCookies.length,
        localStorage_count: Object.keys(localStorage).length,
        sessionStorage_count: Object.keys(sessionStorage).length,
        screenshot_id: validationScreenshot?.screenshotId,
        screenshot_path: validationScreenshot?.screenshotPath
      }
    );
    
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
  await sendLog(options.jobId || 'debug', 'info', `🌐 Launching embedded Chromium browser (runner mode)`);
  
  // Import stealth configuration
  const { 
    getStealthLaunchArgs, 
    getStealthContextOptions, 
    injectStealthScripts 
  } = await import('../browser/stealth-config.js');
  
  let browser;
  
  try {
    // Launch local embedded browser with stealth configuration
    browser = await chromium.launch({
      headless: true,
      args: getStealthLaunchArgs()
    });
    
    await sendLog(options.jobId || 'server', 'info', `✅ Embedded browser launched successfully with stealth configuration`);
  } catch (error) {
    await sendLog(options.jobId || 'server', 'error', `Failed to launch embedded browser: ${error.message}`);
    throw new Error(`Embedded browser launch failed: ${error.message}`);
  }
  
  // Configure browser context with stealth options and video recording support
  const enableRecording = options.enable_video_recording !== false;
  const contextOptions = getStealthContextOptions({
    viewport: { width: 1920, height: 1080 },
    userAgent: options.userAgent, // Allow override if provided
    recordVideo: enableRecording ? {
      dir: '/tmp/aionqa_videos',
      size: { width: 1920, height: 1080 }
    } : undefined
  });
  
  if (enableRecording) {
    await sendLog(options.jobId || 'server', 'info', `🎥 Video recording enabled for session`);
  }
  
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  
  // Inject stealth scripts to hide automation
  await injectStealthScripts(page);
  
  // Set viewport to match window size (1920x1080 from launch args)
  await page.setViewportSize({ width: 1920, height: 1080 });
  
  console.log('Context and page created, calling callbacks...');
  console.log('options.onContextReady exists:', !!options.onContextReady);
  console.log('options.onContextReady type:', typeof options.onContextReady);
  console.log('options.onPageReady exists:', !!options.onPageReady);
  
  // Call onContextReady callback for video recording (if provided)
  if (options.onContextReady && typeof options.onContextReady === 'function') {
    try {
      console.log('Calling onContextReady callback');
      options.onContextReady(context, page);
    } catch (e) {
      console.error(`onContextReady callback error:`, e);
    }
  } else {
    console.log('⚠️ onContextReady callback not available or not a function');
  }
  
  // Call onPageReady callback for streaming (if provided)
  if (options.onPageReady && typeof options.onPageReady === 'function') {
    try {
      console.log('Calling onPageReady callback');
      options.onPageReady(page);
    } catch (e) {
      console.error(`onPageReady callback error:`, e);
    }
  }
  
  let videoFileId = null;
  let screenshotFileId = null;
  
  // Note: Per-page video recording is handled within the crawl loop
  // Not recording at browser session level anymore
  
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
            // Get public URL for screenshot
            const publicUrl = prepareResult.publicUrl || `${process.env.BACKEND_URL || 'http://back:4000'}/files/${key}`;
            await sendLog(options.job_id || 'unknown', 'info', `📸 Screenshot captured successfully: ${key}`, {
              screenshotKey: key,
              screenshotId: key,
              screenshot_file_id: key,
              screenshot_url: publicUrl,
              screenshotPath: publicUrl,
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
    
    // Note: Video recording moved to per-page level in recursiveCrawl function
    
    return {
      ...result,
      video_file_id: videoFileId,
      screenshot_file_id: screenshotFileId
    };
    
  } finally {
    if (options.beforeBrowserClose && typeof options.beforeBrowserClose === 'function') {
      try {
        await options.beforeBrowserClose({ browser, context, page });
      } catch (callbackError) {
        const jobIdForLogs = options.job_id || options.jobId || 'unknown';
        await sendLog(jobIdForLogs, 'warn', `⚠️ Video finalization callback failed: ${callbackError.message}`);
        console.error('beforeBrowserClose callback error:', callbackError);
      }
    }
    await browser.close();
  }
}

// Mode-specific operation handlers
const modeHandlers = {
  // Optimized mode - NEW: QA-like testing with minimal token usage
  optimized: async (page, context, openaiClient, operation) => {
    const jobId = context.job_id || 'unknown-job';
    const projectId = context.project_id || null;
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    const allowSubdomains = context?.allow_subdomains === true;
    
    await sendLog(jobId, 'info', `🚀 OPTIMIZED MODE: QA-like testing with minimal token usage`);
    
    try {
      // Initialize optimized workflow analyzer (pass aiLogger and context if available)
      const optimizedAnalyzer = new OptimizedWorkflowAnalyzer(backendUrl, aiConversationLogger, context);
      
      // Get or create page ID
      const pageUrl = page.url();
      const pageTitle = await page.title();
      const pageResult = await sendBasicPageToBackend(jobId, pageUrl, pageTitle, projectId, pageUrl, null, allowSubdomains);
      const pageId = pageResult?.pageId || pageResult;
      
      // Analyze page with optimized approach
      const analysisResult = await optimizedAnalyzer.analyzePage(page, jobId, pageId, projectId, openaiClient);
      
      return {
        success: true,
        approach: 'optimized',
        message: `Optimized QA-like analysis completed`,
        details: {
          total_interactions: analysisResult.total_interactions,
          page_data_collected: true,
          ax_tree_collected: !!analysisResult.page_data.ax_tree,
          dom_snapshot_collected: !!analysisResult.page_data.dom_snapshot,
          visible_text_length: analysisResult.page_data.visible_text.length,
          interactive_elements_count: analysisResult.page_data.interactive_elements.interactive_count
        }
      };
      
    } catch (error) {
      console.error('[OPTIMIZED-MODE] Error:', error);
      await sendLog(jobId, 'error', `❌ Optimized mode failed: ${error.message}`);
      return {
        success: false,
        approach: 'optimized',
        message: `Optimized mode failed: ${error.message}`,
        error: error.message
      };
    }
  },

  // Workflow mode - NEW: Uses workflow-based analysis and testing
  workflow: async (page, context, openaiClient, operation) => {
    const jobId = context.job_id || 'unknown-job';
    const projectId = context.project_id || null;
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    const requestedMaxPages = context.options?.max_pages ?? context.max_pages;
    const requestedMaxDepth = context.options?.max_depth ?? context.max_depth;
    const allowSubdomains = context?.allow_subdomains === true;

    // Domain crawl: use backend max_pages/max_depth so this job recursively follows links page-by-page.
    // Single-page: max_pages <= 1 and max_depth <= 0 → only the seed URL is analyzed.
    const maxPages = (requestedMaxPages != null && requestedMaxPages > 0) ? Math.min(Number(requestedMaxPages), 500) : 1;
    const maxDepth = (requestedMaxDepth != null && requestedMaxDepth >= 0) ? Math.min(Number(requestedMaxDepth), 10) : 0;
    const isSinglePageScan = maxPages <= 1 && maxDepth <= 0;

    await sendLog(
      jobId,
      'info',
      isSinglePageScan
        ? `🔄 WORKFLOW MODE: Single-page analysis. max_pages=${maxPages}, max_depth=${maxDepth}`
        : `🔄 WORKFLOW MODE: Domain crawl (recursive). max_pages=${maxPages}, max_depth=${maxDepth} — will discover and analyze internal links page-by-page`
    );
    
    // Set AI logger context (incl. ai_services from helper config) so token-based service selection works
    if (aiConversationLogger && context) {
      aiConversationLogger.context = { ...aiConversationLogger.context, ...context };
    }
    // Initialize workflow analyzer and enhanced executor with context
    const workflowAnalyzer = new WorkflowAnalyzer(backendUrl, aiConversationLogger, context);
    // For page analysis workflows, don't retry legs on failure (no second attempt)
    const workflowExecutor = new WorkflowExecutor(
      backendUrl,
      aiConversationLogger,
      backendLogger,
      {
        ...context,
        maxIterations: 1 // No retry for page analysis workflows
      },
      context.videoRecorder || null
    );
    const executeWorkflowFlag =
      context.execute_workflow !== undefined
        ? context.execute_workflow
        : (context.options?.execute_workflow !== undefined
            ? context.options.execute_workflow
            : true);
    const shouldExecuteWorkflowLegs = executeWorkflowFlag !== false;
    let workflowTemplateLoaded = false;

    await workflowAnalyzer.loadWorkflowTemplate();
    const workflowCapabilities = workflowAnalyzer.getCapabilities();
    context.workflow_capabilities = workflowCapabilities;
    const shouldRunPerformanceAnalysis = workflowCapabilities.usesPerformanceAudit === true;
    // CRITICAL: Disable link discovery for single-page scans
    // Domain crawl: always discover and queue internal links. Single-page: no link discovery.
    const shouldDiscoverLinks = !isSinglePageScan;
    const hasAdvancedAnalysis = (workflowCapabilities.usesPlaywrightAnalysis === true) || (workflowCapabilities.usesAIModel === true);
    
    const visitedUrls = new Set();
    const analyzedPageUrls = new Set();
    // Ensure URL has a scheme (page.goto fails with "invalid URL" for e.g. "tests.aionqa.com")
    const ensureUrlHasScheme = (url) => {
      if (!url || typeof url !== 'string') return url;
      const t = url.trim();
      if (t.startsWith('http://') || t.startsWith('https://')) return t;
      return `https://${t}`;
    };
    const canonicalizeUrl = (url) => {
      const withScheme = ensureUrlHasScheme(url);
      if (!withScheme) return '';
      try {
        const u = new URL(withScheme);
        u.hash = '';
        if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
          u.port = '';
        }
        const normalizedPath = u.pathname.replace(/\/+$/, '') || '/';
        return `${u.protocol}//${u.host}${normalizedPath}${u.search}`;
      } catch {
        const noHash = String(withScheme).split('#')[0];
        return noHash.replace(/\/+$/, '') || noHash;
      }
    };
    // Get initial URL - handle case where page might navigate after cookies are loaded
    // IMPORTANT: Don't access page.url() immediately - page might not be ready or context might be destroyed
    // Use the seed URL from context instead
    let seedUrl = context.seed_url || context.start_url || context.url || (context.options && context.options.start_url);
    
    // If no seed URL in context, try to get from page as last resort
    if (!seedUrl || seedUrl === 'about:blank') {
      try {
        seedUrl = page.url();
        if (seedUrl && seedUrl !== 'about:blank') {
          await sendLog(jobId, 'info', `📍 Using page URL as seed URL: ${seedUrl}`);
        }
      } catch (pageError) {
        // Page context might be destroyed, continue with what we have
        await sendLog(jobId, 'warn', `⚠️ Could not get page URL: ${pageError.message}`);
      }
    }
    
    // Final check - if still no URL, throw error
    if (!seedUrl || seedUrl === 'about:blank') {
      await sendLog(jobId, 'error', `❌ No seed URL found in context (seed_url: ${context.seed_url}, start_url: ${context.start_url}, url: ${context.url})`);
      throw new Error('No seed URL found in context - cannot start crawl');
    }
    seedUrl = ensureUrlHasScheme(seedUrl);
    
    const urlQueue = [{ url: canonicalizeUrl(seedUrl), depth: 0 }];
    await sendLog(jobId, 'info', `📍 Starting workflow crawl from seed URL: ${seedUrl}`);
    let pagesAnalyzed = 0;
    const allWorkflows = [];
    
    try {
      while (urlQueue.length > 0 && pagesAnalyzed < maxPages) {
        const { url: rawUrl, depth } = urlQueue.shift();
        const currentUrl = canonicalizeUrl(rawUrl) || ensureUrlHasScheme(rawUrl) || rawUrl;
        
        // Skip if already visited or too deep
        if (visitedUrls.has(currentUrl) || depth > maxDepth) {
          continue;
        }
        
        // Check if job has been cancelled
        try {
          const axios = (await import('axios')).default;
          const headers = {};
          if (context.runner_token) {
            headers['Authorization'] = `Bearer ${context.runner_token}`;
          }
          // Use /api/jobs/:id which doesn't require authentication (runner-friendly endpoint)
          const jobStatusResponse = await axios.get(`${backendUrl}/api/jobs/${jobId}`, {
            headers,
            timeout: 5000
          });
          const jobStatus = jobStatusResponse.data?.status;
          if (jobStatus === 'cancelled' || jobStatus === 'failed') {
            await sendLog(jobId, 'info', `⏹️ Job ${jobStatus}, stopping crawl`);
            break;
          }
        } catch (statusCheckError) {
          // Continue if status check fails (don't block crawl)
          console.warn(`Failed to check job status: ${statusCheckError.message}`);
        }
        
        visitedUrls.add(currentUrl);
        pagesAnalyzed++;
        
        await sendLog(jobId, 'info', `📄 Page ${pagesAnalyzed}/${maxPages} (depth ${depth}): ${currentUrl}`);
        
        // Navigate to page if it's not the current page
        // First, check current URL safely (might have navigated due to cookies)
        let currentPageUrl;
        try {
          currentPageUrl = page.url();
        } catch (urlError) {
          await sendLog(jobId, 'warn', `⚠️ Could not get current page URL: ${urlError.message}, navigating to ${currentUrl}`);
          currentPageUrl = null; // Force navigation
        }
        let finalUrl = currentUrl;
        if (currentPageUrl !== currentUrl) {
          try {
            // Capture response status and retry transient 5xx (common with CDNs returning 503).
            let response = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            let status = response ? response.status() : null;
            if (status && status >= 500) {
              await sendLog(jobId, 'warn', `⚠️ Navigation returned HTTP ${status} for ${currentUrl} — retrying once after backoff...`, {
                component: 'CRAWLER-TEXT',
                action: 'nav_retry_5xx',
                url: currentUrl,
                status
              });
              await page.waitForTimeout(3000);
              response = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              status = response ? response.status() : null;
              if (status && status >= 500) {
                await sendLog(jobId, 'warn', `⚠️ Navigation still HTTP ${status} after retry`, {
                  component: 'CRAWLER-TEXT',
                  action: 'nav_retry_5xx_failed',
                  url: currentUrl,
                  status
                });
              }
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
              console.warn('Page DOM not fully loaded after 30s, continuing with analysis');
            });
            // Wait a bit for any post-navigation redirects
            await page.waitForTimeout(1000);
            // Get the final URL after navigation (may have redirected)
            try {
              finalUrl = page.url();
              if (finalUrl !== currentUrl) {
                await sendLog(jobId, 'info', `🔄 Page redirected from ${currentUrl} to ${finalUrl}`);
              }
            } catch (urlError) {
              console.warn(`Could not get page URL after navigation: ${urlError.message}`);
            }
          } catch (navError) {
            await sendLog(jobId, 'warn', `⚠️ Navigation failed: ${navError.message}`);
            // Try to continue with current page
            try {
              finalUrl = page.url();
            } catch (urlError) {
              // Page context might be destroyed, skip this page
              await sendLog(jobId, 'error', `❌ Page context destroyed after navigation, skipping page`);
              continue;
            }
          }
        } else {
          // Already on the page, but cookies might have caused a navigation
          // Wait a bit and check if URL changed
          await page.waitForTimeout(1000);
          try {
            const actualUrl = page.url();
            if (actualUrl !== currentUrl) {
              finalUrl = actualUrl;
              await sendLog(jobId, 'info', `🔄 Page navigated from ${currentUrl} to ${finalUrl} (likely due to cookies)`);
            }
          } catch (urlError) {
            console.warn(`Could not get page URL: ${urlError.message}`);
          }
        }
        
        // CRITICAL: Check for login page redirection and handle it
        // ONLY run if explicitly configured AND not a login job
        // Login jobs are identified by jobType in context (set by backend/runner)
        const isLoginJob = context?.jobType === 'login' || 
                          context?.job_type === 'login' || 
                          context?.isLoginJob === true ||
                          context?.preventCrawling === true;
        
        // Only check for login redirects if explicitly configured (not default)
        // AND only for crawl jobs (not login jobs)
        const handleLoginRedirect = context.handle_login_redirect ?? context?.options?.handle_login_redirect;
        if (!isLoginJob && handleLoginRedirect && (handleLoginRedirect === 'auto_retry' || handleLoginRedirect === 'fail')) {
          try {
            await sendLog(jobId, 'info', `🔐 [LOGIN-REDIRECT] handler check: handle_login_redirect=${handleLoginRedirect}`, {
              final_url: finalUrl,
              intended_url: currentUrl,
              login_url: context?.login_url || null,
              job_type: context?.jobType || context?.job_type || null
            });
            const { handleLoginRedirect: handleRedirect } = await import('../login/login-redirect-handler.js');
            const redirectResult = await handleRedirect(page, jobId, finalUrl, currentUrl, context, openaiClient, handleLoginRedirect);
            
            if (redirectResult && redirectResult.reauthenticated) {
              // Re-authentication successful, update context and continue from root
              await sendLog(jobId, 'info', `✅ Re-authenticated successfully, continuing crawl from ${redirectResult.newUrl}`);
              // Update context with new cookies
              if (redirectResult.cookies) {
                context.cookies = redirectResult.cookies;
                // Also update browser context cookies
                try {
                  await page.context().addCookies(redirectResult.cookies);
                } catch (cookieError) {
                  console.warn(`Failed to update browser cookies: ${cookieError.message}`);
                }
              }
              // Reset URL queue to start from root
              urlQueue.length = 0;
              urlQueue.push({ url: redirectResult.newUrl, depth: 0 });
              visitedUrls.clear(); // Clear visited URLs to restart crawl
              pagesAnalyzed = 0; // Reset page counter
              await sendLog(jobId, 'info', `🔄 Restarting crawl from root path with fresh authentication`);
              continue; // Skip current page and start fresh
            } else {
              await sendLog(jobId, 'info', `🔐 [LOGIN-REDIRECT] handler did not reauthenticate (continuing)`, {
                final_url: finalUrl,
                intended_url: currentUrl
              });
            }
          } catch (redirectError) {
            // If handleLoginRedirect is 'fail', the error is already thrown
            // If it's 'auto_retry' and fails, we should also fail
            await sendLog(jobId, 'error', `❌ Login redirect handling failed: ${redirectError.message}`);
            throw redirectError;
          }
        }
        
        // Run Lighthouse analysis on the page if requested by workflow
        let lighthouseResults = null;
        if (shouldRunPerformanceAnalysis) {
          try {
            await sendLog(jobId, 'info', `🔍 Running performance analysis...`);
            const { analyzePageWithLighthouse } = await import('../lighthouse-analyzer.js');
            lighthouseResults = await analyzePageWithLighthouse(page, jobId, finalUrl);
            
            if (lighthouseResults.success) {
              await sendLog(jobId, 'info', `✅ Lighthouse analysis completed - Performance: ${lighthouseResults.metrics.performance}/100`, {
                page_url: finalUrl,
                performance_score: lighthouseResults.metrics.performance,
                accessibility_score: lighthouseResults.metrics.accessibility,
                best_practices_score: lighthouseResults.metrics.bestPractices,
                seo_score: lighthouseResults.metrics.seo,
                first_contentful_paint: lighthouseResults.metrics.firstContentfulPaint,
                largest_contentful_paint: lighthouseResults.metrics.largestContentfulPaint,
                speed_index: lighthouseResults.metrics.speedIndex,
                cumulative_layout_shift: lighthouseResults.metrics.cumulativeLayoutShift,
                total_blocking_time: lighthouseResults.metrics.totalBlockingTime,
                interactive: lighthouseResults.metrics.interactive
              });
            } else if (lighthouseResults.skipped) {
              await sendLog(jobId, 'info', `ℹ️ Lighthouse analysis skipped: ${lighthouseResults.error}`);
            } else {
              await sendLog(jobId, 'warn', `⚠️ Lighthouse analysis failed: ${lighthouseResults.error}`);
            }
          } catch (lighthouseError) {
            await sendLog(jobId, 'warn', `⚠️ Lighthouse analysis error: ${lighthouseError.message}`);
          }
        }
        
        // Create basic page document first
        // Handle case where execution context was destroyed due to navigation
        let pageTitle = 'Unknown';
        let actualPageUrl = finalUrl;
        try {
          // Wait for page to stabilize after potential navigation from cookies
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1000);
          pageTitle = await page.title();
          actualPageUrl = page.url();
        } catch (titleError) {
          // Execution context might have been destroyed due to navigation
          await sendLog(jobId, 'warn', `⚠️ Could not get page title/URL (context may have been destroyed): ${titleError.message}`);
          // Try to wait for page to stabilize and retry
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);
            pageTitle = await page.title().catch(() => 'Unknown');
            actualPageUrl = await page.url().catch(() => finalUrl);
          } catch (retryError) {
            await sendLog(jobId, 'error', `❌ Page context still unavailable after retry: ${retryError.message}`);
            // Skip this page and continue
            continue;
          }
        }
        // Use project's start_url for domain filtering, not the current page URL
        const projectStartUrl = context.start_url || actualPageUrl; // Fallback to current URL if not provided
        const actualPageUrlCanonical = canonicalizeUrl(actualPageUrl);
        if (actualPageUrlCanonical && analyzedPageUrls.has(actualPageUrlCanonical)) {
          await sendLog(jobId, 'info', `⏭️ Page ${actualPageUrlCanonical} already analyzed in this job (in-memory dedupe), skipping duplicate analysis`);
          continue;
        }
        const pageResult = await sendBasicPageToBackend(
          jobId,
          actualPageUrlCanonical || actualPageUrl,
          pageTitle,
          projectId,
          projectStartUrl,
          lighthouseResults,
          allowSubdomains
        );
        const createdPageId = pageResult?.pageId || pageResult; // Extract pageId from object or use as-is if string
        
        // CRITICAL: Check if this page has already been analyzed in this job to prevent duplicate workflows
        let existingWorkflow = null;
        try {
          const axios = (await import('axios')).default;
          const headers = {};
          if (context.runner_token) {
            headers['Authorization'] = `Bearer ${context.runner_token}`;
          }
          const workflowsResponse = await axios.get(`${backendUrl}/api/workflows`, {
            params: {
              project_id: projectId,
              page_id: createdPageId,
              job_id: jobId
            },
            headers,
            timeout: 5000
          });
          
          // Response can be array or object with workflows property
          const workflowsArray = Array.isArray(workflowsResponse.data) 
            ? workflowsResponse.data 
            : (workflowsResponse.data?.workflows || []);
          
          if (workflowsArray.length > 0) {
            // Find workflow for this page+job combination
            existingWorkflow = workflowsArray.find(w => 
              w.page_id?.toString() === createdPageId.toString() && 
              w.job_id?.toString() === jobId.toString()
            );
            
            if (existingWorkflow) {
              await sendLog(jobId, 'info', `⏭️ Page ${actualPageUrl} already analyzed in this job (workflow: ${existingWorkflow._id}), skipping duplicate analysis`);
              // Skip analysis but still process links if needed
              continue;
            }
          }
        } catch (workflowCheckError) {
          // If check fails, log warning but continue (don't block analysis)
          console.warn(`[WORKFLOW] Could not check for existing workflow: ${workflowCheckError.message}`);
        }
        
        // Check if we should skip AI analysis
        let analysisResultForCurrentPage = null;
        const skipAIAnalysisOption = context.options?.skip_ai_analysis || false;
        const disableAICompletely = context.options?.disable_ai_completely || false;
        const hasWorkflowSteps = workflowAnalyzer.hasExecutableSteps();

        if (disableAICompletely || skipAIAnalysisOption || !hasWorkflowSteps) {
          await sendLog(jobId, 'info', `⏭️ Skipping workflow execution${disableAICompletely ? ' (AI disabled)' : ''}`);
        } else {
          const executionMessage = hasAdvancedAnalysis
            ? `📊 Executing workflow steps with Playwright/AI capabilities...`
            : `🧩 Executing workflow steps (no Playwright/AI dependencies)...`;
          await sendLog(jobId, 'info', executionMessage);

          const analysisResult = await workflowAnalyzer.analyzePage(page, jobId, createdPageId, projectId);
          analysisResultForCurrentPage = analysisResult;

          // CRITICAL: For login jobs, check if login was successful and stop immediately
          const isLoginJob = context?.jobType === 'login' || 
                            context?.job_type === 'login' || 
                            context?.isLoginJob === true ||
                            context?.preventCrawling === true;
          
          if (isLoginJob) {
            // Extract login status from workflow result
            const determineResult = 
              analysisResult?.determine_completion?.result ||
              analysisResult?.determine_completion ||
              analysisResult?.results?.determine_completion?.result ||
              analysisResult?.results?.determine_completion ||
              analysisResult?.context?.determine_completion?.result ||
              analysisResult?.context?.determine_completion ||
              null;
            
            const loginStatus = determineResult?.status || determineResult?.completion_status || null;
            const loginSuccess = loginStatus === 'success' || 
                                (determineResult?.is_complete === true && loginStatus !== 'failure');
            
            if (loginSuccess) {
              await sendLog(jobId, 'info', `✅ Login successful - stopping job (login-only mode)`);
              // Return early to prevent link discovery and crawling
              return {
                success: true,
                loginStatus: 'success',
                finalUrl: page.url(),
                cookies: await page.context().cookies().catch(() => []),
                workflowResult: analysisResult,
                stopped: true,
                reason: 'Login successful - job stopped as configured for login-only mode'
              };
            } else {
              await sendLog(jobId, 'warn', `⚠️ Login not confirmed (status: ${loginStatus || 'unknown'}) - continuing workflow`);
            }
          }

          // Log workflow analysis results (skip for login jobs - they don't generate legs)
          // Check if this is a login job (already checked above, but re-check for clarity)
          const shouldSkipLegsLogging = context?.jobType === 'login' || 
                            context?.job_type === 'login' || 
                            context?.isLoginJob === true ||
                            context?.preventCrawling === true;
          
          if (!shouldSkipLegsLogging) {
            const legsCount = typeof analysisResult?.legs_count === 'number' ? analysisResult.legs_count : null;
            const legsArray = analysisResult?.legs || [];
            const actualLegsCount = legsArray.length;
            
            if (legsCount !== null && legsCount > 0) {
              await sendLog(jobId, 'info', `✅ Workflow executed with ${legsCount} testable legs`);
            } else if (legsCount === 0) {
              await sendLog(jobId, 'info', `ℹ️ Workflow analysis completed with 0 legs (no testable actions found)`);
            }
            
            // Check for discrepancy between reported legs_count and actual legs array
            if (legsCount !== null && legsCount !== actualLegsCount) {
              await sendLog(jobId, 'warn', `⚠️ Discrepancy: legs_count=${legsCount} but legs array has ${actualLegsCount} items`);
            }
          }
          
          if (analysisResult?.page_description) {
            // Ensure page_description is converted to string (handles objects)
            const pageDesc = typeof analysisResult.page_description === 'string' 
              ? analysisResult.page_description 
              : JSON.stringify(analysisResult.page_description, null, 2);
            await sendLog(jobId, 'info', `📝 ${pageDesc}`);
          }

          allWorkflows.push(analysisResult);

          if (shouldExecuteWorkflowLegs) {
            const legsToExecute = analysisResult.legs || [];
            
            if (legsToExecute.length === 0) {
              // Provide detailed diagnostic information
              const workflowId = analysisResult?.workflow_id || null;
              const reportedLegsCount = analysisResult?.legs_count || 0;
              const hasPageDescription = !!analysisResult?.page_description;
              
              let diagnosticMessage = '⏭️ No legs to execute';
              const diagnosticDetails = [];
              
              if (workflowId) {
                diagnosticDetails.push(`workflow_id: ${workflowId}`);
              } else {
                diagnosticDetails.push('no workflow_id');
              }
              
              if (typeof reportedLegsCount === 'number') {
                diagnosticDetails.push(`legs_count: ${reportedLegsCount}`);
              }
              
              if (hasPageDescription) {
                diagnosticDetails.push('page_description: present');
              }
              
              if (diagnosticDetails.length > 0) {
                diagnosticMessage += ` (${diagnosticDetails.join(', ')})`;
              }
              
              // Check if this might be due to filtering
              if (isSinglePageScan) {
                diagnosticMessage += ' [Note: Single-page scan may have filtered navigation legs]';
              }
              
              await sendLog(jobId, 'info', diagnosticMessage);
            } else if (!analysisResult?.workflow_id) {
              const hasJourneyDrivenExecution = Array.isArray(analysisResult?.journeys) && analysisResult.journeys.length > 0;
              if (hasJourneyDrivenExecution) {
                // Journey-first workflows already execute actions inside WorkflowAnalyzer.
                // Running legacy direct legs again causes duplicate/unstable execution and false failures.
                await sendLog(jobId, 'info', `⏭️ Skipping legacy direct-leg execution (${legsToExecute.length} legs) because journey execution already ran in workflow analyzer`);
              } else {
                // Execute legs directly without workflow_id (no database updates)
                await sendLog(jobId, 'warn', `⚠️ Executing ${legsToExecute.length} legs without workflow_id (no database status updates will be made)`);
                try {
                  if (!workflowTemplateLoaded) {
                    await workflowExecutor.loadWorkflowTemplate();
                    workflowTemplateLoaded = true;
                  }
                  
                  // Filter navigation legs for single-page scans
                  let filteredLegs = legsToExecute;
                  if (isSinglePageScan && filteredLegs.length > 0) {
                    const originalCount = filteredLegs.length;
                    filteredLegs = filteredLegs.filter(leg => {
                      const action = leg.action || leg.type || '';
                      const description = leg.description || '';
                      const isNavigation = action === 'navigate' || 
                                          action === 'navigation' ||
                                          description.toLowerCase().includes('follow link') ||
                                          description.toLowerCase().includes('navigate to');
                      return !isNavigation;
                    });
                    if (filteredLegs.length < originalCount) {
                      await sendLog(jobId, 'info', `⏭️ Single-page scan: Filtered out ${originalCount - filteredLegs.length} navigation legs`);
                    }
                  }
                  
                  // Execute legs directly (workflow_id optional - only needed for DB updates)
                  const executionResult = await workflowExecutor.executeLegsDirectly(page, jobId, filteredLegs, null);
                  await sendLog(jobId, 'info', `✅ Workflow legs executed (${executionResult.legs_executed} processed, no workflow_id - execution only)`);
                } catch (execError) {
                  console.error(`Leg execution failed:`, execError);
                  await sendLog(jobId, 'error', `❌ Failed to execute workflow legs: ${execError.message}`);
                }
              }
            } else {
              try {
                if (!workflowTemplateLoaded) {
                  await workflowExecutor.loadWorkflowTemplate();
                  workflowTemplateLoaded = true;
                }

                // CRITICAL: For single-page scans, filter out navigation legs to prevent multi-page crawling
                let legsToExecute = analysisResult.legs || [];
                if (isSinglePageScan && legsToExecute.length > 0) {
                  const originalCount = legsToExecute.length;
                  legsToExecute = legsToExecute.filter(leg => {
                    const action = leg.action || leg.type || '';
                    const description = leg.description || '';
                    const isNavigation = action === 'navigate' || 
                                        action === 'navigation' ||
                                        description.toLowerCase().includes('follow link') ||
                                        description.toLowerCase().includes('navigate to');
                    return !isNavigation;
                  });
                  if (legsToExecute.length < originalCount) {
                    await sendLog(jobId, 'info', `⏭️ Single-page scan: Filtered out ${originalCount - legsToExecute.length} navigation legs (keeping ${legsToExecute.length} non-navigation legs)`);
                    // Update analysisResult with filtered legs
                    analysisResult.legs = legsToExecute;
                  }
                }

                // CRITICAL: Calculate how many legs to execute to reach 80% threshold
                // If we have many legs, execute at least 80% of them
                const totalLegs = legsToExecute.length;
                const targetPercentage = 80;
                const targetLegsCount = Math.ceil(totalLegs * (targetPercentage / 100));
                // Execute at least 80% of legs, but ensure we execute at least the target count
                const legsToExecuteForThreshold = legsToExecute.slice(0, Math.max(targetLegsCount, Math.ceil(totalLegs * 0.8)));
                
                if (legsToExecuteForThreshold.length < totalLegs) {
                  await sendLog(jobId, 'info', `📊 Executing ${legsToExecuteForThreshold.length}/${totalLegs} legs to reach ${targetPercentage}% threshold (${((legsToExecuteForThreshold.length / totalLegs) * 100).toFixed(1)}%)`);
                } else {
                  await sendLog(jobId, 'info', `▶️ Executing all ${legsToExecute.length} workflow legs for ${analysisResult.workflow_id}...`);
                }
                // For single-page scans, temporarily update workflow in database to filter navigation legs
                if (isSinglePageScan && legsToExecute.length < (analysisResult.legs?.length || 0)) {
                  const axios = (await import('axios')).default;
                  const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
                  const workflowId = analysisResult.workflow_id;
                  
                  // Get original workflow
                  const originalWorkflow = await workflowExecutor.getWorkflow(workflowId);
                  const originalLegs = originalWorkflow?.legs || [];
                  
                  try {
                    // Temporarily update workflow with filtered legs
                    await axios.put(`${backendUrl}/api/workflows/${workflowId}`, {
                      legs: legsToExecute
                    }, {
                      headers: workflowExecutor.getAuthHeaders ? workflowExecutor.getAuthHeaders() : {},
                      timeout: 5000
                    });
                    
                    const executionResult = await workflowExecutor.executeWorkflow(page, jobId, workflowId);
                    await sendLog(jobId, 'info', `✅ Workflow legs executed (${executionResult.legs_executed} processed)`);
                  } catch (updateError) {
                    console.warn(`Failed to filter legs for single-page scan: ${updateError.message}`);
                    // Fall back to executing all legs
                    const executionResult = await workflowExecutor.executeWorkflow(page, jobId, workflowId);
                    await sendLog(jobId, 'info', `✅ Workflow legs executed (${executionResult.legs_executed} processed)`);
                  } finally {
                    // Restore original legs
                    try {
                      await axios.put(`${backendUrl}/api/workflows/${workflowId}`, {
                        legs: originalLegs
                      }, {
                        headers: workflowExecutor.getAuthHeaders ? workflowExecutor.getAuthHeaders() : {},
                        timeout: 5000
                      });
                    } catch (restoreError) {
                      console.error(`Failed to restore original legs: ${restoreError.message}`);
                    }
                  }
                } else {
                  // Execute workflow with legs to reach 80% threshold
                  // Use legsToExecuteForThreshold if calculated, otherwise use all legs
                  const finalLegsToExecute = legsToExecuteForThreshold.length > 0 ? legsToExecuteForThreshold : legsToExecute;
                  
                  // First, update workflow temporarily with legs to execute (if we're filtering)
                  try {
                    const axios = (await import('axios')).default;
                    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
                    const workflowId = analysisResult.workflow_id;
                    
                    // Get original workflow
                    const originalWorkflowResponse = await axios.get(`${backendUrl}/api/workflows/${workflowId}`, {
                      headers: workflowExecutor.getAuthHeaders ? workflowExecutor.getAuthHeaders() : {},
                      timeout: 5000
                    });
                    const originalWorkflow = originalWorkflowResponse.data;
                    const originalLegs = originalWorkflow?.legs || [];
                    
                    // Temporarily update workflow with legs to execute (for 80% threshold)
                    if (finalLegsToExecute.length < totalLegs) {
                      await axios.put(`${backendUrl}/api/workflows/${workflowId}`, {
                        legs: finalLegsToExecute
                      }, {
                        headers: workflowExecutor.getAuthHeaders ? workflowExecutor.getAuthHeaders() : {},
                        timeout: 5000
                      });
                    }
                    
                    const executionResult = await workflowExecutor.executeWorkflow(page, jobId, workflowId);
                    await sendLog(jobId, 'info', `✅ Workflow legs executed (${executionResult.legs_executed} processed)`);
                    
                    // Restore original legs if we filtered them
                    if (finalLegsToExecute.length < totalLegs) {
                      await axios.put(`${backendUrl}/api/workflows/${workflowId}`, {
                        legs: originalLegs
                      }, {
                        headers: workflowExecutor.getAuthHeaders ? workflowExecutor.getAuthHeaders() : {},
                        timeout: 5000
                      });
                    }
                    
                    // Note: Action analysis percentage is only logged in test logs, not job logs
                  } catch (execError) {
                    // Fallback to executing all legs if threshold logic fails
                    console.warn(`Failed to execute with threshold logic: ${execError.message}, falling back to all legs`);
                    const executionResult = await workflowExecutor.executeWorkflow(page, jobId, analysisResult.workflow_id);
                    await sendLog(jobId, 'info', `✅ Workflow legs executed (${executionResult.legs_executed} processed)`);
                  }
                }
              } catch (execError) {
                await sendLog(jobId, 'warn', `⚠️ Workflow leg execution encountered issues: ${execError.message}`);
              }
            }
          }
        }
        
        // Step 3: Extract links from page for crawling (if not at max depth)
        if (shouldDiscoverLinks && depth < maxDepth) {
          const linksData = await extractAllLinks(page, jobId, currentUrl, allowSubdomains);
          const allInternal = Array.isArray(linksData?.internal) ? linksData.internal : [];
          const anchors = [];
          const crawlableInternalLinks = [];
          const uniqueCrawlableByCanonicalUrl = new Map();

          const normalizePath = (value = '') => {
            const normalized = String(value || '').replace(/\/+$/, '');
            return normalized === '' ? '/' : normalized;
          };

          for (const link of allInternal) {
            const href = link?.href || '';
            if (!href) continue;
            try {
              const current = new URL(currentUrl);
              const target = new URL(href, currentUrl);
              const targetCanonical = canonicalizeUrl(target.href);
              const samePath = normalizePath(target.pathname) === normalizePath(current.pathname);
              const isAnchor = Boolean(target.hash) && target.origin === current.origin && samePath;
              if (isAnchor) {
                anchors.push(link);
              } else {
                if (targetCanonical && targetCanonical !== currentUrl) {
                  if (!uniqueCrawlableByCanonicalUrl.has(targetCanonical)) {
                    uniqueCrawlableByCanonicalUrl.set(targetCanonical, {
                      ...link,
                      href: targetCanonical,
                      urlWithoutHash: targetCanonical
                    });
                  }
                }
              }
            } catch {
              const urlWithoutHash = (link?.urlWithoutHash || href.split('#')[0] || '').trim();
              if (!urlWithoutHash) continue;
              if (href.includes('#') && urlWithoutHash === currentUrl.split('#')[0]) {
                anchors.push(link);
              } else {
                const targetCanonical = canonicalizeUrl(urlWithoutHash);
                if (targetCanonical && targetCanonical !== currentUrl) {
                  if (!uniqueCrawlableByCanonicalUrl.has(targetCanonical)) {
                    uniqueCrawlableByCanonicalUrl.set(targetCanonical, {
                      ...link,
                      href: targetCanonical,
                      urlWithoutHash: targetCanonical
                    });
                  }
                }
              }
            }
          }
          crawlableInternalLinks.push(...uniqueCrawlableByCanonicalUrl.values());

          // Keep anchors separate from page links (anchors are not pages to crawl)
          if (analysisResultForCurrentPage && typeof analysisResultForCurrentPage === 'object') {
            analysisResultForCurrentPage.anchors = anchors;
            analysisResultForCurrentPage.internal_links = crawlableInternalLinks;
          }

          // CRITICAL: Only collect links if we haven't reached max_pages and depth limit
          // For single-page scans (max_pages=1, max_depth=0), don't collect links at all
          if (pagesAnalyzed < maxPages && depth < maxDepth) {
            // DEFAULT: Queue links for crawling (crawl jobs test everything)
            // Only skip if this is explicitly configured as a login job
            const isLoginJob = context?.jobType === 'login' ||
                              context?.job_type === 'login' ||
                              context?.isLoginJob === true ||
                              context?.preventCrawling === true ||
                              context?.preventLinkDiscovery === true;

            let queuedCount = 0;
            for (const link of crawlableInternalLinks.slice(0, 50)) {
              // Regular link - use base URL (without hash) for deduplication
              const urlToCheck = canonicalizeUrl((link?.urlWithoutHash || link?.href || '').split('#')[0].trim());
              if (!urlToCheck) continue;
              if (!visitedUrls.has(urlToCheck) && !analyzedPageUrls.has(urlToCheck) && !urlQueue.find(item => item.url === urlToCheck)) {
                if (!isLoginJob) {
                  urlQueue.push({ url: urlToCheck, depth: depth + 1 });
                  queuedCount++;
                }
              }
            }

            if (isLoginJob) {
              await sendLog(jobId, 'info', `🔗 Found ${crawlableInternalLinks.length} internal page links and ${anchors.length} anchors (NOT queued - login-only job configured)`);
            } else {
              await sendLog(jobId, 'info', `🔗 Found ${crawlableInternalLinks.length} internal page links and ${anchors.length} anchors; queued ${queuedCount} page links for crawling`);
            }
          } else {
            await sendLog(jobId, 'info', `⏭️ Skipping link collection (max_pages: ${maxPages}, current: ${pagesAnalyzed}, max_depth: ${maxDepth}, current: ${depth})`);
          }
        }
        if (actualPageUrlCanonical) {
          analyzedPageUrls.add(actualPageUrlCanonical);
        }
      }
      
      // Return comprehensive results
      // Get final page info safely (context might be destroyed)
      let finalPageUrl = 'unknown';
      let finalPageTitle = 'Unknown';
      try {
        finalPageUrl = page.url();
        finalPageTitle = await page.title();
      } catch (finalError) {
        await sendLog(jobId, 'warn', `⚠️ Could not get final page info: ${finalError.message}`);
        // Use last known URL if available
        if (urlQueue.length > 0) {
          finalPageUrl = urlQueue[0].url;
        }
      }
      
      // If we have journeys and all failed, report crawl as failed (no fallbacks)
      const lastWorkflow = allWorkflows.length > 0 ? allWorkflows[allWorkflows.length - 1] : null;
      const journeys = lastWorkflow?.journeys || [];
      const allJourneysFailed = journeys.length > 0 && journeys.every(j => j.status === 'failure');
      const workflowSuccess = !allJourneysFailed;
      if (allJourneysFailed) {
        await sendLog(jobId, 'warn', `📊 All ${journeys.length} journey(s) failed - reporting crawl as FAILED`);
      }
      
      return {
        success: workflowSuccess,
        approach: 'workflow',
        message: workflowSuccess ? `Analyzed ${pagesAnalyzed} pages with workflow-based testing` : `All ${journeys.length} journey(s) failed`,
        url: finalPageUrl,
        title: finalPageTitle,
        details: {
          total_pages: pagesAnalyzed,
          total_workflows: allWorkflows.length,
          workflows: allWorkflows.map(w => ({
            workflow_id: w.workflow_id,
            legs_count: w.legs_count,
            page_description: w.page_description
          }))
        }
      };
    } catch (error) {
      console.error('[WORKFLOW-MODE] Full error:', error);
      console.error('[WORKFLOW-MODE] Stack trace:', error.stack);
      await sendLog(jobId, 'error', `❌ Workflow mode failed: ${error.message}`);
      await sendLog(jobId, 'error', `Stack: ${error.stack}`);
      return {
        success: false,
        approach: 'workflow',
        message: `Workflow failed: ${error.message}`,
        error: error.message,
        stack: error.stack
      };
    }
  },

  // Simplified mode - NOW uses new approach sequence  
  simplified: async (page, context, openaiClient, operation) => {
    const jobId = context.job_id || 'unknown-job';
    await sendLog(jobId, 'info', '🚀 SIMPLIFIED MODE: Using NEW approach sequence (simplified → text → media → static)');
    
    const pageId = context.page_id || null;
    const projectId = context.project_id || null;
    
    // Call the new approach sequence function
    const result = await executeApproachSequence(page, jobId, context, openaiClient, pageId, projectId);
    
    return {
      success: result.success,
      approach: result.final_approach,
      message: result.success ? `Completed with ${result.final_approach} approach` : result.reason,
      details: {
        final_approach: result.final_approach,
        iterations: result.iterations,
        depth: result.depth,
        verification: result.verification,
        result: result.result
      }
    };
  },

  // Auto mode - Uses approach sequence for crawling
  // NOTE: Login is handled by separate login-service
  auto: async (page, context, openaiClient, operation) => {
    const jobId = context.job_id || 'unknown-job';
    
    // Unified-crawler does NOT handle login operations
    if (operation === 'login') {
      throw new Error('Login operations must be handled by login-service, not unified-crawler');
    }
    
    await sendLog(jobId, 'info', '🚀 AUTO MODE: Using workflow-based analysis (comprehensive first request)');
    
    // AUTO mode now delegates to WORKFLOW mode (comprehensive approach)
    return await modeHandlers.workflow(page, context, openaiClient, operation);
  },
  
  // DEPRECATED: OLD AUTO MODE - Sequential approach selection
  // This mode is deprecated in favor of the comprehensive first request approach.
  // Kept for backward compatibility only.
  // NEW APPROACH: Use 'workflow' mode which sends ALL context (HTML, screenshot, Playwright analysis) in first request
  // with intelligent 2-attempt retry instead of trying multiple sequential approaches.
  auto_old: async (page, context, openaiClient, operation) => {
    console.warn('[DEPRECATED] auto_old mode is deprecated. Use workflow mode instead.');
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
            
            const validationResult = await validateActionSuccessWithAI(page, context, openaiClient, approach, operation, null);
            
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
      // performStaticLogin removed - all login operations must use workflow templates (rule 95-remove-deprecated-immediately.mdc)
      const jobId = context.job_id;
      await sendLog(jobId, 'error', '❌ Static login mode deprecated - use workflow templates instead', { page_url: page.url() });
      return {
        success: false,
        message: 'Static login mode deprecated - use workflow templates stored in MongoDB',
        details: { workflowRequired: true }
      };
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
    
    // Take a screenshot for analysis (full quality)
    const screenshot = await page.screenshot({ 
      type: 'png', 
      fullPage: true
    });
    
    // Analyze the page with AI
    const htmlContent = await page.content();
    const currentUrl = page.url();
    const currentTitle = await page.title();
    const urlPath = new URL(currentUrl).pathname || '/';
    
    const aiPrompt = `Given the following HTML content, identify form elements and their structure.

Document Title: ${currentTitle}
Path Context: ${urlPath}
HTML CONTENT:
${htmlContent}

Extract and describe:
1. Form field elements (input types, names, ids)
2. Button elements (types, text content)
3. Form structure and grouping

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
        model: "gpt-5-mini",
        messages: [{ role: "user", content: aiPrompt }],
      },
      screenshotResult?.screenshotId, // Pass screenshot ID to AI conversation logger
      currentUrl,
      {
        html_content: htmlContent,
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
  
  // Take screenshot for AI analysis (full quality)
  const screenshot = await page.screenshot({ 
    type: 'png', 
    fullPage: true
  });
  const screenshotBase64 = screenshot.toString('base64');
  
  const currentUrl = page.url();
  const currentTitle = await page.title();
  const urlPath = new URL(currentUrl).pathname || '/';
  
  // Analyze screenshot with AI
  const aiPrompt = `Given this screenshot image, identify visible form elements and interactive components.

SCREENSHOT: data:image/png;base64,${screenshotBase64}
Document Title: ${currentTitle}
Path Context: ${urlPath}

Extract and describe:
1. Visible form field elements and their positions
2. Button elements and their text content
3. Interactive component layout
4. Any visual indicators or labels

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
      model: "gpt-5-mini",
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
    max_pages: context.options?.max_pages ?? 50,
    runner_token: context.runner_token
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
  const urlPath = new URL(currentUrl).pathname || '/';
  
  // Analyze HTML content with AI
  const aiPrompt = `Given the following HTML content, extract and describe form elements and their structure.

Document Title: ${currentTitle}
Path Context: ${urlPath}
HTML CONTENT:
${htmlContent}

Focus on text content, form structure, and interactive elements. Extract structural information.

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
      model: "gpt-5-mini",
      messages: [{ role: "user", content: aiPrompt }],
      response_format: { type: "json_object" }
    },
    screenshotResult?.screenshotId, // Pass screenshot ID to AI conversation logger
    currentUrl,
    {
        html_content: htmlContent,
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
    max_pages: context.options?.max_pages ?? 50,
    runner_token: context.runner_token
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
  const currentUrl = page.url();
  const currentTitle = await page.title();
  const urlPath = new URL(currentUrl).pathname || '/';
  
  const aiPrompt = `Given these form element structures, identify field mappings and form characteristics.

FORMS: ${JSON.stringify(forms, null, 2)}
Document Title: ${currentTitle}
Path Context: ${urlPath}

Analyze the form structure and provide field mappings.

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
      model: "gpt-5-mini",
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
    max_pages: context.options?.max_pages ?? 50,
    runner_token: context.runner_token
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

// performStaticLogin function completely removed - all login operations must use workflow templates (rule 95-remove-deprecated-immediately.mdc)

// Comprehensive link extraction
async function extractAllLinks(page, jobId, baseUrl, allowSubdomains = false) {
  try {
    await sendLog(jobId, 'info', '🔗 Extracting all links from page (comprehensive scan)...');
    
    // Playwright's $$eval only supports passing a single argument; wrap inputs.
    const links = await page.$$eval('a[href], area[href], [data-href], [data-url]', (elements, opts) => {
      const baseUrl = opts?.baseUrl || '';
      const allowSubdomains = Boolean(opts?.allowSubdomains);
      const linkSet = new Set();
      const links = [];

      const normalizeHost = (value) => String(value || '').toLowerCase().replace(/^www\./, '');
      const getBaseDomain = (hostname) => {
        const parts = normalizeHost(hostname).split('.').filter(Boolean);
        if (parts.length < 2) return normalizeHost(hostname);
        return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      };
      
      elements.forEach(el => {
        const href = el.href || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
        if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:') || href === '#') {
          return;
        }
        
        const text = el.textContent?.trim() || el.alt || el.title || '';
        
        // Parse URL to check if it's within domain
        let isInternal = false;
        let fullUrl = href;
        try {
          const linkUrl = new URL(href);
          const baseUrlObj = new URL(baseUrl);
          // Check both hostname and origin for more accurate domain matching
          const linkHost = normalizeHost(linkUrl.hostname);
          const baseHost = normalizeHost(baseUrlObj.hostname);
          isInternal =
            linkHost === baseHost ||
            linkUrl.origin === baseUrlObj.origin ||
            (allowSubdomains && getBaseDomain(linkHost) === getBaseDomain(baseHost));
          fullUrl = linkUrl.href;
        } catch (e) {
          // Relative URL or invalid
          if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || !href.includes('://')) {
            isInternal = true;
            try {
              fullUrl = new URL(href, baseUrl).href;
            } catch (e2) {
              fullUrl = href;
            }
          }
        }
        
        // Preserve all hash fragments - always use full URL for deduplication
        const urlWithoutHash = fullUrl.split('#')[0];
        const hashFragment = fullUrl.includes('#') ? fullUrl.split('#')[1] : null;
        
        // Deduplicate URLs using full URL (preserving hash fragments)
        if (!linkSet.has(fullUrl)) {
          linkSet.add(fullUrl);
          links.push({
            text: text.substring(0, 200), // Limit text length
            href: fullUrl,
            urlWithoutHash: urlWithoutHash,
            hashFragment: hashFragment,
            title: el.title || '',
            isInternal: isInternal,
            target: el.target || '',
            rel: el.rel || ''
          });
        }
      });
      
      return links;
    }, { baseUrl, allowSubdomains });
    
    const normalizeUrlForDedup = (value) => {
      try {
        const u = new URL(String(value || ''));
        u.hash = '';
        const normalizedPath = u.pathname.replace(/\/+$/, '') || '/';
        return `${u.protocol}//${u.host}${normalizedPath}${u.search}`;
      } catch {
        const raw = String(value || '').split('#')[0];
        return raw.replace(/\/+$/, '') || raw;
      }
    };
    const internalLinksRaw = links.filter(l => l.isInternal);
    const uniqueInternalMap = new Map();
    for (const link of internalLinksRaw) {
      const dedupeKey = normalizeUrlForDedup(link?.urlWithoutHash || link?.href || '');
      if (!dedupeKey) continue;
      if (!uniqueInternalMap.has(dedupeKey)) {
        uniqueInternalMap.set(dedupeKey, {
          ...link,
          href: dedupeKey,
          urlWithoutHash: dedupeKey
        });
      }
    }
    const internalLinks = Array.from(uniqueInternalMap.values());
    const externalLinks = links.filter(l => !l.isInternal);
    
    await sendLog(jobId, 'info', `📊 Found ${links.length} unique links (${internalLinks.length} internal, ${externalLinks.length} external)`);
    
    // Log internal links for debugging
    if (internalLinks.length > 0) {
      await sendLog(jobId, 'info', `  Internal links: ${internalLinks.slice(0, 10).map(l => l.urlWithoutHash).join(', ')}${internalLinks.length > 10 ? ` ... and ${internalLinks.length - 10} more` : ''}`);
    }
    
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
async function analyzeSinglePage(page, jobId, baseUrl, approach, openaiClient, pageId = null, options = {}) {
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

  const allowSubdomains = options?.allow_subdomains === true;
  
  // Generate unique conversation ID for this page's analysis
  const conversationId = `conv_${jobId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Context data to include in all logs for this page
  const pageContext = { 
    page_url: currentUrl, 
    mode: approach,
    pageId: pageId // Include pageId if available
  };
  
  await sendLog(jobId, 'info', `📄 ANALYZING PAGE: ${currentTitle}`, pageContext);
  await sendLog(jobId, 'info', `🔗 URL: ${currentUrl}`, pageContext);
  await sendLog(jobId, 'info', `🎯 Approach: ${approach}`, pageContext);
  await sendLog(jobId, 'info', `💬 Conversation ID: ${conversationId}`, pageContext);
  
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
    linksData = await extractAllLinks(page, jobId, currentUrl, allowSubdomains);
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
  await updateJobSubstatus(jobId, 'collecting_page_content', { current_page: currentUrl, current_step: '6/6' });
  
  let pageContent = '';
  try {
    pageContent = await page.content();
    await sendLog(jobId, 'info', `✓ Page content collected (${Math.round(pageContent.length / 1024)}KB)`, pageContext);
  } catch (error) {
    await sendLog(jobId, 'warn', `⚠️ Failed to get page content: ${error.message}`, pageContext);
    // Continue with empty content
  }
  
  // Check if we should skip AI analysis based on options
  const skipAIAnalysis = options.skip_ai_analysis || false;
  const skipAlreadyAnalyzed = options.skip_already_analyzed || false;
  const disableAICompletely = options.disable_ai_completely || false;
  
  let shouldAnalyzeWithAI = true;
  let skipReason = '';
  
  // If AI is completely disabled, skip everything
  if (disableAICompletely) {
    shouldAnalyzeWithAI = false;
    skipReason = 'AI completely disabled';
    await sendLog(jobId, 'info', `⏭️ AI disabled: Only collecting page structure`, pageContext);
  }
  // If skip_ai_analysis is enabled, skip AI but still collect links
  else if (skipAIAnalysis) {
    shouldAnalyzeWithAI = false;
    skipReason = 'Skip AI analysis enabled (collecting links only)';
    await sendLog(jobId, 'info', `⏭️ Skipping AI analysis: ${skipReason}`, pageContext);
  }
  // If skip_already_analyzed is enabled, check if page was already analyzed
  else if (skipAlreadyAnalyzed && pageId) {
    try {
      const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
      const checkResponse = await fetch(`${backendUrl}/api/pages/check-analyzed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId })
      });
      
      if (checkResponse.ok) {
        const checkResult = await checkResponse.json();
        if (checkResult.analyzed) {
          shouldAnalyzeWithAI = false;
          skipReason = 'Page already analyzed (skip_already_analyzed enabled)';
          await sendLog(jobId, 'info', `⏭️ Skipping AI analysis: ${skipReason}`, pageContext);
        }
      }
    } catch (error) {
      await sendLog(jobId, 'warn', `⚠️ Failed to check if page is analyzed: ${error.message}`, pageContext);
      // Continue with AI analysis if check fails
    }
  }
  
  // Approach-specific AI analysis - Skip if page already analyzed and option enabled
  if (shouldAnalyzeWithAI && aiConversationLogger && openaiClient && pageContent) {
    await updateJobSubstatus(jobId, 'openai_calculation', { current_page: currentUrl, approach: approach });
    try {
      let aiPrompt, aiMessages;
      
      if (approach === 'media') {
        // MEDIA: Use vision API with screenshot
        await sendLog(jobId, 'info', `📸 Using AI vision to analyze screenshot...`, pageContext);
        await updateJobSubstatus(jobId, 'ai_vision_analysis', { current_page: currentUrl });
        
        // Take screenshot and upload to MinIO for proper logging
        const screenshotResult = await takeScreenshot(page, jobId, 'ai_vision_analysis', {
          approach: approach,
          mode: approach,
          analysis_type: 'ai_vision_analysis',
          page_title: currentTitle,
          full_hd_screenshot: true
        });
        
        if (!screenshotResult) {
          await sendLog(jobId, 'warn', `⚠️ Failed to capture screenshot for AI vision analysis`, pageContext);
          return; // Skip AI analysis if screenshot fails
        }
        
        // Get screenshot for base64 encoding for OpenAI Vision API
        let screenshotBase64;
        try {
          const screenshot = await page.screenshot({ 
            type: 'png', 
            fullPage: true,  // Capture full page for complete analysis
            animations: 'disabled'
          });
          screenshotBase64 = screenshot.toString('base64');
        } catch (screenshotError) {
          await sendLog(jobId, 'warn', `⚠️ Failed to encode screenshot for AI: ${screenshotError.message}`, pageContext);
          return; // Skip AI analysis if screenshot encoding fails
        }
        
        const urlPath = new URL(currentUrl).pathname || '/';
        
        aiMessages = [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Given this screenshot, identify and catalog visual elements, forms, and interactive components.

Document Title: ${currentTitle}
Path Context: ${urlPath}
Analysis Method: Visual screenshot examination

Extract visible elements including layout, forms, and interactive components.
Provide structural analysis and element catalog.

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
        await updateJobSubstatus(jobId, 'ai_text_analysis', { current_page: currentUrl });
        const htmlSnippet = pageContent;
        const urlPath = new URL(currentUrl).pathname || '/';
          
        aiPrompt = `Given this HTML content, extract and catalog structural elements and their relationships.

Document Title: ${currentTitle}
Path Context: ${urlPath}
Analysis Method: HTML structure examination

HTML Content:
${htmlContent}

Forms found: ${forms.length}
Links found: ${linksData.total}

Provide structural analysis and element catalog.

Required JSON format:
{
  "content_analysis": "...",
  "forms_detected": number,
  "testing_recommendations": ["..."]
}`;

        aiMessages = [{ role: "user", content: aiPrompt }];
        
      } else {
        // STATIC/OTHER: Full AI analysis with HTML content
        await sendLog(jobId, 'info', `⚡ Using ${approach} approach - Full AI analysis with HTML content...`, pageContext);
        await updateJobSubstatus(jobId, 'ai_full_analysis', { current_page: currentUrl, approach: approach });
        const urlPath = new URL(currentUrl).pathname || '/';
        
        aiPrompt = `Given this HTML content, analyze the page structure and provide comprehensive insights.

Document Title: ${currentTitle}
Path Context: ${urlPath}
Forms: ${forms.length}
Links: ${linksData.total} (${linksData.internal.length} internal)

HTML CONTENT:
${pageContent}

Analyze and provide:
1. Page purpose and functionality
2. Form elements and their structure
3. Interactive components and navigation
4. Content organization and layout
5. Testing recommendations

Respond with JSON format:
{
  "page_analysis": "...",
  "forms_analysis": [...],
  "interactive_elements": [...],
  "content_structure": "...",
  "testing_recommendations": [...],
  "confidence": 0.0-1.0
}`;

        aiMessages = [{ role: "user", content: aiPrompt }];
      }

      await sendLog(jobId, 'info', `🤖 Sending request to OpenAI (${approach} analysis)...`, pageContext);
      
      const completion = await aiConversationLogger.createChatCompletion(
        openaiClient,
        jobId,
        'unified-crawler',
        `page_analysis_${approach}`,
        {
          model: "gpt-5-mini",
          messages: aiMessages,
          max_completion_tokens: 128000
        },
        screenshotResult?.screenshotId,
        currentUrl,
        {
          approach: approach,
          conversationId: conversationId,
          page_title: currentTitle,
          forms_count: forms.length,
          links_count: linksData.total,
          has_forms: forms.length > 0,
          has_internal_links: linksData.internal.length > 0,
          analysis_mode: approach === 'media' ? 'vision' : 'text',
          screenshot_id: screenshotResult?.screenshotId,
          full_hd_screenshot: approach === 'media'
        }
      );
      
      await updateJobSubstatus(jobId, 'processing_ai_response', { current_page: currentUrl });
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
  
  return pageAnalysis;
}

// Recursive crawler - visits all internal links up to max depth
async function recursiveCrawl(page, jobId, startUrl, approach, openaiClient, options = {}) {
  const maxDepth = options.max_depth || 3;
  const maxPages = options.max_pages || 50;
  const allowSubdomains = options?.allow_subdomains === true;
  
  const visitedUrls = new Set();
  const analyzedPages = [];
  const urlQueue = [{ url: startUrl, depth: 0 }];
  
  await sendLog(jobId, 'info', `🌐 STARTING RECURSIVE CRAWL`);
  await sendLog(jobId, 'info', `Start URL: ${startUrl}`);
  await sendLog(jobId, 'info', `Approach: ${approach}`);
  await sendLog(jobId, 'info', `Max Depth: ${maxDepth}`);
  await sendLog(jobId, 'info', `Max Pages: ${maxPages}`);
  
  while (urlQueue.length > 0 && analyzedPages.length < maxPages) {
    const { url: currentUrl, depth } = urlQueue.shift();
    
    // Normalize URL by removing hash fragments for deduplication
    // Hash fragments represent modal/popup actions on the same page, not separate pages
    const normalizedUrl = currentUrl.split('#')[0];
    
    // Skip if already visited (by base URL, without hash)
    if (visitedUrls.has(normalizedUrl)) {
      await sendLog(jobId, 'info', `⏭️  Skipping (already visited): ${normalizedUrl}`, { page_url: currentUrl, mode: approach });
      continue;
    }
    
    // Skip if max depth reached
    if (depth > maxDepth) {
      await sendLog(jobId, 'info', `⏭️  Skipping (max depth ${maxDepth} reached): ${currentUrl}`, { page_url: currentUrl, mode: approach });
      continue;
    }
    
    // Check if job has been cancelled
    try {
      const axios = (await import('axios')).default;
      const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
      const headers = {};
      if (options.runner_token) {
        headers['Authorization'] = `Bearer ${options.runner_token}`;
      }
      // Use /api/jobs/:id which doesn't require authentication (runner-friendly endpoint)
      const jobStatusResponse = await axios.get(`${backendUrl}/api/jobs/${jobId}`, {
        headers,
        timeout: 5000
      });
      const jobStatus = jobStatusResponse.data?.status;
      if (jobStatus === 'cancelled' || jobStatus === 'failed') {
        await sendLog(jobId, 'info', `⏹️ Job ${jobStatus}, stopping crawl`);
        break;
      }
    } catch (statusCheckError) {
      // Continue if status check fails (don't block crawl)
      console.warn(`Failed to check job status: ${statusCheckError.message}`);
      if (statusCheckError.response?.status === 401) {
        console.warn(`   Status: 401 Unauthorized - Authentication failed`);
        console.warn(`   Runner token provided: ${options.runner_token ? 'Yes (length: ' + options.runner_token.length + ')' : 'NO - THIS IS THE PROBLEM!'}`);
      }
    }
    
    try {
      // Mark as visited (using normalized URL without hash)
      visitedUrls.add(normalizedUrl);
      
      // Create page context for this URL
      const currentPageContext = { page_url: currentUrl, mode: approach };
      
      await sendLog(jobId, 'info', `🌍 PAGE ${analyzedPages.length + 1}/${maxPages} (Depth ${depth}/${maxDepth})`, currentPageContext);
      await sendLog(jobId, 'info', `📍 Navigating to: ${currentUrl}`, currentPageContext);
      
      // Update substatus with current progress
      await updateJobSubstatus(jobId, 'navigating_to_page', { 
        current_page: currentUrl,
        page_number: analyzedPages.length + 1,
        total_pages: maxPages,
        depth: depth,
        max_depth: maxDepth,
        queue_size: urlQueue.length,
        visited_count: visitedUrls.size
      });
      
      // Check if page/browser is still valid before navigating
      try {
        if (!page || page.isClosed()) {
          throw new Error('Page is closed - cannot continue crawl');
        }
      } catch (checkError) {
        await sendLog(jobId, 'error', `❌ Browser context closed, stopping crawl at page ${analyzedPages.length + 1}`, currentPageContext);
        break; // Exit the while loop
      }
      
      // Wrap navigation and analysis with per-page video recording
      const { result: pageData, videoKey } = await recordPageVideo(page, jobId, currentUrl, async () => {
        // Navigate to URL
        await updateJobSubstatus(jobId, 'loading_page', { current_page: currentUrl });
        await page.goto(currentUrl, { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
        
        await sendLog(jobId, 'info', `⏳ Waiting for page to fully load...`, currentPageContext);
        await updateJobSubstatus(jobId, 'waiting_for_page_ready', { current_page: currentUrl });
        
        // Wait for page to settle
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
          console.warn('Page DOM not fully loaded after 30s, continuing anyway');
        });
        await page.waitForTimeout(1000);
        
        await sendLog(jobId, 'info', `✓ Page loaded successfully`, currentPageContext);
        
        // Get basic page info first
        let pageTitle, pageUrl;
        try {
          pageTitle = await page.title();
          pageUrl = await page.url();
          await sendLog(jobId, 'info', `📄 Page loaded: ${pageTitle}`, currentPageContext);
        } catch (error) {
          await sendLog(jobId, 'error', `❌ Failed to get page info: ${error.message}`, currentPageContext);
          throw error;
        }
        
        // Create basic page document in backend FIRST
        let pageId = await sendBasicPageToBackend(jobId, pageUrl, pageTitle, null, startUrl, null, allowSubdomains);
        
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
        
        // Check if this page is within the target domain before AI analysis
        const isWithinTargetDomain = isWithinDomain(currentUrl, startUrl, allowSubdomains);
        
        if (!isWithinTargetDomain) {
          // Skip AI analysis for external domains - just collect basic info
          await sendLog(jobId, 'info', `⏭️ Skipping AI analysis for external domain: ${currentUrl}`, currentPageContext);
          await updateJobSubstatus(jobId, 'skipping_external_domain', { 
            current_page: currentUrl,
            page_title: pageTitle,
            page_number: analyzedPages.length + 1
          });
          
          // Create minimal analysis for external pages (no AI processing)
          const pageAnalysis = {
            // url is the final browser URL (may differ from the queue URL due to redirects/SSO).
            url: currentUrl,
            // requested_url is the URL we intended to crawl (queue item).
            requested_url: pageUrl,
            // final_url is redundant with url but keeps the intent explicit for downstream storage.
            final_url: currentUrl,
            title: pageTitle,
            pageId: pageId,
            isExternal: true,
            analysis_skipped: true,
            reason: 'External domain - AI analysis skipped to save time and resources'
          };
          
          return { pageAnalysis, pageId, pageTitle, pageUrl };
        }
        
        // Now analyze this page with detailed logging (pageId available for all logs)
        await updateJobSubstatus(jobId, 'analyzing_page', { 
          current_page: currentUrl,
          page_title: pageTitle,
          page_number: analyzedPages.length + 1
        });
        const pageAnalysis = await analyzeSinglePage(page, jobId, currentUrl, approach, openaiClient, pageId, options);
        // Preserve the originally requested URL so the backend can update the "requested" page record
        // even if we were redirected to a different host/path during navigation (common with SSO).
        pageAnalysis.requested_url = pageUrl;
        pageAnalysis.final_url = currentUrl;
        
        return { pageAnalysis, pageId, pageTitle, pageUrl };
      });
      
      // Handle the results
      let pageAnalysis, pageId;
      try {
        pageAnalysis = pageData.pageAnalysis;
        pageId = pageData.pageId;
        
        // Add video key to page analysis if available
        if (videoKey) {
          pageAnalysis.video_file_id = videoKey;
        }
        
        analyzedPages.push(pageAnalysis);
        
        // Update the page with full analysis data
        if (pageId) {
          await sendDiscoveredPageToBackend(jobId, pageAnalysis, startUrl, allowSubdomains);
          await sendLog(jobId, 'info', `✓ Page analysis complete and stored`, {
            ...currentPageContext,
            pageId: pageId,
            video_key: videoKey || null
          });
        }
      } catch (analysisError) {
        await sendLog(jobId, 'error', `❌ Failed to process page results: ${analysisError.message}`, currentPageContext);
        
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
        await sendLog(jobId, 'info', `🔍 Checking ${pageAnalysis.internal_links.length} internal links for crawling...`);
        
        for (const link of pageAnalysis.internal_links) {
          // Check if link has hash fragment - these are modal/popup actions, not separate pages
          const hasHashFragment = link.href.includes('#') && link.href.split('#').length > 1;
          const baseUrlFromLink = hasHashFragment ? link.href.split('#')[0] : link.href;
          const baseUrlFromCurrent = currentUrl.includes('#') ? currentUrl.split('#')[0] : currentUrl;
          const isHashBasedAction = hasHashFragment && baseUrlFromLink === baseUrlFromCurrent;
          
          if (isHashBasedAction) {
            // Hash-based links are modal/popup actions on same page - don't crawl as separate pages
            // They should be converted to legs/actions instead (handled by workflow analyzer)
            await sendLog(jobId, 'info', `  🔘 Hash-based link (modal/popup action, not crawling): ${link.href}`);
            continue;
          }
          
          // Regular link - use urlWithoutHash to avoid processing same page with different hashes
          const urlToCheck = link.urlWithoutHash || link.href.split('#')[0];
          
          if (!visitedUrls.has(urlToCheck) && !urlQueue.find(item => item.url === urlToCheck)) {
            urlQueue.push({ url: urlToCheck, depth: depth + 1 });
            newLinksAdded++;
            await sendLog(jobId, 'info', `  ➕ Added to queue: ${urlToCheck} (depth ${depth + 1})`);
          } else {
            await sendLog(jobId, 'info', `  ⏭️  Skipped (already in queue or visited): ${urlToCheck}`);
          }
        }
        await sendLog(jobId, 'info', `📋 Queue updated: +${newLinksAdded} new links | Total in queue: ${urlQueue.length} | Visited: ${visitedUrls.size}/${maxPages}`);
      } else if (depth >= maxDepth) {
        await sendLog(jobId, 'info', `⚠️  Max depth ${maxDepth} reached - not adding more links from this page`);
        await sendLog(jobId, 'info', `   Found ${pageAnalysis.internal_links?.length || 0} internal links that won't be crawled due to depth limit`);
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
  
  await sendLog(jobId, 'info', `🎉 RECURSIVE CRAWL COMPLETE`);
  await sendLog(jobId, 'info', `Pages Analyzed: ${analyzedPages.length}`);
  await sendLog(jobId, 'info', `URLs Visited: ${visitedUrls.size}`);
  await sendLog(jobId, 'info', `URLs Remaining in Queue: ${urlQueue.length}`);
  
  return analyzedPages;
}

async function performStaticCrawl(page, context, openaiClient) {
  const jobId = context.job_id;
  await sendLog(jobId, 'info', '🚀 Starting STATIC mode recursive crawl with post-action analysis');
  
  const startUrl = page.url();
  
  // Perform recursive crawl with approach name
  const analyzedPages = await recursiveCrawl(page, jobId, startUrl, 'static', openaiClient, {
    max_depth: context.options?.max_depth ?? 3,
    max_pages: context.options?.max_pages ?? 50,
    skip_crawled_pages: context.options?.skip_crawled_pages ?? false,
    runner_token: context.runner_token
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
    // Clean the script before execution
    let cleanedScript = cleanScript(context.script);
    if (!cleanedScript || cleanedScript.trim().length === 0) {
      throw new Error('Script is empty after cleaning');
    }
    
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
    }, cleanedScript, context.credentials);

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
    // Clean the script before execution
    let cleanedScript = cleanScript(context.script);
    if (!cleanedScript || cleanedScript.trim().length === 0) {
      throw new Error('Script is empty after cleaning');
    }
    
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
    }, cleanedScript);

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

/**
 * Safely access localStorage with error handling
 */
async function safeGetLocalStorage(page) {
  try {
    return await page.evaluate(() => {
      try {
        // Check if localStorage is available
        if (typeof window === 'undefined' || !window.localStorage) {
          console.warn('localStorage not available in this context');
          return {};
        }
        
        const storage = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          storage[key] = window.localStorage.getItem(key);
        }
        return storage;
      } catch (error) {
        console.warn('localStorage access denied:', error.message);
        return {};
      }
    });
  } catch (error) {
    console.warn('Failed to access localStorage:', error.message);
    return {};
  }
}

/**
 * Safely access sessionStorage with error handling
 */
async function safeGetSessionStorage(page) {
  try {
    return await page.evaluate(() => {
      try {
        // Check if sessionStorage is available
        if (typeof window === 'undefined' || !window.sessionStorage) {
          console.warn('sessionStorage not available in this context');
          return {};
        }
        
        const storage = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          storage[key] = window.sessionStorage.getItem(key);
        }
        return storage;
      } catch (error) {
        console.warn('sessionStorage access denied:', error.message);
        return {};
      }
    });
  } catch (error) {
    console.warn('Failed to access sessionStorage:', error.message);
    return {};
  }
}

/**
 * Safely set localStorage with error handling
 */
async function safeSetLocalStorage(page, tokens) {
  // Validate tokens parameter
  if (!tokens || typeof tokens !== 'object' || Object.keys(tokens).length === 0) {
    console.warn('No valid tokens provided for localStorage');
    return false;
  }

  try {
    await page.evaluate((tokens) => {
      try {
        if (!tokens || typeof tokens !== 'object') {
          console.warn('Invalid tokens object in page context');
          return false;
        }
        
        // Check if localStorage is available
        if (typeof window === 'undefined' || !window.localStorage) {
          console.warn('localStorage not available in this context');
          return false;
        }
        
        Object.entries(tokens).forEach(([key, value]) => {
          if (key && value !== undefined && value !== null) {
            window.localStorage.setItem(key, value);
          }
        });
        return true;
      } catch (error) {
        console.warn('localStorage write denied:', error.message);
        return false;
      }
    }, tokens);
    return true;
  } catch (error) {
    console.warn('Failed to set localStorage:', error.message);
    return false;
  }
}

/**
 * Safely set sessionStorage with error handling
 */
async function safeSetSessionStorage(page, tokens) {
  // Validate tokens parameter
  if (!tokens || typeof tokens !== 'object' || Object.keys(tokens).length === 0) {
    console.warn('No valid tokens provided for sessionStorage');
    return false;
  }

  try {
    await page.evaluate((tokens) => {
      try {
        if (!tokens || typeof tokens !== 'object') {
          console.warn('Invalid tokens object in page context');
          return false;
        }
        
        // Check if sessionStorage is available
        if (typeof window === 'undefined' || !window.sessionStorage) {
          console.warn('sessionStorage not available in this context');
          return false;
        }
        
        Object.entries(tokens).forEach(([key, value]) => {
          if (key && value !== undefined && value !== null) {
            window.sessionStorage.setItem(key, value);
          }
        });
        return true;
      } catch (error) {
        console.warn('sessionStorage write denied:', error.message);
        return false;
      }
    }, tokens);
    return true;
  } catch (error) {
    console.warn('Failed to set sessionStorage:', error.message);
    return false;
  }
}

// Export safe storage + small shared utilities for use in other modules
export {
  safeGetLocalStorage,
  safeGetSessionStorage,
  safeSetLocalStorage,
  safeSetSessionStorage,
  takeScreenshot,
  detectCaptcha,
  handleCaptcha
};

/**
 * Collect all cookies from current page and send to backend
 */
async function collectAndSendCookies(page, jobId, currentUrl, context) {
  try {
    const allCookies = await page.context().cookies();
    const currentDomain = new URL(currentUrl).hostname;
    
    // Enrich cookies with metadata
    const enrichedCookies = allCookies.map(cookie => ({
      ...cookie,
      _metadata: {
        source: 'page-visit',
        collectedAt: new Date().toISOString(),
        targetDomain: currentDomain,
        originalDomain: cookie.domain || 'unknown',
        pageUrl: currentUrl
      }
    }));
    
    console.log(`🍪 Collected ${enrichedCookies.length} cookies from ${currentUrl}`);
    
    // Send cookies to backend for real-time update
    if (context.project_id && enrichedCookies.length > 0) {
      try {
        const response = await fetch(`${process.env.BACKEND_URL || 'http://172.19.0.1:4000'}/api/projects/${context.project_id}/cookies`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${context.runner_token || ''}`
          },
          body: JSON.stringify({
            cookies: enrichedCookies,
            source: 'crawling'
          })
        });
        
        if (response.ok) {
          const result = await response.json();
          console.log(`🍪 Updated project cookies: +${result.addedCount} new, ~${result.updatedCount} updated`);
          await sendLog(jobId, 'info', `🍪 Updated project cookies: +${result.addedCount} new, ~${result.updatedCount} updated`);
        } else {
          console.warn(`🍪 Failed to update project cookies: ${response.status}`);
        }
      } catch (error) {
        console.warn(`🍪 Error sending cookies to backend:`, error.message);
      }
    }
    
    return enrichedCookies;
  } catch (error) {
    console.error('Error collecting cookies:', error);
    return [];
  }
}

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
    
    // CRITICAL: Use AI-provided field mapping only - no static fallbacks
    if (!analysis.field_mapping || !analysis.field_mapping.username || !analysis.field_mapping.password || !analysis.field_mapping.submit) {
      return {
        success: false,
        message: 'AI analysis must provide field_mapping with username, password, and submit selectors. Cannot use static fallbacks.',
        details: { 
          hasFieldMapping: !!analysis.field_mapping,
          hasUsername: !!analysis.field_mapping?.username,
          hasPassword: !!analysis.field_mapping?.password,
          hasSubmit: !!analysis.field_mapping?.submit
        }
      };
    }
    
    const usernameSelector = analysis.field_mapping.username;
    const passwordSelector = analysis.field_mapping.password;
    const submitSelector = analysis.field_mapping.submit;
    
    usernameField = await page.$(usernameSelector);
    passwordField = await page.$(passwordSelector);
    submitButton = await page.$(submitSelector);
    
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
    const localStorage = await safeGetLocalStorage(page);
    const sessionStorage = await safeGetSessionStorage(page);
    
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

// ═══════════════════════════════════════════════════════════════
// APPROACH SEQUENCE IMPLEMENTATION
// Rule: 42-crawl-approaches-sequence.mdc
// ═══════════════════════════════════════════════════════════════

/**
 * Approach 1: Simplified
 * Uses Playwright to analyze page and provides structured JSON to OpenAI
 */
async function executeSimplifiedApproach(page, jobId, context, openaiClient) {
  const pageUrl = page.url();
  const pageTitle = await page.title();
  const allowSubdomains = context?.allow_subdomains === true;
  
  await sendLog(jobId, 'info', '🎯 APPROACH 1: Simplified (Playwright JSON Analysis)', { page_url: pageUrl });
  
  try {
    // Step 1: Extract forms with Playwright
    const forms = await extractFormsAndLogicalGroups(page, jobId);
    const links = await extractAllLinks(page, jobId, pageUrl, allowSubdomains);
    
    // Step 2: Build structured JSON for OpenAI
    const structuredData = {
      title: pageTitle,
      url: pageUrl,
      forms: forms.map(f => ({
        type: f.type,
        id: f.id || null,
        fields: f.inputs.map(input => ({
          type: input.type,
          name: input.name,
          label: input.label || input.placeholder || '',
          selector: input.selector,
          required: input.required
        })),
        submit: f.buttons && f.buttons[0] ? {
          text: f.buttons[0].text,
          selector: f.buttons[0].selector
        } : null
      })),
      links: links.internal.slice(0, 10).map(l => ({
        text: l.text,
        href: l.href,
        selector: `a[href="${l.href}"]`
      })),
      buttons: []
    };
    
    await sendLog(jobId, 'info', `📊 Extracted: ${forms.length} forms, ${links.total} links`, { page_url: pageUrl });
    
    // Step 3: Send to OpenAI for action decision using stored prompt template
    const structuredDataJson = JSON.stringify(structuredData, null, 2);
    const aiResponse = await aiConversationLogger.makeAICallWithPrompt(
      'simplified-approach-analysis',
      {
        page_url: pageUrl,
        page_title: pageTitle,
        structured_data: structuredDataJson,
        forms_count: forms.length,
        internal_links_count: links.internal.length,
        total_links_count: links.total,
        additional_prompt_text: context.additional_prompt_text || ''
      },
      jobId,
      'unified-crawler',
      pageUrl,
      null,
      { approach: 'simplified', structured_data_size: structuredDataJson.length }
    );

    if (aiResponse.page_summary) {
      await sendLog(jobId, 'info', `📄 Page Analysis: ${aiResponse.page_summary}`, { page_url: pageUrl });
    }

    if (aiResponse.chat_message) {
      await sendLog(jobId, 'info', `💬 AI Chat: ${aiResponse.chat_message}`, { page_url: pageUrl });
    }

    if (!aiResponse.action_type || typeof aiResponse.confidence !== 'number') {
      throw new Error(`Missing required fields in AI response: action_type=${aiResponse.action_type}, confidence=${aiResponse.confidence}`);
    }

    await sendLog(jobId, 'info', `🤖 AI Decision: ${aiResponse.action_type} (confidence: ${aiResponse.confidence})`, { page_url: pageUrl });
    
    return {
      success: aiResponse.confidence > 0.7,
      approach: 'simplified',
      ai_response: aiResponse,
      structured_data: structuredData
    };
    
  } catch (error) {
    await sendLog(jobId, 'error', `❌ Simplified approach failed: ${error.message}`, { page_url: pageUrl });
    return {
      success: false,
      approach: 'simplified',
      error: error.message
    };
  }
}

/**
 * Approach 2: Text
 * Sends full HTML to OpenAI, gets action list, then iterates per action
 */
async function executeTextApproach(page, jobId, context, openaiClient) {
  const pageUrl = page.url();
  const pageTitle = await page.title();
  
  await sendLog(jobId, 'info', '🎯 APPROACH 2: Text (Full HTML + Iteration)', { page_url: pageUrl });
  
  try {
    // Step 1: Get full HTML (truncate to prevent rate limit errors)
    const htmlContent = await page.content();
    // Limit to 20KB to stay under rate limits (10K tokens ~= 40KB text)
    const htmlSnippet = htmlContent.length > 20000 ? htmlContent.substring(0, 20000) + '\n\n[...truncated for rate limits]' : htmlContent;
    
    await sendLog(jobId, 'info', `📝 HTML extracted (${htmlContent.length} chars, using ${htmlSnippet.length} chars)`, { page_url: pageUrl });
    
    // Step 2: Get action list from OpenAI
    const listPromptTemplate = await aiConversationLogger.fetchPrompt('text-approach-action-list');
    if (!listPromptTemplate || !listPromptTemplate.user_message_template) {
      throw new Error('Prompt "text-approach-action-list" is not configured in the database');
    }

    const listPrompt = aiConversationLogger.replacePlaceholders(listPromptTemplate.user_message_template, {
      page_title: pageTitle,
      page_url: pageUrl,
      html_content: htmlSnippet,
      full_html_length: htmlContent.length,
      truncated_html_length: htmlSnippet.length
    });

    const listCompletion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      jobId,
      'unified-crawler',
      'text_approach_action_list',
      {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: listPrompt }],
      },
      null,
      pageUrl,
      { approach: 'text', html_length: htmlContent.length }
    );
    
    // Parse the comprehensive response format
    const rawContent = listCompletion.choices?.[0]?.message?.content || listCompletion.content || '';
    let parsedContent;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch (error) {
      throw new Error(`Failed to parse OpenAI response: ${error.message}`);
    }
    
    const actionList = JSON.parse(parsedContent.code);
    await sendLog(jobId, 'info', `📋 AI identified ${actionList.actions.length} actions (${actionList.page_type})`, { page_url: pageUrl });
    
    // Log human-readable summaries
    if (parsedContent.page_summary) {
      await sendLog(jobId, 'info', `📄 Page Analysis: ${parsedContent.page_summary}`, { page_url: pageUrl });
    }
    
    if (parsedContent.chat_message) {
      await sendLog(jobId, 'info', `💬 AI Chat: ${parsedContent.chat_message}`, { page_url: pageUrl });
    }
    
    // Step 3: Iterate through each action
    const executedActions = [];
    for (let i = 0; i < actionList.actions.length && i < 5; i++) {
      const actionDesc = actionList.actions[i];
      await sendLog(jobId, 'info', `🔄 Action ${i + 1}/${actionList.actions.length}: ${actionDesc}`, { page_url: pageUrl });
      
      // Ask OpenAI how to execute this specific action
      const execPrompt = `How to execute this action on the page?

ACTION: ${actionDesc}

HTML SNIPPET (relevant sections):
${htmlSnippet.substring(0, 5000)}

RESPOND WITH JSON:
{
  "method": "fill" | "click" | "wait",
  "selector": "CSS selector to target",
  "value": "value to use (if fill)" | null,
  "reasoning": "Why this selector"
}`;

      const execCompletion = await aiConversationLogger.createChatCompletion(
        openaiClient,
        jobId,
        'unified-crawler',
        `text_approach_action_${i + 1}`,
        {
          model: "gpt-5-mini",
          messages: [{ role: "user", content: execPrompt }],
        },
        null,
        pageUrl,
        { approach: 'text', action_index: i + 1, action_description: actionDesc }
      );
      
      const execDetails = JSON.parse(execCompletion.content);
      executedActions.push({ action: actionDesc, execution: execDetails });
      
      await sendLog(jobId, 'info', `  ✓ Method: ${execDetails.method}, Selector: ${execDetails.selector}`, { page_url: pageUrl });
    }
    
    return {
      success: actionList.confidence > 0.7,
      approach: 'text',
      action_list: actionList,
      executed_actions: executedActions
    };
    
  } catch (error) {
    await sendLog(jobId, 'error', `❌ Text approach failed: ${error.message}`, { page_url: pageUrl });
    return {
      success: false,
      approach: 'text',
      error: error.message
    };
  }
}

/**
 * Approach 3: Media
 * Uses screenshots for visual analysis, iterates with fresh screenshots
 */
async function executeMediaApproach(page, jobId, context, openaiClient) {
  const pageUrl = page.url();
  const pageTitle = await page.title();
  
  await sendLog(jobId, 'info', '🎯 APPROACH 3: Media (Screenshot-Based Visual Analysis)', { page_url: pageUrl });
  
  try {
    // Step 1: Take initial screenshot
    const initialScreenshot = await page.screenshot({ 
      type: 'png', 
      fullPage: true,
      animations: 'disabled'
    });
    const screenshotBase64 = initialScreenshot.toString('base64');
    
    await sendLog(jobId, 'info', `📸 Screenshot captured (Full HD 1920x1080)`, { page_url: pageUrl });
    
    // Step 2: Get visual action list from OpenAI
    const listPrompt = `Analyze this screenshot visually and identify all actions that should be performed.

PAGE TITLE: ${pageTitle}
PAGE URL: ${pageUrl}

CRITICAL: Respond with comprehensive JSON containing human-readable summaries AND structured data.

RESPOND WITH THIS EXACT FORMAT:
{
  "code": "{\"actions\": [\"Action 1 description\", \"Action 2 description\"], \"page_type\": \"login|form|content|dashboard\", \"confidence\": 0.0-1.0}",
  "page_summary": "Human-readable summary of what was found on this page and what actions will be taken",
  "chat_message": "Conversational message explaining the analysis and next steps for the user"
}`;

    const listCompletion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      jobId,
      'unified-crawler',
      'media_approach_visual_analysis',
      {
        model: "gpt-5-mini",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: listPrompt },
            { 
              type: "image_url", 
              image_url: { 
                url: `data:image/png;base64,${screenshotBase64}`,
                detail: "high"
              } 
            }
          ]
        }],
        max_completion_tokens: 128000
      },
      null,
      pageUrl,
      { approach: 'media', screenshot_size: initialScreenshot.length }
    );
    
    // Parse the comprehensive response format
    const rawContent = listCompletion.choices?.[0]?.message?.content || listCompletion.content || '';
    let parsedContent;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch (error) {
      throw new Error(`Failed to parse OpenAI response: ${error.message}`);
    }
    
    const visualAnalysis = JSON.parse(parsedContent.code);
    await sendLog(jobId, 'info', `👁️ Visual analysis complete`, { page_url: pageUrl });
    
    // Log human-readable summaries
    if (parsedContent.page_summary) {
      await sendLog(jobId, 'info', `📄 Page Analysis: ${parsedContent.page_summary}`, { page_url: pageUrl });
    }
    
    if (parsedContent.chat_message) {
      await sendLog(jobId, 'info', `💬 AI Chat: ${parsedContent.chat_message}`, { page_url: pageUrl });
    }
    
    // Step 3: Iterate through visual actions
    const executedActions = [];
    const actions = visualAnalysis.actions || [];
    
    for (let i = 0; i < actions.length && i < 3; i++) {
      const actionDesc = actions[i];
      await sendLog(jobId, 'info', `🔄 Visual Action ${i + 1}/${actions.length}: ${actionDesc}`, { page_url: pageUrl });
      
      // Take fresh screenshot for this action
      const freshScreenshot = await page.screenshot({ type: 'png', fullPage: false });
      const freshBase64 = freshScreenshot.toString('base64');
      
      // Ask OpenAI where the element is
      const locatePromptTemplate = await aiConversationLogger.fetchPrompt('media-approach-locate-action');
      if (!locatePromptTemplate || !locatePromptTemplate.user_message_template) {
        throw new Error('Prompt "media-approach-locate-action" is not configured in the database');
      }

      const locatePrompt = aiConversationLogger.replacePlaceholders(locatePromptTemplate.user_message_template, {
        action_description: actionDesc
      });

      const locateCompletion = await aiConversationLogger.createChatCompletion(
        openaiClient,
        jobId,
        'unified-crawler',
        `media_approach_locate_${i + 1}`,
        {
          model: "gpt-5-mini",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: locatePrompt },
              { 
                type: "image_url", 
                image_url: { url: `data:image/png;base64,${freshBase64}`, detail: "high" } 
              }
            ]
          }],
          max_completion_tokens: 128000
        },
        null,
        pageUrl,
        { approach: 'media', action_index: i + 1 }
      );
      
      const locationData = JSON.parse(locateCompletion.content);
      executedActions.push({ action: actionDesc, location: locationData });
      
      await sendLog(jobId, 'info', `  ✓ Location: ${locationData.location_strategy}`, { page_url: pageUrl });
    }
    
    return {
      success: true,
      approach: 'media',
      visual_analysis: visualAnalysis,
      executed_actions: executedActions
    };
    
  } catch (error) {
    await sendLog(jobId, 'error', `❌ Media approach failed: ${error.message}`, { page_url: pageUrl });
    return {
      success: false,
      approach: 'media',
      error: error.message
    };
  }
}

/**
 * Approach 4: Static (AI QA Automation)
 * Generates Playwright test scripts using metadata and common selectors
 */
async function executeStaticApproach(page, jobId, context, openaiClient, pageId, projectId) {
  const pageUrl = page.url();
  const pageTitle = await page.title();
  
  await sendLog(jobId, 'info', '🎯 APPROACH 4: Static (AI Script Generation for QA Automation)', { page_url: pageUrl });
  
  try {
    const backendUrl = process.env.BACKEND_URL || 'http://back:4000';
    const runnerToken = context?.runner_token || process.env.RUNNER_TOKEN || null;
    const authHeaders = runnerToken ? { 'Authorization': `Bearer ${runnerToken}` } : {};
    const cacheBucket = 'static-approach';

    // Cache reuse: if we already generated scripts for this page recently, reuse them.
    try {
      const cachedRes = await fetch(
        `${backendUrl}/scripts/cache/list?project_id=${encodeURIComponent(projectId)}&page_id=${encodeURIComponent(pageId)}&cache_bucket=${encodeURIComponent(cacheBucket)}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          }
        }
      );
      if (cachedRes.ok) {
        const cachedScripts = await cachedRes.json();
        if (Array.isArray(cachedScripts) && cachedScripts.length > 0) {
          await sendLog(jobId, 'info', `✅ [SCRIPTS-CACHE] Reused ${cachedScripts.length} cached static script(s)`, { page_url: pageUrl });
          return {
            success: true,
            approach: 'static',
            cache_hit: true,
            saved_scripts: cachedScripts,
            metadata: null,
            common_selectors: []
          };
        }
      }
    } catch (cacheErr) {
      await sendLog(jobId, 'warn', `⚠️ [SCRIPTS-CACHE] Static cache lookup failed: ${cacheErr.message}`, { page_url: pageUrl });
    }

    // Step 1: Extract metadata ONLY (no deep analysis)
    const metadata = await page.evaluate(() => {
      return {
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || '',
        keywords: document.querySelector('meta[name="keywords"]')?.content || '',
        h1: document.querySelector('h1')?.textContent || '',
        h2: Array.from(document.querySelectorAll('h2')).map(h => h.textContent).slice(0, 3)
      };
    });
    
    // Step 2: Detect common selectors present on page
    const commonSelectors = await page.evaluate(() => {
      const selectors = [
        'input[type="email"]',
        'input[type="text"]',
        'input[type="password"]',
        'button[type="submit"]',
        'input[type="submit"]',
        '#username',
        '#email',
        '#password',
        '#login',
        '[name="username"]',
        '[name="email"]',
        '[name="password"]'
      ];
      
      return selectors.filter(sel => {
        try {
          return document.querySelector(sel) !== null;
        } catch {
          return false;
        }
      });
    });
    
    await sendLog(jobId, 'info', `📋 Metadata extracted, ${commonSelectors.length} common selectors found`, { page_url: pageUrl });
    
    // Step 3: Send to OpenAI for Playwright script generation
    const scriptPromptTemplate = await aiConversationLogger.fetchPrompt('static-approach-script-generation');
    if (!scriptPromptTemplate || !scriptPromptTemplate.user_message_template) {
      throw new Error('Prompt "static-approach-script-generation" is not configured in the database');
    }

    const scriptPrompt = aiConversationLogger.replacePlaceholders(scriptPromptTemplate.user_message_template, {
      page_title: metadata.title,
      page_url: pageUrl,
      page_description: metadata.description,
      page_keywords: metadata.keywords,
      main_heading: metadata.h1,
      subheadings: metadata.h2.join(', '),
      available_selectors: commonSelectors.map(sel => `- ${sel}`).join('\n')
    });

    const scriptCompletion = await aiConversationLogger.createChatCompletion(
      openaiClient,
      jobId,
      'unified-crawler',
      'static_approach_script_generation',
      {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: scriptPrompt }],
        max_completion_tokens: 128000
      },
      null,
      pageUrl,
      { approach: 'static', common_selectors_count: commonSelectors.length }
    );
    
    // Parse the comprehensive response format
    const rawContent = scriptCompletion.choices?.[0]?.message?.content || scriptCompletion.content || '';
    let parsedContent;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch (error) {
      throw new Error(`Failed to parse OpenAI response: ${error.message}`);
    }
    
    const aiResponse = JSON.parse(parsedContent.code);
    await sendLog(jobId, 'info', `🤖 AI generated ${aiResponse.scenarios?.length || 0} test scenarios`, { page_url: pageUrl });
    
    // Log human-readable summaries
    if (parsedContent.page_summary) {
      await sendLog(jobId, 'info', `📄 Page Analysis: ${parsedContent.page_summary}`, { page_url: pageUrl });
    }
    
    if (parsedContent.chat_message) {
      await sendLog(jobId, 'info', `💬 AI Chat: ${parsedContent.chat_message}`, { page_url: pageUrl });
    }
    
    // Step 4: Save each script to scripts collection
    const savedScripts = [];
    
    for (const scenario of (aiResponse.scenarios || [])) {
      try {
        const scenarioCacheKey = [
          cacheBucket,
          String(projectId),
          String(pageId),
          String(scenario.name || '').trim()
        ].join(':');

        const scriptResponse = await fetch(`${backendUrl}/scripts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders
          },
          body: JSON.stringify({
            project_id: projectId,
            page_id: pageId,
            name: scenario.name,
            description: scenario.description,
            script_type: 'playwright',
            script_code: scenario.playwright_script,
            parameters: scenario.parameters,
            generated_by: 'ai',
            ai_prompt: scriptPrompt,
            ai_model: 'gpt-5-mini',
            expected_outcome: scenario.expected_outcome,
            validation_rules: scenario.validation_rules || [],
            status: 'active',
            cache_bucket: cacheBucket,
            cache_key: scenarioCacheKey,
            tags: ['static-approach']
          })
        });
        
        if (scriptResponse.ok) {
          const savedScript = await scriptResponse.json();
          savedScripts.push(savedScript);
          await sendLog(jobId, 'info', `  ✓ Script saved: ${scenario.name} (ID: ${savedScript._id})`, { page_url: pageUrl });
          
          // Step 5: Create action record
          const actionResponse = await fetch(`${backendUrl}/api/actions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders
            },
            body: JSON.stringify({
              project_id: projectId,
              page_id: pageId,
              script_id: savedScript._id,
              type: 'ai_test_script',
              description: `AI-generated test: ${scenario.name}`,
              execution_count: 0
            })
          });
          
          if (actionResponse.ok) {
            const action = await actionResponse.json();
            await sendLog(jobId, 'info', `  ✓ Action created (ID: ${action._id})`, { page_url: pageUrl });
          }
        }
      } catch (saveError) {
        await sendLog(jobId, 'error', `  ❌ Failed to save script: ${saveError.message}`, { page_url: pageUrl });
      }
    }
    
    return {
      success: savedScripts.length > 0,
      approach: 'static',
      ai_response: aiResponse,
      saved_scripts: savedScripts,
      metadata: metadata,
      common_selectors: commonSelectors
    };
    
  } catch (error) {
    await sendLog(jobId, 'error', `❌ Static approach failed: ${error.message}`, { page_url: pageUrl });
    return {
      success: false,
      approach: 'static',
      error: error.message
    };
  }
}

/**
 * Verify action completion with OpenAI
 */
async function verifyActionWithOpenAI(page, jobId, approach, openaiClient) {
  const pageUrl = page.url();
  const pageTitle = await page.title();
  
  try {
    let verificationPrompt;
    let messages;
    
    if (approach === 'media') {
      // Use screenshot for verification
      const screenshot = await page.screenshot({ type: 'png', fullPage: false });
      const screenshotBase64 = screenshot.toString('base64');
      
      verificationPrompt = `Analyze this screenshot to determine if the previous action was successful.

Current URL: ${pageUrl}
Current Title: ${pageTitle}

RESPOND WITH JSON:
{
  "status": "success" | "failure" | "in_progress",
  "confidence": 0.0-1.0,
  "reason": "Explanation of status",
  "next_action": "What should happen next" | null
}`;

      messages = [{
        role: "user",
        content: [
          { type: "text", text: verificationPrompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: "low" } }
        ]
      }];
    } else {
      // Use HTML for verification
      const htmlContent = await page.content();
      const htmlSnippet = htmlContent.substring(0, 10000);
      
      verificationPrompt = `Analyze this page to determine if the previous action was successful.

Current URL: ${pageUrl}
Current Title: ${pageTitle}

HTML SNIPPET:
${htmlSnippet}

RESPOND WITH JSON:
{
  "status": "success" | "failure" | "in_progress",
  "confidence": 0.0-1.0,
  "reason": "Explanation of status",
  "next_action": "What should happen next" | null
}`;

      messages = [{ role: "user", content: verificationPrompt }];
    }
    
    const verification = await aiConversationLogger.createChatCompletion(
      openaiClient,
      jobId,
      'unified-crawler',
      'action_verification',
      {
        model: "gpt-5-mini",
        messages: messages,
      },
      null,
      pageUrl,
      { verification_approach: approach }
    );
    
    return JSON.parse(verification.content);
  } catch (error) {
    return {
      status: "in_progress",
      confidence: 0.5,
      reason: `Verification failed: ${error.message}`,
      next_action: "continue"
    };
  }
}

/**
 * Execute approach sequence with iteration
 * Implements rule 42-crawl-approaches-sequence.mdc
 */
/**
 * DEPRECATED: Sequential approach execution
 * This function is deprecated in favor of the comprehensive first request approach.
 * Kept for backward compatibility only.
 * NEW APPROACH: WorkflowAnalyzer and WorkflowExecutor send ALL context in first request
 * with intelligent 2-attempt retry instead of trying multiple sequential approaches.
 */
async function executeApproachSequence(page, jobId, context, openaiClient, pageId, projectId) {
  console.warn('[DEPRECATED] executeApproachSequence is deprecated. Use WorkflowAnalyzer/WorkflowExecutor instead.');
  const approaches = ['simplified', 'text', 'media', 'static'];
  const maxDepth = context.options?.max_depth || 5;
  const maxTries = context.options?.max_tries || 10;
  const startTime = Date.now();
  const maxTime = 15 * 60 * 1000; // 15 minutes
  
  let depth = 0;
  let tries = 0;
  let currentApproachIndex = 0;
  
  await sendLog(jobId, 'info', `🔄 Starting approach sequence: ${approaches.join(' → ')}`, { page_url: page.url() });
  await sendLog(jobId, 'info', `📊 Limits: depth=${maxDepth}, tries=${maxTries}, time=15min`, { page_url: page.url() });
  
  while (depth < maxDepth && tries < maxTries && (Date.now() - startTime) < maxTime) {
    const currentApproach = approaches[currentApproachIndex];
    depth++;
    tries++;
    
    await sendLog(jobId, 'info', `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, { page_url: page.url() });
    await sendLog(jobId, 'info', `🔄 Iteration ${tries}: Approach ${currentApproachIndex + 1}/4 (${currentApproach})`, { page_url: page.url() });
    await sendLog(jobId, 'info', `📊 Depth: ${depth}/${maxDepth}, Tries: ${tries}/${maxTries}`, { page_url: page.url() });
    
    // Execute approach
    let result;
    switch (currentApproach) {
      case 'simplified':
        result = await executeSimplifiedApproach(page, jobId, context, openaiClient);
        break;
      case 'text':
        result = await executeTextApproach(page, jobId, context, openaiClient);
        break;
      case 'media':
        result = await executeMediaApproach(page, jobId, context, openaiClient);
        break;
      case 'static':
        result = await executeStaticApproach(page, jobId, context, openaiClient, pageId, projectId);
        break;
    }
    
    await sendLog(jobId, 'info', `${result.success ? '✅' : '❌'} Approach result: ${result.success ? 'Success' : 'Failed'}`, { page_url: page.url() });
    
    // Verify with OpenAI
    const verification = await verifyActionWithOpenAI(page, jobId, currentApproach, openaiClient);
    await sendLog(jobId, 'info', `🤖 Verification: ${verification.status} (confidence: ${verification.confidence})`, { page_url: page.url() });
    await sendLog(jobId, 'info', `   Reason: ${verification.reason}`, { page_url: page.url() });
    
    // Decision logic
    if (verification.status === 'success' && verification.confidence > 0.8) {
      await sendLog(jobId, 'info', `\n✅ SUCCESS: Action completed with ${currentApproach} approach!`, { page_url: page.url() });
      return {
        success: true,
        final_approach: currentApproach,
        iterations: tries,
        depth: depth,
        verification: verification,
        result: result
      };
    }
    
    if (verification.status === 'failure' && verification.confidence > 0.8) {
      await sendLog(jobId, 'info', `\n❌ FAILURE: Action failed with ${currentApproach} approach`, { page_url: page.url() });
      return {
        success: false,
        final_approach: currentApproach,
        iterations: tries,
        depth: depth,
        verification: verification,
        result: result
      };
    }
    
    // Move to next approach
    currentApproachIndex = (currentApproachIndex + 1) % approaches.length;
    
    if (currentApproachIndex === 0) {
      await sendLog(jobId, 'info', `🔄 Completed full cycle, starting next depth level...`, { page_url: page.url() });
    }
    
    // Small delay between attempts
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Limits reached
  await sendLog(jobId, 'warn', `\n⚠️ Limits reached: depth=${depth}, tries=${tries}, time=${(Date.now() - startTime) / 1000}s`, { page_url: page.url() });
  return {
    success: false,
    final_approach: null,
    iterations: tries,
    depth: depth,
    reason: 'Limits exceeded'
  };
}

// Main exported functions

export async function startCrawl(url, cookies, context, openaiApiKey = null) {
  const startTime = Date.now();
  const jobId = context.job_id || 'unknown';
  
  // MANDATORY: All crawl jobs must use workflow templates
  if (!context.workflow_template_id) {
    throw new Error('workflow_template_id is required - all jobs must use workflows stored in MongoDB');
  }
  
  // Force workflow mode - ignore deprecated approach_mode
  const mode = 'workflow';
  
  await sendLog(jobId, 'info', `🚀 Starting WORKFLOW mode crawl process for ${url} (template: ${context.workflow_template_id})`, { mode, workflow_template_id: context.workflow_template_id });
  
  // Check job status before starting - accept 'running', 'pending', 'queued', and 'unknown'
  // 'unknown' can happen if job was just created (race condition) - retry a few times
  let jobStatus = await checkJobStatus(jobId, context.runner_token);
  let retries = 0;
  const maxRetries = 3;
  
  while (jobStatus === 'unknown' && retries < maxRetries) {
    await sendLog(jobId, 'info', `⏳ Job status is 'unknown', retrying in 2 seconds... (attempt ${retries + 1}/${maxRetries})`, { mode });
    await new Promise(resolve => setTimeout(resolve, 2000));
    jobStatus = await checkJobStatus(jobId, context.runner_token);
    retries++;
  }
  
  const validStatuses = ['running', 'pending', 'queued'];
  const invalidStatuses = ['failed', 'cancelled', 'completed'];
  
  if (invalidStatuses.includes(jobStatus)) {
    await sendLog(jobId, 'warn', `⚠️ Job status is ${jobStatus}, stopping crawl execution`, { mode, jobStatus });
    throw new Error(`Job status is ${jobStatus}, cannot start crawl`);
  }
  
  // If still unknown after retries, log warning but proceed (job may be newly created)
  if (jobStatus === 'unknown') {
    await sendLog(jobId, 'warn', `⚠️ Job status is still 'unknown' after ${maxRetries} retries, proceeding anyway (job may be newly created)`, { mode });
  }
  
  try {
    // Use configured endpoint if available, otherwise fall back to direct OpenAI
    const openaiClient = createOpenAIClient(context, openaiApiKey);

    // SSO flows often bounce across sibling subdomains (e.g. webapp.* -> auth.* -> app.*).
    // When we detect that pattern, allow crawling across subdomains of the same base domain.
    // This is best-effort and intentionally naive (last 2 labels).
    let allowSubdomains = context?.allow_subdomains === true;
    if (!allowSubdomains) {
      try {
        const startHost = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        const loginHost = context?.login_url
          ? new URL(context.login_url).hostname.replace(/^www\./, '').toLowerCase()
          : null;
        const baseOf = (host) => {
          const parts = String(host || '').split('.').filter(Boolean);
          if (parts.length < 2) return String(host || '');
          return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
        };
        if (loginHost && startHost !== loginHost && baseOf(startHost) === baseOf(loginHost)) {
          allowSubdomains = true;
        }
      } catch (_) {
        // ignore
      }
    }

    // Make the decision visible to all downstream helpers that only receive `context`/`options`.
    if (context && typeof context === 'object') {
      context.allow_subdomains = allowSubdomains;
      if (context.options && typeof context.options === 'object') {
        context.options.allow_subdomains = allowSubdomains;
      }
    }
    
    // Load workflow template to check for cookie-collect steps that need to run before navigation
    let preNavigationCookieSteps = [];
    const projectId = context.project_id || context.projectId || null;
    const workflowTemplateId = context.workflow_template_id || null;
    
    if (workflowTemplateId && projectId) {
      try {
        const axios = (await import('axios')).default;
        await sendLog(jobId, 'info', `🔍 Loading workflow template ${workflowTemplateId} to check for pre-navigation cookie steps...`);
        const workflowResponse = await axios.get(`${process.env.BACKEND_URL || 'http://back:4000'}/api/workflow-templates/${workflowTemplateId}`, {
          headers: {
            'Authorization': `Bearer ${context.runner_token || ''}`
          }
        });
        const workflowTemplate = workflowResponse.data;
        
        // Find cookie-collect steps that should run before navigation
        preNavigationCookieSteps = workflowTemplate.steps?.filter(step => 
          step.type === 'cookie-collect' && 
          step.config?.reloadFromProject === true
        ) || [];
        
        if (preNavigationCookieSteps.length > 0) {
          await sendLog(jobId, 'info', `🍪 Found ${preNavigationCookieSteps.length} pre-navigation cookie-collect step(s) in workflow`);
        } else {
          await sendLog(jobId, 'info', `ℹ️ No pre-navigation cookie-collect steps found in workflow`);
        }
      } catch (workflowError) {
        await sendLog(jobId, 'warn', `⚠️ Could not load workflow template for pre-navigation cookie steps: ${workflowError.message}`);
      }
    } else {
      await sendLog(jobId, 'warn', `⚠️ Missing workflow_template_id (${workflowTemplateId}) or project_id (${projectId}), skipping pre-navigation cookie check`);
    }
    
    const result = await withBrowser(async ({ page, context: browserContext }) => {
      await sendLog(jobId, 'info', 'Browser session started', { mode, allowSubdomains });

      // Diagnostics: capture runtime JS errors and failed requests so we can explain
      // "Application error: a client-side exception has occurred" screenshots.
      try {
        let consoleCount = 0;
        let pageErrorCount = 0;
        let requestFailCount = 0;
        let responseCount = 0;
        const maxEach = 25;

        page.on('console', (msg) => {
          try {
            const type = msg.type();
            if (!['error', 'warning'].includes(type)) return;
            if (consoleCount >= maxEach) return;
            consoleCount++;
            void sendLog(jobId, type === 'error' ? 'error' : 'warn', `🧾 [BROWSER CONSOLE] ${msg.text()}`, {
              component: 'BROWSER-DIAGNOSTICS',
              console_type: type,
              page_url: (() => { try { return page.url(); } catch { return null; } })()
            });
          } catch (_) {
            // ignore
          }
        });

        page.on('pageerror', (err) => {
          try {
            if (pageErrorCount >= maxEach) return;
            pageErrorCount++;
            void sendLog(jobId, 'error', `💥 [PAGE ERROR] ${String(err?.message || err)}`, {
              component: 'BROWSER-DIAGNOSTICS',
              page_url: (() => { try { return page.url(); } catch { return null; } })()
            });
          } catch (_) {
            // ignore
          }
        });

        page.on('requestfailed', (req) => {
          try {
            if (requestFailCount >= maxEach) return;
            requestFailCount++;
            void sendLog(jobId, 'warn', `🌐 [REQUEST FAILED] ${req.url()} (${req.failure()?.errorText || 'unknown'})`, {
              component: 'BROWSER-DIAGNOSTICS',
              method: req.method(),
              resource_type: req.resourceType(),
              page_url: (() => { try { return page.url(); } catch { return null; } })()
            });
          } catch (_) {
            // ignore
          }
        });

        // Log navigation/document responses (especially 5xx/4xx) to debug cases where screenshots show
        // CDN errors (503) but we have no failed-request event (since response still exists).
        page.on('response', (resp) => {
          try {
            if (responseCount >= maxEach) return;
            const req = resp.request();
            if (!req || !req.isNavigationRequest || !req.isNavigationRequest()) return;
            if (req.resourceType && req.resourceType() !== 'document') return;
            const status = resp.status();
            if (status < 400) return;
            responseCount++;
            const headers = resp.headers ? resp.headers() : {};
            void sendLog(jobId, status >= 500 ? 'warn' : 'warn', `📡 [NAV RESPONSE] ${status} ${resp.url()}`, {
              component: 'BROWSER-DIAGNOSTICS',
              status,
              url: resp.url(),
              server: headers?.server || null,
              via: headers?.via || null,
              'x-cache': headers?.['x-cache'] || null,
              'cf-ray': headers?.['cf-ray'] || null,
              'cf-cache-status': headers?.['cf-cache-status'] || null
            });
          } catch (_) {
            // ignore
          }
        });
      } catch (diagErr) {
        // never fail crawl due to diagnostics wiring
        console.warn(`[BROWSER-DIAGNOSTICS] Failed to attach diagnostics: ${diagErr.message}`);
      }
      
      // Set initial cookies if provided
      if (cookies && cookies.length > 0) {
        await sendLog(jobId, 'info', `🍪 Setting ${cookies.length} cookies for authentication...`);
        try {
          await browserContext.addCookies(cookies);
          await sendLog(jobId, 'info', `✅ Successfully set ${cookies.length} cookies in browser context`);
        } catch (cookieError) {
          await sendLog(jobId, 'warn', `⚠️ Failed to set some cookies: ${cookieError.message}`);
          // Try to set cookies one by one to identify which ones fail
          let successCount = 0;
          for (const cookie of cookies) {
            try {
              await browserContext.addCookies([cookie]);
              successCount++;
            } catch (err) {
              await sendLog(jobId, 'warn', `⚠️ Failed to set cookie ${cookie.name} for domain ${cookie.domain}: ${err.message}`);
            }
          }
          await sendLog(jobId, 'info', `✅ Set ${successCount}/${cookies.length} cookies successfully`);
        }
      } else {
        await sendLog(jobId, 'info', `ℹ️ No cookies provided, proceeding without authentication`);
      }
      
      // Execute cookie-collect steps that need to run before navigation (workflow-driven)
      // ALSO: Always try to load cookies from project if projectId is available (even if no pre-navigation steps)
      if (projectId) {
        try {
          const axios = (await import('axios')).default;
          
          // If there are pre-navigation cookie steps, execute them
          if (preNavigationCookieSteps.length > 0) {
            await sendLog(jobId, 'info', `🍪 Executing ${preNavigationCookieSteps.length} pre-navigation cookie-collect step(s) from workflow...`);
            
            for (const step of preNavigationCookieSteps) {
              const stepConfig = step.config || {};
              const reloadFromProject = stepConfig.reloadFromProject !== false; // Default to true
              
              if (reloadFromProject) {
                // Handle both string and ObjectId project_id
                const projectIdStr = typeof projectId === 'object' 
                  ? projectId.toString() 
                  : String(projectId || '');
                
                if (!projectIdStr) {
                  await sendLog(jobId, 'warn', `⚠️ [${step.name}] No project_id available, skipping cookie reload`);
                  continue;
                }
                
                const projectCookiesResponse = await axios.get(`${process.env.BACKEND_URL || 'http://back:4000'}/api/projects/${projectIdStr}/cookies`, {
                  headers: {
                    'Authorization': `Bearer ${context.runner_token || ''}`
                  }
                });
                
                if (projectCookiesResponse.data && Array.isArray(projectCookiesResponse.data) && projectCookiesResponse.data.length > 0) {
                  const projectCookies = projectCookiesResponse.data;
                  const currentCookies = await browserContext.cookies();
                  const currentCookieMap = new Map(currentCookies.map(c => [`${c.name}:${c.domain}`, c]));
                  
                  const cookiesToAdd = projectCookies.filter(cookie => {
                    const key = `${cookie.name}:${cookie.domain}`;
                    const existing = currentCookieMap.get(key);
                    return !existing || existing.value !== cookie.value || existing.expires !== cookie.expires;
                  });
                  
                  if (cookiesToAdd.length > 0) {
                    try {
                      await browserContext.addCookies(cookiesToAdd);
                      await sendLog(jobId, 'info', `🍪 [${step.name}] Reloaded ${cookiesToAdd.length} cookies from project before navigation`);
                    } catch (reloadError) {
                      await sendLog(jobId, 'warn', `⚠️ [${step.name}] Failed to reload some cookies: ${reloadError.message}`);
                    }
                  } else {
                    await sendLog(jobId, 'info', `🍪 [${step.name}] All project cookies already set in browser context`);
                  }
                }
              }
            }
          } else {
            // No pre-navigation steps, but we have projectId - load cookies anyway
            const projectIdStr = typeof projectId === 'object' 
              ? projectId.toString() 
              : String(projectId || '');
            
            if (projectIdStr) {
              await sendLog(jobId, 'info', `🍪 Loading cookies from project (no pre-navigation steps defined)...`);
              try {
                const projectCookiesResponse = await axios.get(`${process.env.BACKEND_URL || 'http://back:4000'}/api/projects/${projectIdStr}/cookies`, {
                  headers: {
                    'Authorization': `Bearer ${context.runner_token || ''}`
                  }
                });
                
                if (projectCookiesResponse.data && Array.isArray(projectCookiesResponse.data) && projectCookiesResponse.data.length > 0) {
                  const projectCookies = projectCookiesResponse.data;
                  const currentCookies = await browserContext.cookies();
                  const currentCookieMap = new Map(currentCookies.map(c => [`${c.name}:${c.domain}`, c]));
                  
                  const cookiesToAdd = projectCookies.filter(cookie => {
                    const key = `${cookie.name}:${cookie.domain}`;
                    const existing = currentCookieMap.get(key);
                    return !existing || existing.value !== cookie.value || existing.expires !== cookie.expires;
                  });
                  
                  if (cookiesToAdd.length > 0) {
                    try {
                      await browserContext.addCookies(cookiesToAdd);
                      await sendLog(jobId, 'info', `🍪 Reloaded ${cookiesToAdd.length} cookies from project before navigation`);
                    } catch (reloadError) {
                      await sendLog(jobId, 'warn', `⚠️ Failed to reload some cookies: ${reloadError.message}`);
                    }
                  } else {
                    await sendLog(jobId, 'info', `🍪 All project cookies already set in browser context`);
                  }
                } else {
                  await sendLog(jobId, 'info', `ℹ️ No cookies found in project`);
                }
              } catch (cookieLoadError) {
                await sendLog(jobId, 'warn', `⚠️ Failed to load cookies from project: ${cookieLoadError.message}`);
              }
            }
          }
        } catch (cookieStepError) {
          await sendLog(jobId, 'warn', `⚠️ Pre-navigation cookie steps failed: ${cookieStepError.message}`);
        }
      } else {
        await sendLog(jobId, 'warn', `⚠️ No project_id available, cannot load cookies from project`);
      }
      
      // Set authentication tokens from login if provided
      if (context.authTokens) {
        await sendLog(jobId, 'info', '🔑 Setting authentication tokens from login...');
        
        // Set localStorage tokens
        if (context.authTokens && context.authTokens.localStorage && typeof context.authTokens.localStorage === 'object' && Object.keys(context.authTokens.localStorage).length > 0) {
          const localStorageSuccess = await safeSetLocalStorage(page, context.authTokens.localStorage);
          if (localStorageSuccess) {
            await sendLog(jobId, 'info', `📦 Set ${Object.keys(context.authTokens.localStorage).length} localStorage tokens`);
          } else {
            await sendLog(jobId, 'warn', `⚠️ Failed to set localStorage tokens (access denied or invalid data)`);
          }
        }
        
        // Set sessionStorage tokens
        if (context.authTokens && context.authTokens.sessionStorage && typeof context.authTokens.sessionStorage === 'object' && Object.keys(context.authTokens.sessionStorage).length > 0) {
          const sessionStorageSuccess = await safeSetSessionStorage(page, context.authTokens.sessionStorage);
          if (sessionStorageSuccess) {
            await sendLog(jobId, 'info', `📦 Set ${Object.keys(context.authTokens.sessionStorage).length} sessionStorage tokens`);
          } else {
            await sendLog(jobId, 'warn', `⚠️ Failed to set sessionStorage tokens (access denied or invalid data)`);
          }
        }
        
        // Set additional cookies from authTokens
        if (context.authTokens.cookies && context.authTokens.cookies.length > 0) {
          await browserContext.addCookies(context.authTokens.cookies);
          await sendLog(jobId, 'info', `🍪 Set ${context.authTokens.cookies.length} authentication cookies`);
        }
      }

      // Navigate to URL (cookies should already be set in browser context)
      await sendLog(jobId, 'info', `Navigate: ${url}`, { mode });
      
      // Verify cookies are set before navigation
      const cookiesBeforeNav = await browserContext.cookies();
      await sendLog(jobId, 'info', `🍪 Browser context has ${cookiesBeforeNav.length} cookie(s) before navigation`);
      
      // Workflow-mode navigation: be resilient to transient CDN/origin 5xx (common on dev envs).
      // We log the status explicitly because a 503 returns a response (no requestfailed event).
      let navResponse = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      let navStatus = navResponse ? navResponse.status() : null;
      if (navStatus && navStatus >= 500) {
        await sendLog(jobId, 'warn', `⚠️ Initial navigation returned HTTP ${navStatus} for ${url} — retrying with backoff...`, {
          component: 'CRAWLER-TEXT',
          action: 'startcrawl_nav_retry_5xx',
          url,
          status: navStatus
        });
        // Two retries with increasing wait.
        const delays = [3000, 7000];
        for (const d of delays) {
          await page.waitForTimeout(d);
          navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          navStatus = navResponse ? navResponse.status() : null;
          if (!navStatus || navStatus < 500) break;
        }
        if (navStatus && navStatus >= 500) {
          await sendLog(jobId, 'warn', `⚠️ Navigation still HTTP ${navStatus} after retries`, {
            component: 'CRAWLER-TEXT',
            action: 'startcrawl_nav_retry_5xx_failed',
            url,
            status: navStatus
          });
        } else {
          await sendLog(jobId, 'info', `✅ Navigation recovered after retry (status=${navStatus ?? 'unknown'})`, {
            component: 'CRAWLER-TEXT',
            action: 'startcrawl_nav_retry_recovered',
            url,
            status: navStatus ?? null
          });
        }
      }

      // Fail fast on persistent 5xx to avoid wasting AI tokens analyzing an upstream error page.
      if (navStatus && navStatus >= 500) {
        let serverHeader = null;
        try {
          const h = navResponse?.headers ? navResponse.headers() : null;
          serverHeader = h?.server || null;
        } catch (_) {}
        throw new Error(`Start URL returned HTTP ${navStatus}${serverHeader ? ` (server=${serverHeader})` : ''}`);
      }
      
      // Check if navigation redirected (cookies might have caused redirect)
      const finalUrl = page.url();
      if (finalUrl !== url) {
        await sendLog(jobId, 'info', `🔄 Navigation redirected from ${url} to ${finalUrl} (likely due to cookies)`);
      }
      
      // Wait for navigation if DOM is loaded, otherwise wait for timeout then analyze
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        await sendLog(jobId, 'info', '✅ Page DOM loaded', { mode });
      } catch (error) {
        await sendLog(jobId, 'warn', '⚠️ Page DOM not fully loaded after 30s, proceeding with analysis');
        // Continue anyway - don't wait additional time
        await sendLog(jobId, 'info', '🔍 Analyzing page state with AI...', { mode });
      }

      // Collect all cookies from this page visit
      await collectAndSendCookies(page, jobId, url, context);

      // Execute mode-specific operation
      const modeHandler = modeHandlers[mode];
      if (!modeHandler) {
        throw new Error(`Unknown mode: ${mode}`);
      }

      const operationResult = await modeHandler(page, context, openaiClient, 'crawl');
      
      const workflowCaps = context.workflow_capabilities || {};
      // Workflow mode already performs rich element discovery during analyzer execution.
      // Skipping duplicate post-workflow extraction avoids late-run instability.
      const shouldExtractElements = mode !== 'workflow'
        || (workflowCaps.usesPlaywrightAnalysis === true
          && context.options?.force_post_workflow_element_extraction === true);
      
      // Extract page elements for storage only when required
      let pageElements = { interactive: [], nonInteractive: [] };
      if (shouldExtractElements) {
        try {
          pageElements = await extractPageElements(page, jobId);
        } catch (error) {
          await sendLog(jobId, 'warn', `⚠️ Could not extract final page elements (browser may have closed): ${error.message}`);
        }
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
      enable_screenshots: mode === 'workflow'
        ? (context.workflow_capabilities?.usesScreenshotStep === true)
        : (context.options?.enable_screenshots !== false),
      enable_video_recording: true, // MANDATORY per rule 38-video-recording-mandatory.mdc
      job_id: jobId,
      jobId: jobId,
      browserServiceUrl: context.browserServiceUrl,
      onPageReady: context.onPageReady, // Pass callback for browser streaming
      onContextReady: context.onContextReady // Pass callback for video recording
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
