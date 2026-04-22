/**
 * Screencast Recorder (Playwright 1.59 page.screencast) — per-stage playlist mode.
 *
 * Each browser run produces a *playlist* of WebM clips (one per workflow leg /
 * journey stage). We do NOT record a single session-wide video, and we do NOT
 * stream live frames — both of those proved too heavy.
 *
 * Lifecycle:
 *   1. `attachJob(jobId, page, viewport)` — remembers the primary page for
 *      this job. Cheap; no recording yet.
 *   2. `startStage(jobId, stageId, label, metadata)` — opens a fresh
 *      `page.screencast.start({ path })` on the primary page, calls
 *      `screencast.showActions()` so user actions are highlighted, and shows a
 *      chapter overlay with the stage label.
 *   3. `endStage(jobId, stageId, extra)` — calls `screencast.stop()`, waits
 *      for the WebM to flush, uploads it as a `video_segments` entry on the
 *      job, and returns the segment metadata.
 *   4. `finalize(jobId)` — sends a final `POST /api/jobs/:id/video` carrying
 *      playlist metadata only (no `full_video_url` because the playlist IS
 *      the video).
 *
 * Idle time between stages — typically waiting for the LLM to decide what to
 * do next — is NOT recorded, so storage stays small and the UI playlist only
 * contains real interactions.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const VIDEO_TMP_DIR = process.env.SCREENCAST_TMP_DIR || '/tmp/aionqa_videos';
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const RECORDER_TAG = 'playwright-screencast-1.59-playlist';

function envInt(name, fallback) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function nowMs() {
  return Date.now();
}

function safeFilename(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'stage';
}

class ScreencastRecorder {
  constructor(backendUrl, runnerId, runnerToken = null) {
    this.backendUrl = backendUrl;
    this.runnerId = runnerId;
    this.runnerToken = runnerToken || process.env.RUNNER_TOKEN || null;
    /** jobId -> { page, context, viewport, jobStartTime, segments[], chapters[], actions[], activeStage } */
    this.jobs = new Map();

    try {
      if (!fs.existsSync(VIDEO_TMP_DIR)) {
        fs.mkdirSync(VIDEO_TMP_DIR, { recursive: true });
      }
    } catch (err) {
      console.warn(`[SCREENCAST] Could not create tmp dir ${VIDEO_TMP_DIR}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Job lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Bind a job to its primary page. No recording happens here — recording only
   * starts when `startStage(...)` is called. Safe to call multiple times.
   */
  attachJob(jobId, context, page, options = {}) {
    if (!jobId || !page) return false;
    const viewport = (options.viewport && options.viewport.width && options.viewport.height)
      ? { width: options.viewport.width, height: options.viewport.height }
      : DEFAULT_VIEWPORT;
    const existing = this.jobs.get(jobId);
    if (existing) {
      existing.context = context || existing.context;
      existing.page = page;
      existing.viewport = viewport;
      return true;
    }
    this.jobs.set(jobId, {
      jobId,
      context,
      page,
      viewport,
      jobStartTime: nowMs(),
      segments: [], // [{ segment_id, label, metadata, start_offset, end_offset, duration, video_url, video_key, size_bytes, frame_count }]
      chapters: [], // [{ time_offset, title, description, kind, stage_id }]
      actions: [],  // [{ time_offset, title, kind, stage_id }]
      activeStage: null
    });
    return true;
  }

  /**
   * Tell the recorder a new primary page is in use (e.g. after a redirect that
   * spawned a different page object). Updates the binding without restarting
   * any active recording.
   */
  setPrimaryPage(jobId, page) {
    const job = this.jobs.get(jobId);
    if (!job || !page) return;
    job.page = page;
  }

  /**
   * Returns true if a stage is currently being recorded for this job.
   */
  isStageActive(jobId) {
    const job = this.jobs.get(jobId);
    return Boolean(job && job.activeStage && !job.activeStage.stopped);
  }

  // ---------------------------------------------------------------------------
  // Stage lifecycle (one stage = one WebM clip in the playlist)
  // ---------------------------------------------------------------------------

  /**
   * Start a new stage recording. The stage runs on the job's currently-bound
   * primary page. Call `endStage(...)` when the stage finishes (success or
   * failure). It is safe to call this even if no `attachJob` happened first
   * — in that case it returns null without recording.
   */
  async startStage(jobId, stageId, label, metadata = {}) {
    const job = this.jobs.get(jobId);
    if (!job) {
      console.warn(`[SCREENCAST] startStage("${label}") for job ${jobId}: no attached page yet, skipping recording.`);
      return null;
    }
    if (job.activeStage && !job.activeStage.stopped) {
      console.warn(`[SCREENCAST] startStage("${label}") for job ${jobId}: another stage "${job.activeStage.label}" is already active, ending it first.`);
      try { await this.endStage(jobId, job.activeStage.id, { reason: 'preempted' }); } catch (_) { /* ignore */ }
    }
    if (!this._isPageUsable(job.page)) {
      console.warn(`[SCREENCAST] startStage("${label}") for job ${jobId}: primary page is not usable, skipping.`);
      return null;
    }
    if (!job.page.screencast || typeof job.page.screencast.start !== 'function') {
      console.warn(`[SCREENCAST] startStage("${label}") for job ${jobId}: page.screencast.start is unavailable. Make sure Playwright >= 1.59 is installed.`);
      return null;
    }

    const id = stageId || `stage-${nowMs()}`;
    const stageStart = nowMs();
    const filename = `${jobId}-${safeFilename(label || id)}-${stageStart}.webm`;
    const filePath = path.join(VIDEO_TMP_DIR, filename);

    const stage = {
      id,
      label: String(label || id).slice(0, 200),
      metadata: metadata || {},
      page: job.page,
      filePath,
      startTime: stageStart,
      stopped: false,
      startDispose: null,
      actionsDispose: null,
      // Per-stage in-video metadata (chapters/actions/overlays).
      stageChapters: [],
      stageActions: []
    };

    try {
      stage.startDispose = await job.page.screencast.start({
        path: filePath,
        size: job.viewport,
        quality: envInt('SCREENCAST_JPEG_QUALITY', 70)
      });
    } catch (err) {
      console.error(`[SCREENCAST] page.screencast.start failed for job ${jobId} stage "${label}": ${err.message}`);
      return null;
    }

    try {
      stage.actionsDispose = await job.page.screencast.showActions({
        duration: envInt('SCREENCAST_ACTION_HIGHLIGHT_MS', 1500),
        fontSize: envInt('SCREENCAST_ACTION_FONT_PX', 22),
        position: process.env.SCREENCAST_ACTION_POSITION || 'top-right'
      });
    } catch (err) {
      console.warn(`[SCREENCAST] showActions failed for job ${jobId} stage "${label}": ${err.message}`);
    }

    // Bake a chapter overlay into the start of the stage so it's visible in
    // the playlist thumbnail / first second of the clip.
    try {
      const description = metadata?.description
        ? String(metadata.description).slice(0, 300)
        : (metadata?.journey_id ? `Journey ${metadata.journey_id}` : null);
      if (job.page.screencast && typeof job.page.screencast.showChapter === 'function') {
        await job.page.screencast.showChapter(stage.label, {
          ...(description ? { description } : {}),
          duration: envInt('SCREENCAST_STAGE_CHAPTER_MS', 1800)
        });
      }
    } catch (err) {
      console.warn(`[SCREENCAST] showChapter failed for stage "${label}": ${err.message}`);
    }

    stage.stageChapters.push({
      time_offset: 0,
      title: stage.label,
      description: metadata?.description || null,
      kind: 'stage_start',
      stage_id: id
    });
    job.chapters.push({
      time_offset: Math.max(0, (stageStart - job.jobStartTime) / 1000),
      title: stage.label,
      description: metadata?.description || null,
      kind: 'stage_start',
      stage_id: id
    });

    job.activeStage = stage;
    console.log(`🎬 [SCREENCAST] Stage "${stage.label}" started for job ${jobId} -> ${filename}`);
    return id;
  }

  /**
   * Stop the active stage. Returns the uploaded segment metadata (or null on
   * failure / if no stage was active).
   */
  async endStage(jobId, stageId, extra = {}) {
    const job = this.jobs.get(jobId);
    if (!job || !job.activeStage) return null;
    if (stageId && job.activeStage.id !== stageId) {
      // Stale callers; ignore quietly.
      return null;
    }
    const stage = job.activeStage;
    if (stage.stopped) return null;
    stage.stopped = true;
    job.activeStage = null;

    // Stop showActions disposer (best-effort).
    try {
      if (stage.actionsDispose && typeof stage.actionsDispose.dispose === 'function') {
        await stage.actionsDispose.dispose();
      } else if (typeof stage.actionsDispose === 'function') {
        await stage.actionsDispose();
      }
    } catch (_) { /* ignore */ }

    // Stop the screencast and dispose the start handle to flush the WebM.
    if (this._isPageUsable(stage.page)) {
      try {
        const sc = stage.page.screencast;
        if (sc && typeof sc.stop === 'function') {
          await sc.stop();
        }
      } catch (err) {
        console.warn(`[SCREENCAST] stop() failed for stage "${stage.label}": ${err.message}`);
      }
    }
    try {
      if (stage.startDispose && typeof stage.startDispose.dispose === 'function') {
        await stage.startDispose.dispose();
      } else if (typeof stage.startDispose === 'function') {
        await stage.startDispose();
      }
    } catch (_) { /* ignore */ }

    // Wait briefly for the WebM file to finish writing.
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Stat / measure / upload.
    let stats = null;
    try { stats = await fs.promises.stat(stage.filePath); } catch (_) { stats = null; }
    if (!stats || stats.size <= 0) {
      console.warn(`[SCREENCAST] Stage "${stage.label}" produced no WebM file at ${stage.filePath}; skipping upload.`);
      return null;
    }
    const duration = await this._probeDurationSeconds(stage.filePath);
    const sizeBytes = stats.size;
    const startOffset = Math.max(0, (stage.startTime - job.jobStartTime) / 1000);
    const endOffset = startOffset + (Number.isFinite(duration) ? duration : 0);

    let uploadInfo = null;
    try {
      uploadInfo = await this._uploadSegmentFile(jobId, stage, sizeBytes);
    } catch (err) {
      console.error(`[SCREENCAST] Failed to upload stage "${stage.label}" for job ${jobId}: ${err.message}`);
    }

    // Cleanup the local file.
    try { await fs.promises.unlink(stage.filePath); } catch (_) { /* ignore */ }

    if (!uploadInfo) return null;

    const segment = {
      segment_id: stage.id,
      label: stage.label,
      type: stage.metadata?.type || 'workflow_leg',
      leg_id: stage.metadata?.leg_id || null,
      journey_id: stage.metadata?.journey_id || null,
      start_offset: startOffset,
      end_offset: endOffset,
      padded_start: startOffset,
      padded_end: endOffset,
      duration: Number.isFinite(duration) ? duration : 0,
      video_url: uploadInfo.videoUrl,
      video_key: uploadInfo.key,
      video_size_bytes: sizeBytes,
      metadata: {
        ...(stage.metadata || {}),
        end_metadata: extra || {},
        chapters: stage.stageChapters,
        actions: stage.stageActions,
        recorder: RECORDER_TAG
      }
    };

    job.segments.push(segment);
    console.log(`✅ [SCREENCAST] Stage "${stage.label}" uploaded: ${(sizeBytes / 1024).toFixed(0)} KB, ${segment.duration.toFixed(2)}s -> ${uploadInfo.videoUrl}`);

    // Register with backend so the UI's playlist updates immediately.
    try {
      await this._registerSegment(jobId, segment);
    } catch (err) {
      console.warn(`[SCREENCAST] Could not register segment with backend: ${err.message}`);
    }

    return segment;
  }

  // ---------------------------------------------------------------------------
  // In-video annotations (only meaningful while a stage is active)
  // ---------------------------------------------------------------------------

  /**
   * Bake a chapter overlay into the active stage video. No-op if no stage is
   * recording (so it can be called from anywhere safely).
   */
  async showChapter(jobId, title, description = null, durationMs = 1800) {
    const job = this.jobs.get(jobId);
    if (!job || !job.activeStage || job.activeStage.stopped) return;
    const stage = job.activeStage;
    if (!this._isPageUsable(stage.page)) return;
    const safeTitle = String(title || '').slice(0, 200);
    const safeDescription = description ? String(description).slice(0, 300) : null;
    const time_offset_stage = Math.max(0, (nowMs() - stage.startTime) / 1000);
    const time_offset_job = Math.max(0, (nowMs() - job.jobStartTime) / 1000);
    stage.stageChapters.push({ time_offset: time_offset_stage, title: safeTitle, description: safeDescription, kind: 'chapter', stage_id: stage.id });
    job.chapters.push({ time_offset: time_offset_job, title: safeTitle, description: safeDescription, kind: 'chapter', stage_id: stage.id });
    try {
      const sc = stage.page.screencast;
      if (sc && typeof sc.showChapter === 'function') {
        await sc.showChapter(safeTitle, {
          ...(safeDescription ? { description: safeDescription } : {}),
          duration: Math.max(500, Number(durationMs) || 1800)
        });
      }
    } catch (err) {
      // Don't fail anything because of an overlay.
    }
  }

  /**
   * Bake an action-title overlay into the active stage video. No-op if no
   * stage is recording.
   */
  async showAction(jobId, title, kind = 'action_started') {
    const job = this.jobs.get(jobId);
    if (!job || !job.activeStage || job.activeStage.stopped) return;
    const stage = job.activeStage;
    if (!this._isPageUsable(stage.page)) return;
    const safeTitle = String(title || '').slice(0, 200);
    const time_offset_stage = Math.max(0, (nowMs() - stage.startTime) / 1000);
    const time_offset_job = Math.max(0, (nowMs() - job.jobStartTime) / 1000);
    stage.stageActions.push({ time_offset: time_offset_stage, title: safeTitle, kind, stage_id: stage.id });
    job.actions.push({ time_offset: time_offset_job, title: safeTitle, kind, stage_id: stage.id });
    try {
      const sc = stage.page.screencast;
      if (sc && typeof sc.showOverlay === 'function') {
        const html = `<div style="padding:8px 14px;background:rgba(15,23,42,0.85);color:#fff;border-radius:8px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.35);">${escapeHtml(safeTitle)}</div>`;
        await sc.showOverlay(html, { duration: 1800 });
      }
    } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Legacy alias kept so existing callers (workflow-executor) continue to work.
  // ---------------------------------------------------------------------------

  startSegment(jobId, segmentId, label, metadata = {}) {
    // Fire-and-forget so the executor's existing sync call site works.
    const id = segmentId || `segment-${nowMs()}`;
    this.startStage(jobId, id, label, metadata).catch((err) => {
      console.warn(`[SCREENCAST] startSegment("${label}") failed: ${err.message}`);
    });
    return id;
  }

  endSegment(jobId, segmentId, extra = {}) {
    this.endStage(jobId, segmentId, extra).catch((err) => {
      console.warn(`[SCREENCAST] endSegment("${segmentId}") failed: ${err.message}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Finalize
  // ---------------------------------------------------------------------------

  /**
   * Finish the job: end any active stage and publish the playlist manifest to
   * the backend. Safe to call multiple times.
   */
  async finalize(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.activeStage && !job.activeStage.stopped) {
      try {
        await this.endStage(jobId, job.activeStage.id, { reason: 'finalize' });
      } catch (_) { /* ignore */ }
    }

    const totalDuration = job.segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);
    const totalSize = job.segments.reduce((sum, seg) => sum + (seg.video_size_bytes || 0), 0);
    const playlist = job.segments.map((seg) => ({
      segment_id: seg.segment_id,
      label: seg.label,
      type: seg.type,
      leg_id: seg.leg_id,
      journey_id: seg.journey_id,
      duration: seg.duration,
      size_bytes: seg.video_size_bytes,
      video_url: seg.video_url,
      video_key: seg.video_key
    }));

    try {
      const headers = {};
      if (this.runnerToken) headers['Authorization'] = `Bearer ${this.runnerToken}`;
      const startedAt = new Date(job.jobStartTime).toISOString();
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video`, {
        // No `video_key` — backend allows playlist-only finalize when
        // `playlist: true` is sent and segment count > 0.
        playlist: true,
        playlist_segments: playlist.length,
        screencast_chapters: job.chapters,
        screencast_actions: job.actions,
        screencast_pages: [], // unused in playlist mode
        recorder: RECORDER_TAG,
        duration: totalDuration,
        size_bytes: totalSize,
        format: 'webm',
        codec: 'vp8',
        resolution: `${job.viewport.width}x${job.viewport.height}`,
        fps: 25,
        started_at: startedAt
      }, { headers, timeout: 15000 });
      console.log(`✅ [SCREENCAST] Playlist published for job ${jobId}: ${playlist.length} clip(s), ${totalDuration.toFixed(2)}s, ${(totalSize / 1024).toFixed(0)} KB`);
    } catch (err) {
      console.warn(`[SCREENCAST] Could not publish playlist manifest for job ${jobId}: ${err.message}`);
    }

    const summary = {
      success: true,
      playlist,
      segmentCount: playlist.length,
      duration: totalDuration,
      sizeBytes: totalSize,
      chapters: job.chapters,
      actions: job.actions
    };

    this.jobs.delete(jobId);
    return summary;
  }

  /**
   * Abandon any in-flight recordings for a job (e.g. on container shutdown).
   */
  async abort(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.activeStage && !job.activeStage.stopped) {
      try { await this.endStage(jobId, job.activeStage.id, { reason: 'aborted' }); } catch (_) { /* ignore */ }
    }
    this.jobs.delete(jobId);
  }

  async stopAllRecordings() {
    const ids = Array.from(this.jobs.keys());
    for (const id of ids) {
      try { await this.finalize(id); } catch (_) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _isPageUsable(page) {
    if (!page) return false;
    try {
      return typeof page.isClosed === 'function' ? !page.isClosed() : true;
    } catch (_) {
      return false;
    }
  }

  async _probeDurationSeconds(filePath) {
    if (!filePath) return null;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath
      ], { timeout: 30000 });
      const parsed = Number(String(stdout || '').trim());
      return Number.isFinite(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  async _uploadSegmentFile(jobId, stage, sizeBytes) {
    const headers = {};
    if (this.runnerToken) headers['Authorization'] = `Bearer ${this.runnerToken}`;

    // Get a presigned URL scoped as a "segment" so the file lands in the
    // segments/ subdirectory under the job's video bucket prefix.
    const presignRes = await axios.post(`${this.backendUrl}/api/files/prepare-video`, {
      type: 'video',
      jobId,
      segment: true,
      metadata: {
        ...(stage.metadata || {}),
        stage_id: stage.id,
        kind: 'screencast_stage',
        recorder: RECORDER_TAG
      }
    }, { headers, timeout: 15000 });

    const { uploadUrl, key, publicUrl } = presignRes.data || {};
    if (!uploadUrl || !key) {
      throw new Error('prepare-video did not return uploadUrl/key');
    }

    const stream = fs.createReadStream(stage.filePath);
    await axios.put(uploadUrl, stream, {
      headers: { 'Content-Type': 'video/webm', 'Content-Length': sizeBytes },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000
    });

    const publicBackend = this.resolvePublicBackendUrl();
    const playableUrl = publicUrl || `${publicBackend}/stream-video?key=${encodeURIComponent(key)}`;
    return { videoUrl: playableUrl, key };
  }

  async _registerSegment(jobId, segment) {
    const headers = {};
    if (this.runnerToken) headers['Authorization'] = `Bearer ${this.runnerToken}`;
    await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video-segment`, segment, {
      headers, timeout: 15000
    });
  }

  resolvePublicBackendUrl() {
    const normalize = (value) => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.replace(/\/+$/, '');
    };
    const isInternalHost = (hostnameRaw) => {
      const h = String(hostnameRaw || '').trim().toLowerCase();
      if (!h || h === 'back' || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
        const parts = h.split('.').map(Number);
        if (parts[0] === 10) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      }
      return false;
    };
    const candidates = [
      process.env.BACKEND_PUBLIC_URL,
      process.env.PUBLIC_BACKEND_URL,
      process.env.API_PUBLIC_URL,
      process.env.API_URL,
      this.backendUrl
    ].map(normalize).filter(Boolean);
    for (const cand of candidates) {
      try {
        const parsed = new URL(cand);
        if (!isInternalHost(parsed.hostname)) {
          return `${parsed.protocol}//${parsed.host}`;
        }
      } catch (_) { /* ignore */ }
    }
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
      return 'https://api.aionqa.com';
    }
    return 'http://localhost:4000';
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default ScreencastRecorder;
