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

  registerPageVideoHandle(videoHandleSet, targetPage, jobId) {
    if (!videoHandleSet || !targetPage || typeof targetPage.video !== 'function') {
      return;
    }
    try {
      const handle = targetPage.video();
      if (handle) {
        videoHandleSet.add(handle);
      }
    } catch (error) {
      console.warn(`[VIDEO-RECORDER] Unable to register page video handle for job ${jobId}:`, error.message);
    }
  }

  async getVideoDurationSeconds(videoPath) {
    if (!videoPath) return null;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ], { timeout: 30000 });
      const parsed = Number(String(stdout || '').trim());
      return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
      console.warn(`[VIDEO-RECORDER] Failed to probe video duration for ${videoPath}:`, error.message);
      return null;
    }
  }

  async collectVideoCandidates(jobId, videoHandles = new Set()) {
    const candidates = [];
    for (const handle of Array.from(videoHandles)) {
      if (!handle || typeof handle.path !== 'function') {
        continue;
      }
      try {
        const candidatePath = await handle.path();
        if (!candidatePath) {
          continue;
        }
        const stats = await fs.promises.stat(candidatePath);
        if (!stats || stats.size <= 0) {
          continue;
        }
        const durationSeconds = await this.getVideoDurationSeconds(candidatePath);
        candidates.push({
          path: candidatePath,
          size: stats.size,
          durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0
        });
      } catch (error) {
        console.warn(`[VIDEO-RECORDER] Failed to collect video candidate for job ${jobId}:`, error.message);
      }
    }
    return candidates;
  }

  selectBestVideoCandidate(candidates = []) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }
    const sorted = [...candidates].sort((a, b) => {
      const aDuration = Number.isFinite(a.durationSeconds) ? a.durationSeconds : 0;
      const bDuration = Number.isFinite(b.durationSeconds) ? b.durationSeconds : 0;
      if (Math.abs(bDuration - aDuration) > 0.05) {
        return bDuration - aDuration;
      }
      return (b.size || 0) - (a.size || 0);
    });
    return sorted[0] || null;
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

    const pageVideoHandles = new Set();
    const onContextPage = (newPage) => {
      this.registerPageVideoHandle(pageVideoHandles, newPage, jobId);
    };

    this.registerPageVideoHandle(pageVideoHandles, page, jobId);
    if (context && typeof context.pages === 'function') {
      for (const existingPage of context.pages()) {
        this.registerPageVideoHandle(pageVideoHandles, existingPage, jobId);
      }
    }
    if (context && typeof context.on === 'function') {
      context.on('page', onContextPage);
    }
    
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
      activityDetector,
      pageVideoHandles,
      onContextPage
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

      if (recording.pageVideoHandles) {
        this.registerPageVideoHandle(recording.pageVideoHandles, page, jobId);
        if (context && typeof context.pages === 'function') {
          for (const currentPage of context.pages()) {
            this.registerPageVideoHandle(recording.pageVideoHandles, currentPage, jobId);
          }
        }
      }

      if (context && recording.onContextPage && typeof context.off === 'function') {
        try {
          context.off('page', recording.onContextPage);
        } catch (_) {
          // Ignore listener cleanup errors.
        }
      }

      // Ensure the context is closed so Playwright finalises the video file
      if (context && typeof context.close === 'function') {
        try {
          await context.close();
        } catch (contextError) {
          console.warn(`[VIDEO-RECORDER] Failed to close context cleanly for job ${jobId}: ${contextError.message}`);
        }
      }

      const videoCandidates = await this.collectVideoCandidates(jobId, recording.pageVideoHandles || new Set());
      const selectedVideo = this.selectBestVideoCandidate(videoCandidates);
      if (!selectedVideo) {
        console.error(`[VIDEO-RECORDER] No finalized Playwright video file found for job ${jobId}`);
        this.activeRecordings.delete(jobId);
        return null;
      }

      const videoPath = selectedVideo.path;
      const staleVideoPaths = videoCandidates
        .map(candidate => candidate.path)
        .filter(candidatePath => candidatePath && candidatePath !== videoPath);
      console.log(`[VIDEO-RECORDER] Selected video for upload: ${videoPath}`);
      if (videoCandidates.length > 1) {
        const candidatesSummary = videoCandidates
          .map(candidate => `${path.basename(candidate.path)}:${candidate.durationSeconds.toFixed(3)}s`)
          .join(', ');
        console.log(`[VIDEO-RECORDER] Video candidates (${videoCandidates.length}): ${candidatesSummary}`);
      }

      // Stop activity detection
      if (recording.activityDetector) {
        await recording.activityDetector.stop();
      }

      // Gather metadata
      const stats = await fs.promises.stat(videoPath);
      const originalFileSize = stats.size;
      const probedOriginalDuration = await this.getVideoDurationSeconds(videoPath);
      const originalDuration = Number.isFinite(probedOriginalDuration) && probedOriginalDuration > 0
        ? probedOriginalDuration
        : Math.max(0.1, (Date.now() - recording.startTime) / 1000);
      const fallbackInactiveMarkers = recording.activityDetector
        ? recording.activityDetector.getInactiveMarkers({ useCompressedTimeline: false })
        : [];

      console.log(`[VIDEO-RECORDER] Original video size: ${(originalFileSize / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`[VIDEO-RECORDER] Original video duration: ${originalDuration.toFixed(3)} seconds`);

      // Compress inactive periods if activity detector is available
      let finalVideoPath = videoPath;
      let finalFileSize = originalFileSize;
      let finalDuration = originalDuration;
      let inactiveMarkers = fallbackInactiveMarkers;
      
      if (recording.activityDetector) {
        try {
          const compressionResult = await this.compressInactivePeriods(
            jobId,
            videoPath,
            recording.activityDetector,
            recording.startTime,
            originalDuration
          );

          if (compressionResult.path !== videoPath) {
            const measuredCompressedDuration = await this.getVideoDurationSeconds(compressionResult.path);
            const effectiveCompressedDuration = Number.isFinite(measuredCompressedDuration) && measuredCompressedDuration > 0
              ? measuredCompressedDuration
              : compressionResult.duration;
            const expectedCompressedDuration = Number(compressionResult.duration);
            const suspiciousCompression =
              !Number.isFinite(effectiveCompressedDuration) ||
              effectiveCompressedDuration <= 0.75 ||
              (Number.isFinite(expectedCompressedDuration) && expectedCompressedDuration > 0 && effectiveCompressedDuration < (expectedCompressedDuration * 0.5));

            if (suspiciousCompression) {
              console.warn(
                `[VIDEO-RECORDER] Compression output looks invalid (expected=${Number.isFinite(expectedCompressedDuration) ? expectedCompressedDuration.toFixed(3) : 'n/a'}s, actual=${Number.isFinite(effectiveCompressedDuration) ? effectiveCompressedDuration.toFixed(3) : 'n/a'}s). Using original video.`
              );
              try {
                await fs.promises.unlink(compressionResult.path);
              } catch (_) {
                // Ignore cleanup errors for rejected compressed output.
              }
              finalVideoPath = videoPath;
              finalFileSize = originalFileSize;
              finalDuration = originalDuration;
              inactiveMarkers = fallbackInactiveMarkers;
            } else {
              finalVideoPath = compressionResult.path;
              finalFileSize = compressionResult.size;
              finalDuration = effectiveCompressedDuration;
              inactiveMarkers = Array.isArray(compressionResult.inactiveMarkers) && compressionResult.inactiveMarkers.length > 0
                ? compressionResult.inactiveMarkers
                : fallbackInactiveMarkers;
            }
          } else {
            finalVideoPath = videoPath;
            finalFileSize = compressionResult.size || originalFileSize;
            finalDuration = Number.isFinite(compressionResult.duration) && compressionResult.duration > 0
              ? compressionResult.duration
              : originalDuration;
            inactiveMarkers = Array.isArray(compressionResult.inactiveMarkers) && compressionResult.inactiveMarkers.length > 0
              ? compressionResult.inactiveMarkers
              : fallbackInactiveMarkers;
          }

          // Delete original if we accepted a compressed version
          if (finalVideoPath !== videoPath) {
            try {
              await fs.promises.unlink(videoPath);
              console.log(`[VIDEO-RECORDER] Deleted original uncompressed video`);
            } catch (cleanupError) {
              console.warn(`[VIDEO-RECORDER] Failed to cleanup original video:`, cleanupError.message);
            }
          }
          
          console.log(`[VIDEO-RECORDER] Compressed video size: ${(finalFileSize / (1024 * 1024)).toFixed(2)} MB`);
          console.log(`[VIDEO-RECORDER] Compressed video duration: ${Number(finalDuration).toFixed(3)} seconds`);
          if (finalDuration > 0) {
            console.log(`[VIDEO-RECORDER] Compression ratio: ${(originalDuration / finalDuration).toFixed(2)}x`);
          }
        } catch (compressionError) {
          console.error(`[VIDEO-RECORDER] Failed to compress video, using original:`, compressionError.message);
          finalVideoPath = videoPath;
          finalFileSize = originalFileSize;
          finalDuration = originalDuration;
          inactiveMarkers = fallbackInactiveMarkers;
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
      for (const stalePath of staleVideoPaths) {
        if (!stalePath || stalePath === finalVideoPath) continue;
        try {
          await fs.promises.unlink(stalePath);
        } catch (_) {
          // Ignore cleanup failures for non-selected page videos.
        }
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
  async compressInactivePeriods(jobId, videoPath, activityDetector, recordingStartTime, sourceDurationSeconds = null) {
    const compressedPath = videoPath.replace('.webm', '_compressed.webm');
    const timeline = activityDetector.getCompressedTimeline();
    const inactiveMarkers = activityDetector.getInactiveMarkers();
    const sourceDuration = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0
      ? sourceDurationSeconds
      : await this.getVideoDurationSeconds(videoPath);
    
    if (timeline.timeline.length === 0 || timeline.compressionRatio <= 1.1) {
      // No meaningful compression possible
      console.log(`[VIDEO-RECORDER] No compression needed (ratio: ${timeline.compressionRatio.toFixed(2)})`);
      return {
        path: videoPath,
        size: (await fs.promises.stat(videoPath)).size,
        duration: Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : (timeline.originalDuration / 1000),
        inactiveMarkers
      };
    }
    
    console.log(`[VIDEO-RECORDER] Compressing video: ${timeline.timeline.length} segments, compression ratio: ${timeline.compressionRatio.toFixed(2)}x`);
    
    const inputs = [];
    let inputIndex = 0;
    
    // Create segments file for concat
    const segmentsFile = videoPath.replace('.webm', '_segments.txt');
    const segmentsContent = [];
    
    for (const segment of timeline.timeline) {
      let originalStart = (segment.originalStart - recordingStartTime) / 1000;
      let originalDuration = segment.duration / 1000;
      let displayDuration = (segment.displayEnd - segment.displayStart) / 1000;

      if (!Number.isFinite(originalStart) || !Number.isFinite(originalDuration) || originalDuration <= 0) {
        console.warn(`[VIDEO-RECORDER] Skipping segment with invalid times (originalStart=${originalStart}, originalDuration=${originalDuration})`);
        continue;
      }

      if (Number.isFinite(sourceDuration) && sourceDuration > 0) {
        if (originalStart >= sourceDuration) {
          continue;
        }
        originalStart = Math.max(0, originalStart);
        const maxDuration = Math.max(0, sourceDuration - originalStart);
        if (maxDuration <= 0.04) {
          continue;
        }
        originalDuration = Math.min(originalDuration, maxDuration);
        if (displayDuration > originalDuration) {
          displayDuration = originalDuration;
        }
      }

      if (!Number.isFinite(displayDuration) || displayDuration <= 0 || !Number.isFinite(originalDuration) || originalDuration <= 0) {
        continue;
      }

      const tempSegment = videoPath.replace('.webm', `_segment_${inputIndex}.webm`);
      inputIndex += 1;
      const ffmpegArgs = [
        '-y',
        '-ss', originalStart.toFixed(3),
        '-t', originalDuration.toFixed(3),
        '-i', videoPath
      ];

      if (segment.type === 'inactive' && segment.compressed && originalDuration > displayDuration) {
        const speed = originalDuration / displayDuration;
        ffmpegArgs.push('-filter:v', `setpts=PTS/${speed.toFixed(3)}`);
      }

      ffmpegArgs.push(
        '-an',
        '-c:v', 'libvpx',
        '-quality', 'good',
        '-speed', '0',
        '-b:v', '1M',
        '-maxrate', '1M',
        '-bufsize', '2M',
        tempSegment
      );

      await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 600000 });
      segmentsContent.push(`file '${tempSegment}'\n`);
      inputs.push(tempSegment);
    }
    if (segmentsContent.length === 0) {
      console.warn('[VIDEO-RECORDER] No valid segments after filtering (invalid/NaN times), using original video');
      return {
        path: videoPath,
        size: (await fs.promises.stat(videoPath)).size,
        duration: Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : (timeline.originalDuration / 1000),
        inactiveMarkers
      };
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
    const compressedDuration = await this.getVideoDurationSeconds(compressedPath);
    
    return {
      path: compressedPath,
      size: stats.size,
      duration: Number.isFinite(compressedDuration) && compressedDuration > 0 ? compressedDuration : (timeline.displayDuration / 1000),
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

      // Construct backend proxy URL for video access.
      // Never persist internal helper URLs like http://back:4000 or localhost in cloud jobs.
      const publicBackendUrl = this.resolvePublicBackendUrl();
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

  resolvePublicBackendUrl() {
    const normalizeBase = (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.replace(/\/+$/, '');
    };

    const envCandidates = [
      process.env.BACKEND_PUBLIC_URL,
      process.env.PUBLIC_BACKEND_URL,
      process.env.API_PUBLIC_URL,
      process.env.API_URL,
      this.backendUrl
    ].map(normalizeBase).filter(Boolean);

    const isInternalHost = (hostnameRaw) => {
      const hostname = String(hostnameRaw || '').trim().toLowerCase();
      if (!hostname) return true;
      if (hostname === 'back' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return true;
      }
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
        const parts = hostname.split('.').map(Number);
        if (parts[0] === 10) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      }
      return false;
    };

    for (const candidate of envCandidates) {
      try {
        const parsed = new URL(candidate);
        if (!isInternalHost(parsed.hostname)) {
          return `${parsed.protocol}//${parsed.host}`;
        }
      } catch (_error) {
        // Ignore invalid candidates.
      }
    }

    const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
    if (nodeEnv === 'production') {
      return 'https://api.aionqa.com';
    }
    return 'http://localhost:4000';
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


