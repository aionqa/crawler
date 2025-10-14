/**
 * Video Recorder
 * Records full browser session video using Playwright's built-in video recording
 * Handles upload to MinIO via backend after completion
 * Provides YouTube-like playback with scrubbing capability
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';

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
      videoPath: null // Will be set when video is saved
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
      // Close the page to finalize the video
      if (recording.page && !recording.page.isClosed()) {
        await recording.page.close();
      }

      // Get video path from Playwright
      const video = recording.page.video();
      if (!video) {
        console.error(`[VIDEO-RECORDER] No video object available for job ${jobId}`);
        return null;
      }

      // Wait for video to be saved
      const videoPath = await video.path();
      console.log(`[VIDEO-RECORDER] Video saved to: ${videoPath}`);

      // Get video file size
      const stats = fs.statSync(videoPath);
      const fileSizeInBytes = stats.size;
      const fileSizeInMB = (fileSizeInBytes / (1024 * 1024)).toFixed(2);
      
      console.log(`[VIDEO-RECORDER] Video size: ${fileSizeInMB} MB (${fileSizeInBytes} bytes)`);

      // Calculate duration
      const duration = Math.floor((Date.now() - recording.startTime) / 1000);
      console.log(`[VIDEO-RECORDER] Video duration: ${duration} seconds`);

      // Upload to MinIO via backend
      const uploadResult = await this.uploadVideo(jobId, videoPath, fileSizeInBytes, duration);

      // Clean up local file
      try {
        fs.unlinkSync(videoPath);
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
        sizeMB: fileSizeInMB
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
  async uploadVideo(jobId, videoPath, fileSize, duration) {
    try {
      // Request presigned URL from backend
      const response = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
        filename: `job-${jobId}-full-recording.webm`,
        contentType: 'video/webm',
        folder: `videos/${jobId}`
      }, {
        timeout: 10000
      });

      const { url: presignedUrl, key } = response.data;
      
      console.log(`[VIDEO-RECORDER] Got presigned URL for upload`);

      // Read video file
      const videoBuffer = fs.readFileSync(videoPath);
      
      console.log(`[VIDEO-RECORDER] Starting upload to MinIO (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`);

      // Upload to MinIO
      await axios.put(presignedUrl, videoBuffer, {
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': fileSize
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300000 // 5 minutes for large files
      });

      console.log(`✅ [VIDEO-RECORDER] Video uploaded successfully`);

      // Notify backend about the video
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video`, {
        video_key: key,
        video_url: presignedUrl.split('?')[0], // Remove query params
        duration,
        size_bytes: fileSize,
        format: 'webm',
        codec: 'vp8',
        resolution: '1920x1080',
        fps: 5 // Approximate FPS from streaming
      }, {
        timeout: 10000
      });

      console.log(`✅ [VIDEO-RECORDER] Video metadata saved to job`);

      return {
        url: presignedUrl.split('?')[0],
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

