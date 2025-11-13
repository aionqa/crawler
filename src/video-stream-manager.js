/**
 * Real-time Video Stream Manager
 * Handles continuous video streaming with buffer for rewind capability
 * Uses Playwright's video recording + FFmpeg for real-time streaming
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

class VideoStreamManager {
  constructor(backendUrl, runnerId) {
    this.backendUrl = backendUrl;
    this.runnerId = runnerId;
    this.activeStreams = new Map(); // jobId -> stream info
    this.frameBuffer = new Map(); // jobId -> circular buffer of frames
    this.bufferSize = 150; // Keep last 150 frames (30 seconds at 5fps)
  }

  /**
   * Start streaming for a job
   * @param {string} jobId - Job ID
   * @param {Page} page - Playwright page object
   * @param {Object} options - Streaming options
   */
  async startStream(jobId, page, options = {}) {
    if (this.activeStreams.has(jobId)) {
      console.log(`[VIDEO-STREAM] Stream already active for job ${jobId}`);
      return;
    }

    console.log(`[VIDEO-STREAM] Starting real-time stream for job ${jobId}`);

    const streamInfo = {
      jobId,
      page,
      interval: options.interval || 200, // 5 FPS (200ms between frames)
      isActive: true,
      frameCount: 0,
      startTime: Date.now()
    };

    this.activeStreams.set(jobId, streamInfo);
    this.frameBuffer.set(jobId, []);

    // Start continuous frame capture
    this._captureLoop(streamInfo);

    return true;
  }

  /**
   * Continuous frame capture loop
   */
  async _captureLoop(streamInfo) {
    while (streamInfo.isActive) {
      try {
        // Check if page is valid
        if (!streamInfo.page) {
          console.log(`[VIDEO-STREAM] Page is null for job ${streamInfo.jobId}, stopping stream`);
          break;
        }
        
        // Check if page is closed
        let isClosed = false;
        try {
          isClosed = streamInfo.page.isClosed();
        } catch (e) {
          // If we can't check, assume it's closed
          isClosed = true;
        }
        
        if (isClosed) {
          console.log(`[VIDEO-STREAM] Page closed for job ${streamInfo.jobId}, stopping stream`);
          break;
        }

        // Capture frame
        const screenshot = await streamInfo.page.screenshot({
          type: 'jpeg',
          quality: 70, // Balance between quality and size
          fullPage: false // Just viewport for performance
        });
        
        // Log first few frames to verify capture is working
        if (streamInfo.frameCount < 3) {
          console.log(`[VIDEO-STREAM] Captured frame ${streamInfo.frameCount + 1} for job ${streamInfo.jobId} (${screenshot.length} bytes)`);
        }

        // Get URL safely
        let currentUrl = 'unknown';
        try {
          currentUrl = await streamInfo.page.url();
        } catch (e) {
          // Ignore
        }

        const frameData = {
          jobId: streamInfo.jobId,
          frameNumber: streamInfo.frameCount++,
          timestamp: Date.now(),
          data: screenshot.toString('base64'),
          url: currentUrl
        };

        // Add to circular buffer
        const buffer = this.frameBuffer.get(streamInfo.jobId);
        if (buffer) {
          buffer.push(frameData);
          // Keep only last N frames
          if (buffer.length > this.bufferSize) {
            buffer.shift();
          }
        }

        // Send frame to backend
        await this._sendFrame(frameData);

        // Wait for next frame
        await new Promise(resolve => setTimeout(resolve, streamInfo.interval));
      } catch (error) {
        if (error.message && error.message.includes('Target page, context or browser has been closed')) {
          console.log(`[VIDEO-STREAM] Browser closed for job ${streamInfo.jobId}, stopping stream`);
          break;
        }
        // Don't log every error, just continue
        if (streamInfo.frameCount % 10 === 0) {
          console.error(`[VIDEO-STREAM] Frame capture error (frame ${streamInfo.frameCount}):`, error.message);
        }
        await new Promise(resolve => setTimeout(resolve, streamInfo.interval));
      }
    }

    // Cleanup
    this.activeStreams.delete(streamInfo.jobId);
    console.log(`[VIDEO-STREAM] Stream ended for job ${streamInfo.jobId}, captured ${streamInfo.frameCount} frames`);
  }

  /**
   * Send frame to backend
   */
  async _sendFrame(frameData) {
    try {
      await axios.post(`${this.backendUrl}/api/runners/${this.runnerId}/stream-frame`, {
        jobId: frameData.jobId,
        frame: frameData.data,
        frameNumber: frameData.frameNumber,
        timestamp: new Date(frameData.timestamp).toISOString(),
        url: frameData.url
      }, {
        timeout: 3000,
        maxBodyLength: Infinity
      });
    } catch (error) {
      // Silently fail - don't interrupt streaming
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ETIMEDOUT') {
        // Only log unexpected errors occasionally
        if (frameData.frameNumber % 50 === 0) {
          console.error(`[VIDEO-STREAM] Failed to send frame ${frameData.frameNumber}:`, error.message);
        }
      }
    }
  }

  /**
   * Stop streaming for a job
   */
  stopStream(jobId) {
    const streamInfo = this.activeStreams.get(jobId);
    if (streamInfo) {
      streamInfo.isActive = false;
      console.log(`[VIDEO-STREAM] Stopping stream for job ${jobId}`);
    }
  }

  /**
   * Get buffered frames for rewind
   * @param {string} jobId - Job ID
   * @param {number} count - Number of frames to retrieve (from end)
   * @returns {Array} Array of frame data
   */
  getBufferedFrames(jobId, count = 30) {
    const buffer = this.frameBuffer.get(jobId);
    if (!buffer || buffer.length === 0) {
      return [];
    }

    // Return last N frames
    const startIndex = Math.max(0, buffer.length - count);
    return buffer.slice(startIndex);
  }

  /**
   * Get all buffered frames for a job
   */
  getAllBufferedFrames(jobId) {
    return this.frameBuffer.get(jobId) || [];
  }

  /**
   * Stop all active streams
   */
  stopAllStreams() {
    console.log(`[VIDEO-STREAM] Stopping all active streams (${this.activeStreams.size})`);
    for (const [jobId, streamInfo] of this.activeStreams.entries()) {
      streamInfo.isActive = false;
    }
    this.activeStreams.clear();
    this.frameBuffer.clear();
  }
}

export default VideoStreamManager;

