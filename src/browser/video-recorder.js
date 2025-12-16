/**
 * Video Recorder
 * Records full browser session video using Playwright's built-in video recording
 * Handles upload to MinIO via backend after completion
 * Provides YouTube-like playback with scrubbing capability
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

class VideoRecorder {
  constructor(backendUrl, runnerId) {
    this.backendUrl = backendUrl;
    this.runnerId = runnerId;
    this.activeRecordings = new Map(); // jobId -> recording info
  }

  /**
   * Start recording for a job
   * Playwright's context.recordVideo will handle the actual recording
   * @param {string} jobId - Job ID
   * @param {BrowserContext} context - Playwright browser context
   * @param {Page} page - Playwright page object
   */
  startRecording(jobId, context, page) {
    console.log(`🎬 [VIDEO-RECORDER] Starting video recording for job ${jobId}`);

    const recordingInfo = {
      jobId,
      context,
      page,
      startTime: Date.now(),
      startedAt: new Date(),
      videoPath: null, // Will be set when video is saved
      segments: []
    };

    this.activeRecordings.set(jobId, recordingInfo);
    
    return true;
  }

  /**
   * Stop recording and upload to MinIO
   * @param {string} jobId - Job ID
   * @returns {Object} Video info with URL
   */
  async stopRecording(jobId) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording) {
      console.log(`[VIDEO-RECORDER] No active recording for job ${jobId}`);
      return null;
    }

    console.log(`⏹️  [VIDEO-RECORDER] Stopping recording for job ${jobId}`);

    try {
      const { context, page } = recording;

      // Retrieve video reference before context shutdown
      const video = page && typeof page.video === 'function' ? page.video() : null;
      if (!video) {
        console.error(`[VIDEO-RECORDER] No Playwright video handle available for job ${jobId}`);
        this.activeRecordings.delete(jobId);
        return null;
      }

      // Ensure the context is closed so Playwright finalises the video file
      if (context && typeof context.close === 'function') {
        try {
          await context.close();
        } catch (contextError) {
          console.warn(`[VIDEO-RECORDER] Failed to close context cleanly for job ${jobId}: ${contextError.message}`);
        }
      }

      const videoPath = await video.path();
      console.log(`[VIDEO-RECORDER] Video saved to: ${videoPath}`);

      // Gather metadata
      const stats = await fs.promises.stat(videoPath);
      const fileSizeInBytes = stats.size;
      const fileSizeInMB = (fileSizeInBytes / (1024 * 1024)).toFixed(2);
      const duration = Math.floor((Date.now() - recording.startTime) / 1000);

      console.log(`[VIDEO-RECORDER] Video size: ${fileSizeInMB} MB (${fileSizeInBytes} bytes)`);
      console.log(`[VIDEO-RECORDER] Video duration: ${duration} seconds`);

      // Upload to MinIO via backend
      const startedAt = recording.startedAt instanceof Date
        ? recording.startedAt
        : new Date(recording.startedAt || recording.startTime);
      const uploadResult = await this.uploadVideo(jobId, videoPath, fileSizeInBytes, duration, startedAt);

      // Process per-segment recordings if any
      try {
        await this.processSegments(jobId, recording, videoPath, duration);
      } catch (segmentError) {
        console.warn(`[VIDEO-RECORDER] Failed to process video segments for job ${jobId}:`, segmentError.message);
      }

      // Clean up local file
      try {
        await fs.promises.unlink(videoPath);
        console.log(`[VIDEO-RECORDER] Cleaned up local video file`);
      } catch (cleanupError) {
        console.warn(`[VIDEO-RECORDER] Failed to cleanup local file:`, cleanupError.message);
      }

      // Remove from active recordings
      this.activeRecordings.delete(jobId);

      return {
        success: true,
        videoUrl: uploadResult.url,
        videoKey: uploadResult.key,
        duration,
        sizeBytes: fileSizeInBytes,
        sizeMB: fileSizeInMB,
        startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt
      };
    } catch (error) {
      console.error(`[VIDEO-RECORDER] Error stopping recording for job ${jobId}:`, error.message);
      this.activeRecordings.delete(jobId);
      return null;
    }
  }

  /**
   * Upload video to MinIO via backend presigned URL
   */
  async uploadVideo(jobId, videoPath, fileSize, duration, startedAt) {
    try {
      // Request presigned URL from backend
      const response = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
        type: 'video',
        jobId: jobId,
        contentType: 'video/webm'
      }, {
        timeout: 10000
      });

      const { url: presignedUrl, key, publicUrl } = response.data;
      
      console.log(`[VIDEO-RECORDER] Got presigned URL for upload`);

      // Read video file as stream to avoid excessive memory usage
      const videoStream = fs.createReadStream(videoPath);
      
      console.log(`[VIDEO-RECORDER] Starting upload to MinIO (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`);

      // Upload to MinIO
      await axios.put(presignedUrl, videoStream, {
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': fileSize
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300000 // 5 minutes for large files
      });

      console.log(`✅ [VIDEO-RECORDER] Video uploaded successfully`);

      // Construct backend proxy URL for video access (use localhost for external access)
      const publicBackendUrl = this.backendUrl.replace('http://back:', 'http://localhost:');
      const backendVideoUrl = `${publicBackendUrl}/stream-video?key=${encodeURIComponent(key)}`;
      
      // Notify backend about the video with backend proxy URL
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video`, {
        video_key: key,
        video_url: backendVideoUrl, // Use backend proxy URL for external access
        duration,
        size_bytes: fileSize,
        format: 'webm',
        codec: 'vp8',
        resolution: '1920x1080',
        fps: 5, // Approximate FPS from streaming
        started_at: startedAt instanceof Date ? startedAt.toISOString() : startedAt
      }, {
        timeout: 10000
      });

      console.log(`✅ [VIDEO-RECORDER] Video metadata saved to job`);

      return {
        url: publicUrl || presignedUrl.split('?')[0],
        key,
        duration,
        size: fileSize
      };

    } catch (error) {
      console.error(`[VIDEO-RECORDER] Failed to upload video:`, error.message);
      throw error;
    }
  }

  /**
   * Start capturing a logical video segment
   */
  startSegment(jobId, segmentId, label, metadata = {}) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording) {
      return;
    }

    const id = segmentId || `segment-${Date.now()}`;
    recording.segments.push({
      id,
      label: label || id,
      metadata,
      startTimestamp: Date.now(),
      endTimestamp: null
    });
    console.log(`[VIDEO-RECORDER] 🎬 Segment started for job ${jobId}: ${label || id}`);
    return id;
  }

  /**
   * Stop capturing a video segment
   */
  endSegment(jobId, segmentId, extra = {}) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording || !recording.segments) {
      return;
    }
    const segment = recording.segments.find(seg => seg.id === segmentId);
    if (!segment) {
      return;
    }
    if (!segment.endTimestamp) {
      segment.endTimestamp = Date.now();
      segment.endMetadata = extra || {};
      console.log(`[VIDEO-RECORDER] ✅ Segment ended for job ${jobId}: ${segment.label} (${((segment.endTimestamp - segment.startTimestamp) / 1000).toFixed(2)}s)`);
    }
  }

  /**
   * Process collected segments: cut clips, upload, and register metadata with backend
   */
  async processSegments(jobId, recording, fullVideoPath, fullDurationSeconds) {
    if (!recording?.segments || recording.segments.length === 0) {
      return;
    }

    const segmentsToProcess = recording.segments.filter(segment => segment.endTimestamp && segment.endTimestamp > segment.startTimestamp);
    if (segmentsToProcess.length === 0) {
      return;
    }

    const workDir = path.dirname(fullVideoPath);

    for (const segment of segmentsToProcess) {
      try {
        const segmentStartOffset = Math.max(0, (segment.startTimestamp - recording.startTime) / 1000);
        const segmentEndOffset = Math.max(segmentStartOffset, (segment.endTimestamp - recording.startTime) / 1000);
        const paddedStart = Math.max(0, segmentStartOffset - 0.35);
        const paddedEnd = Math.min(fullDurationSeconds, segmentEndOffset + 0.65);
        const clipDuration = Math.max(0.5, paddedEnd - paddedStart);

        if (!isFinite(clipDuration) || clipDuration <= 0) {
          console.warn(`[VIDEO-RECORDER] ⚠️ Skipping segment "${segment.label}" due to invalid duration (${clipDuration})`);
          continue;
        }

        const sanitizedLabel = segment.label
          .toLowerCase()
          .replace(/[^a-z0-9\-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .substring(0, 40) || 'segment';

        const timestampSuffix = Date.now();
        const segmentFilename = `${jobId}-${sanitizedLabel}-${timestampSuffix}.webm`;
        const segmentPath = path.join(workDir, segmentFilename);

        // Cut segment using ffmpeg
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', fullVideoPath,
          '-ss', paddedStart.toFixed(3),
          '-t', clipDuration.toFixed(3),
          '-c', 'copy',
          segmentPath
        ]);

        const stats = await fs.promises.stat(segmentPath);
        const segmentSize = stats.size;

        const uploadInfo = await this.uploadSegment(jobId, segmentPath, segmentSize, clipDuration, {
          start_offset: segmentStartOffset,
          end_offset: segmentEndOffset,
          label: segment.label,
          metadata: segment.metadata
        });

        await this.registerSegment(jobId, {
          segment_id: segment.id,
          label: segment.label,
          type: segment.metadata?.type || 'workflow_leg',
          leg_id: segment.metadata?.leg_id || null,
          start_offset: segmentStartOffset,
          end_offset: segmentEndOffset,
          padded_start: paddedStart,
          padded_end: paddedEnd,
          duration: clipDuration,
          video_size_bytes: segmentSize,
          video_url: uploadInfo?.url,
          video_key: uploadInfo?.key,
          metadata: {
            ...segment.metadata,
            end_metadata: segment.endMetadata || {}
          }
        });

        // Clean up segment file
        try {
          await fs.promises.unlink(segmentPath);
        } catch (cleanupError) {
          console.warn(`[VIDEO-RECORDER] Failed to cleanup segment file ${segmentPath}:`, cleanupError.message);
        }
      } catch (segmentError) {
        console.error(`[VIDEO-RECORDER] Failed to process segment "${segment.label}" for job ${jobId}:`, segmentError.message);
      }
    }
  }

  /**
   * Upload a per-segment clip
   */
  async uploadSegment(jobId, segmentPath, fileSize, duration, context = {}) {
    try {
      const response = await axios.post(`${this.backendUrl}/api/files/prepare-video`, {
        type: 'video',
        jobId,
        segment: true,
        metadata: context?.metadata || {}
      }, {
        timeout: 10000
      });

      const { uploadUrl, key, publicUrl } = response.data;
      const videoStream = fs.createReadStream(segmentPath);

      await axios.put(uploadUrl, videoStream, {
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': fileSize
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300000
      });

      const baseUrl = uploadUrl.split('?')[0];
      const finalUrl = publicUrl || baseUrl;

      return {
        url: finalUrl,
        key,
        duration
      };
    } catch (error) {
      console.error(`[VIDEO-RECORDER] Failed to upload segment for job ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Register segment metadata with backend job record
   */
  async registerSegment(jobId, segmentPayload) {
    try {
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video-segment`, segmentPayload, {
        timeout: 10000
      });
    } catch (error) {
      console.error(`[VIDEO-RECORDER] Failed to register segment metadata for job ${jobId}:`, error.message);
    }
  }

  /**
   * Get recording info for a job
   */
  getRecording(jobId) {
    return this.activeRecordings.get(jobId);
  }

  /**
   * Stop all active recordings
   */
  async stopAllRecordings() {
    console.log(`[VIDEO-RECORDER] Stopping all active recordings (${this.activeRecordings.size})`);
    
    const jobs = Array.from(this.activeRecordings.keys());
    for (const jobId of jobs) {
      await this.stopRecording(jobId);
    }
  }
}

export default VideoRecorder;


