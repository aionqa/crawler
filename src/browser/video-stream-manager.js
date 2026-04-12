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
  constructor(backendUrl, runnerId, runnerToken = null) {
    this.backendUrl = backendUrl;
    this.runnerId = runnerId;
    this.runnerToken = runnerToken ?? process.env.RUNNER_TOKEN ?? null;
    this.activeStreams = new Map(); // jobId -> stream info
    this.frameBuffer = new Map(); // jobId -> circular buffer of frames
    this.bufferSize = 150; // Keep last 150 frames (30 seconds at 5fps)
    /** Presigned PUT slots from batch API (reduces /api/upload/presigned-url traffic). */
    this.presignedPools = new Map(); // jobId -> Array<{ url, key, publicUrl }>
    /** Pending metadata rows for POST .../stream-frame-batch */
    this.pendingNotify = new Map(); // jobId -> Array<object>
    this.notifyFlushTimers = new Map(); // jobId -> Timeout
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

    // Default to a safer interval than 200ms (5 FPS). Base64 JPEG frames are large and can
    // cause backend OOM via JSON parsing + Socket.IO buffering under load.
    const envIntervalMs = Number.parseInt(process.env.VIDEO_STREAM_INTERVAL_MS || '', 10);
    const defaultIntervalMs = Number.isFinite(envIntervalMs) && envIntervalMs > 0 ? envIntervalMs : 1000;
    const chosenIntervalMs = Number.isFinite(Number(options.interval)) && Number(options.interval) > 0
      ? Number(options.interval)
      : defaultIntervalMs;

    const envQuality = Number.parseInt(process.env.VIDEO_STREAM_JPEG_QUALITY || '', 10);
    const defaultQuality = Number.isFinite(envQuality) && envQuality >= 10 && envQuality <= 100 ? envQuality : 70;
    const chosenQuality = Number.isFinite(Number(options.quality)) && Number(options.quality) >= 10 && Number(options.quality) <= 100
      ? Number(options.quality)
      : defaultQuality;

    const streamInfo = {
      jobId,
      page,
      interval: chosenIntervalMs,
      quality: chosenQuality,
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
          quality: streamInfo.quality, // Balance between quality and size
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

  async _takePresignedFrameSlot(jobId) {
    const jid = String(jobId || '');
    let pool = this.presignedPools.get(jid) || [];
    const refillAt = Math.max(0, Number.parseInt(process.env.VIDEO_STREAM_PRESIGNED_REFILL_AT || '4', 10) || 4);
    const batchSize = Math.max(4, Math.min(48, Number.parseInt(process.env.VIDEO_STREAM_PRESIGNED_BATCH || '16', 10) || 16));
    if (pool.length <= refillAt) {
      try {
        const res = await axios.post(
          `${this.backendUrl}/api/upload/presigned-url-batch`,
          { type: 'frame', jobId: jid, count: batchSize },
          { timeout: 20000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
        );
        const items = Array.isArray(res.data?.items) ? res.data.items : [];
        pool = pool.concat(items);
      } catch (batchErr) {
        const presignedRes = await axios.post(
          `${this.backendUrl}/api/upload/presigned-url`,
          { type: 'frame', jobId: jid },
          { timeout: 5000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
        );
        pool = pool.concat([presignedRes.data]);
      }
    }
    const slot = pool.shift();
    this.presignedPools.set(jid, pool);
    return slot;
  }

  /** Max metadata rows per stream-frame-batch POST (must stay ≤ backend STREAM_FRAME_BATCH_MAX). */
  _notifyBatchSize() {
    return Math.max(1, Math.min(32, Number.parseInt(process.env.VIDEO_STREAM_NOTIFY_BATCH || '8', 10) || 8));
  }

  _queueStreamNotify(jobId, row) {
    const jid = String(jobId);
    const list = this.pendingNotify.get(jid) || [];
    list.push(row);
    this.pendingNotify.set(jid, list);
    const maxBatch = this._notifyBatchSize();
    if (list.length >= maxBatch) {
      this._flushNotifyBatch(jid).catch(() => {});
      return;
    }
    if (this.notifyFlushTimers.get(jid)) {
      clearTimeout(this.notifyFlushTimers.get(jid));
    }
    const t = setTimeout(() => {
      this.notifyFlushTimers.delete(jid);
      this._flushNotifyBatch(jid).catch(() => {});
    }, Number.parseInt(process.env.VIDEO_STREAM_NOTIFY_DEBOUNCE_MS || '120', 10) || 120);
    this.notifyFlushTimers.set(jid, t);
  }

  async _flushNotifyBatch(jobId) {
    const jid = String(jobId);
    if (this.notifyFlushTimers.has(jid)) {
      clearTimeout(this.notifyFlushTimers.get(jid));
      this.notifyFlushTimers.delete(jid);
    }
    const list = this.pendingNotify.get(jid);
    if (!list || list.length === 0) return;
    const chunk = list.splice(0, this._notifyBatchSize());
    if (list.length === 0) {
      this.pendingNotify.delete(jid);
    }
    const items = chunk.map((row) => ({
      jobId: row.jobId,
      key: row.key,
      publicUrl: row.publicUrl,
      timestamp: row.timestamp,
      frameNumber: row.frameNumber,
      url: row.url,
    }));
    try {
      await axios.post(
        `${this.backendUrl}/api/runners/${this.runnerId}/stream-frame-batch`,
        { items },
        { timeout: 15000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
      );
    } catch (e) {
      for (const row of chunk) {
        try {
          await axios.post(
            `${this.backendUrl}/api/runners/${this.runnerId}/stream-frame`,
            {
              jobId: row.jobId,
              key: row.key,
              publicUrl: row.publicUrl,
              timestamp: row.timestamp,
              frameNumber: row.frameNumber,
              url: row.url,
            },
            { timeout: 5000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
          );
        } catch {
          /* best-effort */
        }
      }
    }
    if ((this.pendingNotify.get(jid) || []).length > 0) {
      await this._flushNotifyBatch(jid);
    }
  }

  /**
   * Send frame: PUT JPEG directly to object storage (presigned), notify backend in batches (metadata only).
   */
  async _sendFrame(frameData) {
    try {
      if (this.runnerToken) {
        const slot = await this._takePresignedFrameSlot(frameData.jobId);
        if (!slot?.url) return;
        const { url: presignedUrl, key, publicUrl } = slot;
        const imageBuffer = Buffer.from(frameData.data, 'base64');
        await axios.put(presignedUrl, imageBuffer, {
          headers: { 'Content-Type': 'image/jpeg' },
          maxBodyLength: Infinity,
          timeout: 10000
        });
        this._queueStreamNotify(frameData.jobId, {
          jobId: frameData.jobId,
          key,
          publicUrl,
          timestamp: new Date(frameData.timestamp).toISOString(),
          frameNumber: frameData.frameNumber,
          url: frameData.url
        });
      } else {
        if (!this._warnedNoRunnerToken) {
          this._warnedNoRunnerToken = true;
          console.warn(
            '[VIDEO-STREAM] RUNNER_TOKEN is required for streaming: frames must upload via presigned S3 PUT (no base64 through backend).'
          );
        }
      }
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

