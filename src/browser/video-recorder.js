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
import ActivityDetector from './activity-detector.js';

const execFileAsync = promisify(execFile);

class VideoRecorder {
  constructor(backendUrl, runnerId, runnerToken = null) {
    this.backendUrl = backendUrl;
    this.runnerId = runnerId;
    this.runnerToken = runnerToken || process.env.RUNNER_TOKEN || null;
    this.activeRecordings = new Map(); // jobId -> recording info
  }

  /**
   * Start recording for a job
   * Playwright's context.recordVideo will handle the actual recording
   * @param {string} jobId - Job ID
   * @param {BrowserContext} context - Playwright browser context
   * @param {Page} page - Playwright page object
   */
  async startRecording(jobId, context, page) {
    console.log(`🎬 [VIDEO-RECORDER] Starting video recording for job ${jobId}`);

    const startTime = Date.now();
    
    // Start activity detection
    const activityDetector = new ActivityDetector(page, startTime);
    await activityDetector.start();

    const recordingInfo = {
      jobId,
      context,
      page,
      startTime,
      startedAt: new Date(),
      videoPath: null, // Will be set when video is saved
      segments: [],
      activityDetector
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

      // Stop activity detection
      if (recording.activityDetector) {
        await recording.activityDetector.stop();
      }

      // Gather metadata
      const stats = await fs.promises.stat(videoPath);
      const originalFileSize = stats.size;
      const originalDuration = Math.floor((Date.now() - recording.startTime) / 1000);

      console.log(`[VIDEO-RECORDER] Original video size: ${(originalFileSize / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`[VIDEO-RECORDER] Original video duration: ${originalDuration} seconds`);

      // Compress inactive periods if activity detector is available
      let finalVideoPath = videoPath;
      let finalFileSize = originalFileSize;
      let finalDuration = originalDuration;
      let inactiveMarkers = [];
      
      if (recording.activityDetector) {
        try {
          const compressionResult = await this.compressInactivePeriods(
            jobId,
            videoPath,
            recording.activityDetector,
            recording.startTime
          );
          finalVideoPath = compressionResult.path;
          finalFileSize = compressionResult.size;
          finalDuration = compressionResult.duration;
          inactiveMarkers = compressionResult.inactiveMarkers;
          
          // Delete original if we created a compressed version
          if (compressionResult.path !== videoPath) {
            try {
              await fs.promises.unlink(videoPath);
              console.log(`[VIDEO-RECORDER] Deleted original uncompressed video`);
            } catch (cleanupError) {
              console.warn(`[VIDEO-RECORDER] Failed to cleanup original video:`, cleanupError.message);
            }
          }
          
          console.log(`[VIDEO-RECORDER] Compressed video size: ${(finalFileSize / (1024 * 1024)).toFixed(2)} MB`);
          console.log(`[VIDEO-RECORDER] Compressed video duration: ${finalDuration} seconds`);
          console.log(`[VIDEO-RECORDER] Compression ratio: ${(originalDuration / finalDuration).toFixed(2)}x`);
        } catch (compressionError) {
          console.error(`[VIDEO-RECORDER] Failed to compress video, using original:`, compressionError.message);
          // Continue with original video
        }
      }

      // Upload to MinIO via backend
      const startedAt = recording.startedAt instanceof Date
        ? recording.startedAt
        : new Date(recording.startedAt || recording.startTime);
      const uploadResult = await this.uploadVideo(jobId, finalVideoPath, finalFileSize, finalDuration, startedAt, inactiveMarkers);

      // Process per-segment recordings if any
      try {
        await this.processSegments(jobId, recording, finalVideoPath, finalDuration);
      } catch (segmentError) {
        console.warn(`[VIDEO-RECORDER] Failed to process video segments for job ${jobId}:`, segmentError.message);
      }

      // Clean up local file
      try {
        await fs.promises.unlink(finalVideoPath);
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
        duration: finalDuration,
        sizeBytes: finalFileSize,
        sizeMB: (finalFileSize / (1024 * 1024)).toFixed(2),
        startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
        inactiveMarkers: inactiveMarkers
      };
    } catch (error) {
      console.error(`[VIDEO-RECORDER] Error stopping recording for job ${jobId}:`, error.message);
      this.activeRecordings.delete(jobId);
      return null;
    }
  }

  /**
   * Compress inactive periods in video using ffmpeg
   */
  async compressInactivePeriods(jobId, videoPath, activityDetector, recordingStartTime) {
    const compressedPath = videoPath.replace('.webm', '_compressed.webm');
    const timeline = activityDetector.getCompressedTimeline();
    const inactiveMarkers = activityDetector.getInactiveMarkers();
    
    if (timeline.timeline.length === 0 || timeline.compressionRatio <= 1.1) {
      // No meaningful compression possible
      console.log(`[VIDEO-RECORDER] No compression needed (ratio: ${timeline.compressionRatio.toFixed(2)})`);
      return {
        path: videoPath,
        size: (await fs.promises.stat(videoPath)).size,
        duration: timeline.originalDuration / 1000,
        inactiveMarkers: []
      };
    }
    
    console.log(`[VIDEO-RECORDER] Compressing video: ${timeline.timeline.length} segments, compression ratio: ${timeline.compressionRatio.toFixed(2)}x`);
    
    // Build ffmpeg filter complex to concatenate segments with time compression
    const filterParts = [];
    const inputs = [];
    let inputIndex = 0;
    
    // Create segments file for concat
    const segmentsFile = videoPath.replace('.webm', '_segments.txt');
    const segmentsContent = [];
    
    for (const segment of timeline.timeline) {
      const originalStart = (segment.originalStart - recordingStartTime) / 1000;
      const originalDuration = segment.duration / 1000;
      const displayDuration = (segment.displayEnd - segment.displayStart) / 1000;
      
      if (segment.type === 'active') {
        // Active segments: use normally with speed=1.0
        segmentsContent.push(`file '${videoPath}'\ninpoint ${originalStart.toFixed(3)}\noutpoint ${(originalStart + originalDuration).toFixed(3)}\n`);
      } else {
        // Inactive segments: speed up if compressed
        if (segment.compressed && originalDuration > displayDuration) {
          const speed = originalDuration / displayDuration;
          // Use setpts filter to speed up
          const tempSegment = videoPath.replace('.webm', `_segment_${inputIndex}.webm`);
          
          await execFileAsync('ffmpeg', [
            '-y',
            '-i', videoPath,
            '-ss', originalStart.toFixed(3),
            '-t', originalDuration.toFixed(3),
            '-filter:v', `setpts=PTS/${speed.toFixed(3)}`,
            '-an', // Remove audio for speed changes
            tempSegment
          ]);
          
          segmentsContent.push(`file '${tempSegment}'\n`);
          inputs.push(tempSegment);
        } else {
          // Show in full if not compressed
          segmentsContent.push(`file '${videoPath}'\ninpoint ${originalStart.toFixed(3)}\noutpoint ${(originalStart + originalDuration).toFixed(3)}\n`);
        }
      }
    }
    
    // Write segments file
    await fs.promises.writeFile(segmentsFile, segmentsContent.join(''));
    
    // Concatenate segments (re-encode to ensure compatibility when segments are modified)
    // Use VP8 to match Playwright's default codec
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', segmentsFile,
      '-c:v', 'libvpx',
      '-quality', 'good',
      '-speed', '0',
      '-b:v', '1M',
      '-maxrate', '1M',
      '-bufsize', '2M',
      compressedPath
    ], {
      timeout: 600000 // 10 minutes for large videos
    });
    
    // Clean up temporary files
    try {
      await fs.promises.unlink(segmentsFile);
      for (const tempFile of inputs) {
        await fs.promises.unlink(tempFile).catch(() => {});
      }
    } catch (cleanupError) {
      console.warn(`[VIDEO-RECORDER] Failed to cleanup temp files:`, cleanupError.message);
    }
    
    const stats = await fs.promises.stat(compressedPath);
    
    return {
      path: compressedPath,
      size: stats.size,
      duration: timeline.displayDuration / 1000,
      inactiveMarkers
    };
  }

  /**
   * Upload video to MinIO via backend presigned URL
   */
  async uploadVideo(jobId, videoPath, fileSize, duration, startedAt, inactiveMarkers = []) {
    try {
      // Request presigned URL from backend
      const headers = {};
      if (this.runnerToken) {
        headers['Authorization'] = `Bearer ${this.runnerToken}`;
      }
      const response = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
        type: 'video',
        jobId: jobId,
        contentType: 'video/webm'
      }, {
        headers,
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
      // Use runner token for authentication
      // Reuse headers object from above
      if (this.runnerToken) {
        headers['Authorization'] = `Bearer ${this.runnerToken}`;
      }
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video`, {
        video_key: key,
        video_url: backendVideoUrl, // Use backend proxy URL for external access
        duration,
        size_bytes: fileSize,
        format: 'webm',
        codec: 'vp8',
        resolution: '1920x1080',
        fps: 5, // Approximate FPS from streaming
        started_at: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
        inactive_markers: inactiveMarkers // Timeline markers for inactive periods
      }, {
        headers,
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
          journey_id: segment.metadata?.journey_id || null,
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
      const headers = {};
      if (this.runnerToken) {
        headers['Authorization'] = `Bearer ${this.runnerToken}`;
      }
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video-segment`, segmentPayload, {
        headers,
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


