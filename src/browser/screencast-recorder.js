/**
 * Screencast Recorder (Playwright 1.59 page.screencast)
 *
 * Replaces the legacy `context.recordVideo` + JPEG screenshot streaming + CDP
 * Page.startScreencast paths with a single unified API built on top of
 * `page.screencast.start({ path, onFrame, ... })`.
 *
 * What it captures for every run:
 *   1. The page video itself (one .webm per page, primary uploaded as the
 *      session video, additional pages uploaded as segments).
 *   2. Real-time frames via the `onFrame` callback, throttled and pushed to
 *      the backend frame buffer for live UI playback.
 *   3. Highlighted user actions via `screencast.showActions()` (drawn on top
 *      of the recording by Playwright itself).
 *   4. Action titles via `screencast.showOverlay(...)` (also baked into the
 *      video, plus tracked in metadata so the UI can render them on the
 *      timeline).
 *   5. Chapter overlays via `screencast.showChapter(title, { description })`,
 *      typically driven by workflow leg / journey boundaries.
 *
 * The recorder also keeps the legacy "video segment" cutting (per-leg WebM
 * clips) so existing UI features and `video_segments` storage keep working.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ActivityDetector from './activity-detector.js';

const execFileAsync = promisify(execFile);

const VIDEO_TMP_DIR = process.env.SCREENCAST_TMP_DIR || '/tmp/aionqa_videos';
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

function envInt(name, fallback) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envFloat(name, fallback) {
  const raw = Number.parseFloat(process.env[name] || '');
  return Number.isFinite(raw) ? raw : fallback;
}

function nowMs() {
  return Date.now();
}

function safeFilename(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'item';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class ScreencastRecorder {
  constructor(backendUrl, runnerId, runnerToken = null) {
    this.backendUrl = backendUrl;
    this.runnerId = runnerId;
    this.runnerToken = runnerToken || process.env.RUNNER_TOKEN || null;
    this.activeRecordings = new Map(); // jobId -> recording info

    // Live-frame plumbing (carried over from legacy VideoStreamManager so we
    // can keep the existing presigned-URL pool + batched notify endpoints).
    this.presignedPools = new Map(); // jobId -> Array<{ url, key, publicUrl }>
    this.pendingNotify = new Map(); // jobId -> Array<row>
    this.notifyFlushTimers = new Map(); // jobId -> Timeout

    this._warnedNoRunnerToken = false;

    try {
      if (!fs.existsSync(VIDEO_TMP_DIR)) {
        fs.mkdirSync(VIDEO_TMP_DIR, { recursive: true });
      }
    } catch (err) {
      console.warn(`[SCREENCAST] Could not create tmp dir ${VIDEO_TMP_DIR}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API used by runner.js / workflow-executor.js
  // ---------------------------------------------------------------------------

  /**
   * Start recording for a job. Attaches a screencast to every existing page
   * in the context and to any future page opened in the same context.
   *
   * @param {string} jobId
   * @param {import('playwright').BrowserContext} context
   * @param {import('playwright').Page} page  Primary page (the one users see)
   * @param {Object} [options]
   * @param {{width:number,height:number}} [options.viewport]
   * @param {number} [options.quality]
   * @param {number} [options.frameIntervalMs]  Throttle for `onFrame` uploads.
   */
  async startRecording(jobId, context, page, options = {}) {
    if (this.activeRecordings.has(jobId)) {
      console.log(`[SCREENCAST] Recording already active for job ${jobId}`);
      return false;
    }

    const viewport = (options.viewport && options.viewport.width && options.viewport.height)
      ? { width: options.viewport.width, height: options.viewport.height }
      : DEFAULT_VIEWPORT;
    const quality = Number.isFinite(Number(options.quality))
      ? Math.max(10, Math.min(100, Number(options.quality)))
      : envInt('SCREENCAST_JPEG_QUALITY', 70);
    const frameIntervalMs = Number.isFinite(Number(options.frameIntervalMs))
      ? Math.max(50, Number(options.frameIntervalMs))
      : envInt('SCREENCAST_FRAME_INTERVAL_MS', 200);

    console.log(`🎬 [SCREENCAST] Starting screencast recording for job ${jobId} (viewport=${viewport.width}x${viewport.height}, frameInterval=${frameIntervalMs}ms, quality=${quality})`);

    const startTime = nowMs();
    const recording = {
      jobId,
      context,
      primaryPage: page,
      startTime,
      startedAt: new Date(startTime),
      viewport,
      quality,
      frameIntervalMs,
      pages: new Map(), // page -> { id, path, started, lastFrameAt, frameCount, dispose, actionsDispose }
      pageCounter: 0,
      chapters: [], // [{ time_offset, title, description, kind }]
      overlays: [], // [{ time_offset, duration, title, kind }]
      actions: [],  // [{ time_offset, title, status }]
      segments: [], // legacy per-leg cuts: [{ id, label, metadata, startTimestamp, endTimestamp }]
      activityDetector: null,
      onContextPage: null,
      stopped: false,
      frameSeq: 0,
      lastFrameUploadAt: 0
    };

    // Attach screencast to every existing page in the context.
    try {
      const pages = (context && typeof context.pages === 'function') ? context.pages() : [page];
      const seen = new Set();
      const attachTargets = [page, ...pages].filter((p) => {
        if (!p || seen.has(p)) return false;
        seen.add(p);
        return true;
      });
      for (const target of attachTargets) {
        await this._attachPage(recording, target).catch((err) => {
          console.warn(`[SCREENCAST] Failed to attach screencast to existing page: ${err.message}`);
        });
      }
    } catch (err) {
      console.warn(`[SCREENCAST] Failed to enumerate existing pages for job ${jobId}: ${err.message}`);
    }

    // Attach future pages opened in the same context.
    if (context && typeof context.on === 'function') {
      const onPage = (newPage) => {
        this._attachPage(recording, newPage).catch((err) => {
          console.warn(`[SCREENCAST] Failed to attach screencast to new page: ${err.message}`);
        });
      };
      context.on('page', onPage);
      recording.onContextPage = onPage;
    }

    // Activity detection (powers inactive-period compression at stop time).
    try {
      const activityDetector = new ActivityDetector(page, startTime);
      await activityDetector.start();
      recording.activityDetector = activityDetector;
    } catch (err) {
      console.warn(`[SCREENCAST] ActivityDetector failed to start for job ${jobId}: ${err.message}`);
    }

    this.activeRecordings.set(jobId, recording);
    return true;
  }

  /**
   * Attach a screencast to a single page. Public so callers can manually wire
   * a popup that escaped the context.on('page') flow.
   */
  async attachPage(jobId, page) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording) return false;
    return this._attachPage(recording, page);
  }

  /**
   * Show a chapter overlay (centered on the primary page, baked into the
   * recording) and record it in metadata.
   */
  async showChapter(jobId, title, description = null, durationMs = 2000) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording || recording.stopped) return;
    const time_offset = Math.max(0, (nowMs() - recording.startTime) / 1000);
    const safeTitle = String(title || '').slice(0, 200);
    const safeDescription = description ? String(description).slice(0, 500) : null;

    recording.chapters.push({
      time_offset,
      title: safeTitle,
      description: safeDescription,
      duration: Number(durationMs) / 1000,
      kind: 'chapter'
    });

    const target = recording.primaryPage;
    if (this._isPageUsable(target)) {
      try {
        const screencast = target.screencast;
        if (screencast && typeof screencast.showChapter === 'function') {
          await screencast.showChapter(safeTitle, {
            ...(safeDescription ? { description: safeDescription } : {}),
            duration: Math.max(500, Number(durationMs) || 2000)
          });
        }
      } catch (err) {
        // Don't let overlay errors fail the run.
        console.warn(`[SCREENCAST] showChapter failed for job ${jobId}: ${err.message}`);
      }
    }
  }

  /**
   * Show a custom HTML overlay (baked into the recording) and record it in
   * metadata. Returns the textual title used so callers can correlate.
   */
  async showOverlay(jobId, htmlOrTitle, options = {}) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording || recording.stopped) return null;
    const time_offset = Math.max(0, (nowMs() - recording.startTime) / 1000);
    const durationMs = Number.isFinite(Number(options.durationMs)) ? Number(options.durationMs) : 2500;

    const isHtml = /<[a-z][\s\S]*>/i.test(String(htmlOrTitle || ''));
    const title = String(options.title || (isHtml ? '' : (htmlOrTitle || ''))).slice(0, 200);
    const html = isHtml
      ? String(htmlOrTitle)
      : `<div style="padding:10px 16px;background:rgba(15,23,42,0.85);color:#fff;border-radius:8px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.35);">${escapeHtml(title)}</div>`;

    recording.overlays.push({
      time_offset,
      duration: durationMs / 1000,
      title,
      kind: options.kind || 'overlay'
    });

    const target = recording.primaryPage;
    if (this._isPageUsable(target)) {
      try {
        const screencast = target.screencast;
        if (screencast && typeof screencast.showOverlay === 'function') {
          await screencast.showOverlay(html, { duration: Math.max(500, durationMs) });
        }
      } catch (err) {
        console.warn(`[SCREENCAST] showOverlay failed for job ${jobId}: ${err.message}`);
      }
    }
    return title || null;
  }

  /**
   * Convenience: announce that a workflow action is starting. Records as both
   * an overlay (visible in video) and an action timeline entry (metadata).
   */
  async showAction(jobId, title, kind = 'action_started') {
    if (!title) return;
    const recording = this.activeRecordings.get(jobId);
    if (!recording || recording.stopped) return;
    recording.actions.push({
      time_offset: Math.max(0, (nowMs() - recording.startTime) / 1000),
      title: String(title).slice(0, 200),
      kind
    });
    await this.showOverlay(jobId, title, { kind, durationMs: 2000 });
  }

  // -- Legacy segment API kept stable for workflow-executor.js -----------------

  startSegment(jobId, segmentId, label, metadata = {}) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording || recording.stopped) return null;
    const id = segmentId || `segment-${nowMs()}`;
    recording.segments.push({
      id,
      label: label || id,
      metadata,
      startTimestamp: nowMs(),
      endTimestamp: null
    });
    // Also visualize as a chapter so users see the leg boundary in the video.
    this.showChapter(jobId, label || id, metadata?.description || null, 2200).catch(() => {});
    return id;
  }

  endSegment(jobId, segmentId, extra = {}) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording || !recording.segments) return;
    const segment = recording.segments.find((s) => s.id === segmentId);
    if (!segment || segment.endTimestamp) return;
    segment.endTimestamp = nowMs();
    segment.endMetadata = extra || {};
  }

  // ---------------------------------------------------------------------------
  // Stop + upload
  // ---------------------------------------------------------------------------

  /**
   * Stop the screencast for every page, finalize the WebM files, upload the
   * primary one as the session video, additional ones as segments, and write
   * metadata (chapters/overlays/actions/inactive markers) to the backend.
   */
  async stopRecording(jobId) {
    const recording = this.activeRecordings.get(jobId);
    if (!recording) {
      console.log(`[SCREENCAST] No active recording for job ${jobId}`);
      return null;
    }
    if (recording.stopped) {
      return null;
    }
    recording.stopped = true;

    console.log(`⏹️  [SCREENCAST] Stopping screencast for job ${jobId} (${recording.pages.size} page(s))`);

    // Detach context page listener.
    try {
      if (recording.context && recording.onContextPage && typeof recording.context.off === 'function') {
        recording.context.off('page', recording.onContextPage);
      }
    } catch (_) { /* ignore */ }

    // Stop showActions disposers.
    for (const entry of recording.pages.values()) {
      try {
        if (entry.actionsDispose && typeof entry.actionsDispose.dispose === 'function') {
          await entry.actionsDispose.dispose();
        } else if (typeof entry.actionsDispose === 'function') {
          await entry.actionsDispose();
        }
      } catch (_) { /* ignore */ }
    }

    // Stop screencast on every still-attached page (this finalizes the file).
    const pageEntries = Array.from(recording.pages.entries());
    for (const [page, entry] of pageEntries) {
      if (!this._isPageUsable(page)) continue;
      try {
        const screencast = page.screencast;
        if (screencast && typeof screencast.stop === 'function') {
          await screencast.stop();
        } else if (entry.dispose && typeof entry.dispose.dispose === 'function') {
          await entry.dispose.dispose();
        }
      } catch (err) {
        console.warn(`[SCREENCAST] Failed to stop screencast on a page for job ${jobId}: ${err.message}`);
      }
    }

    // Stop activity detector.
    try {
      if (recording.activityDetector) {
        await recording.activityDetector.stop();
      }
    } catch (_) { /* ignore */ }

    // Flush remaining frame notifies.
    try { await this._flushNotifyBatch(jobId); } catch (_) { /* ignore */ }

    // Wait briefly for files to flush to disk (Playwright writes async).
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Collect all video files actually present on disk.
    const candidates = [];
    for (const entry of recording.pages.values()) {
      try {
        if (!entry.path) continue;
        const stats = await fs.promises.stat(entry.path).catch(() => null);
        if (!stats || stats.size <= 0) continue;
        const durationSeconds = await this._probeDurationSeconds(entry.path);
        candidates.push({
          page_id: entry.id,
          path: entry.path,
          size: stats.size,
          durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
          isPrimary: entry.isPrimary === true,
          frameCount: entry.frameCount || 0
        });
      } catch (err) {
        console.warn(`[SCREENCAST] Failed to stat page video file: ${err.message}`);
      }
    }

    if (candidates.length === 0) {
      console.error(`[SCREENCAST] No screencast files were produced for job ${jobId}`);
      this.activeRecordings.delete(jobId);
      return null;
    }

    // Choose primary: first marked primary, else longest, else largest.
    const primary = candidates
      .slice()
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        const dDelta = (b.durationSeconds || 0) - (a.durationSeconds || 0);
        if (Math.abs(dDelta) > 0.05) return dDelta;
        return (b.size || 0) - (a.size || 0);
      })[0];
    const additional = candidates.filter((c) => c.path !== primary.path);

    const startedAt = recording.startedAt instanceof Date ? recording.startedAt : new Date(recording.startedAt || recording.startTime);
    const primaryDuration = primary.durationSeconds > 0
      ? primary.durationSeconds
      : Math.max(0.1, (nowMs() - recording.startTime) / 1000);
    const inactiveMarkers = recording.activityDetector
      ? (recording.activityDetector.getInactiveMarkers({ useCompressedTimeline: false }) || [])
      : [];

    let uploadResult = null;
    try {
      uploadResult = await this._uploadVideo(jobId, primary.path, primary.size, primaryDuration, startedAt, {
        inactiveMarkers,
        chapters: recording.chapters,
        overlays: recording.overlays,
        actions: recording.actions,
        screencastPages: candidates.map((c) => ({
          page_id: c.page_id,
          duration: c.durationSeconds,
          size_bytes: c.size,
          is_primary: c.path === primary.path,
          frame_count: c.frameCount
        }))
      });
    } catch (err) {
      console.error(`[SCREENCAST] Upload failed for job ${jobId}: ${err.message}`);
    }

    // Upload additional pages (popups, secondary tabs) as page-scoped segments.
    for (const extra of additional) {
      try {
        await this._uploadPageVideoAsSegment(jobId, extra, recording);
      } catch (err) {
        console.warn(`[SCREENCAST] Failed to upload extra page video: ${err.message}`);
      }
    }

    // Upload per-leg segment clips (cut from the primary file with ffmpeg).
    try {
      await this._processLegSegments(jobId, recording, primary.path, primaryDuration);
    } catch (err) {
      console.warn(`[SCREENCAST] Failed to process leg segments: ${err.message}`);
    }

    // Cleanup local files (best-effort).
    for (const c of candidates) {
      try { await fs.promises.unlink(c.path); } catch (_) { /* ignore */ }
    }

    this.activeRecordings.delete(jobId);

    if (!uploadResult) return null;

    return {
      success: true,
      videoUrl: uploadResult.url,
      videoKey: uploadResult.key,
      duration: primaryDuration,
      sizeBytes: primary.size,
      sizeMB: (primary.size / (1024 * 1024)).toFixed(2),
      startedAt: startedAt.toISOString(),
      chapters: recording.chapters,
      overlays: recording.overlays,
      actions: recording.actions,
      inactiveMarkers,
      pages: candidates.length
    };
  }

  async stopAllRecordings() {
    const jobs = Array.from(this.activeRecordings.keys());
    for (const jobId of jobs) {
      try { await this.stopRecording(jobId); } catch (_) { /* ignore */ }
    }
  }

  getRecording(jobId) {
    return this.activeRecordings.get(jobId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  async _attachPage(recording, page) {
    if (!page || !recording || recording.stopped) return false;
    if (recording.pages.has(page)) return false;
    if (typeof page.screencast === 'undefined' || !page.screencast || typeof page.screencast.start !== 'function') {
      console.warn('[SCREENCAST] page.screencast.start is unavailable. Make sure Playwright >= 1.59.0 is installed.');
      return false;
    }

    const pageId = ++recording.pageCounter;
    const isPrimary = pageId === 1 || page === recording.primaryPage;
    const filePath = path.join(VIDEO_TMP_DIR, `${recording.jobId}-page${pageId}-${nowMs()}.webm`);
    const entry = {
      id: pageId,
      path: filePath,
      started: false,
      isPrimary,
      lastFrameAt: 0,
      frameCount: 0,
      dispose: null,
      actionsDispose: null
    };
    recording.pages.set(page, entry);

    try {
      const dispose = await page.screencast.start({
        path: filePath,
        size: recording.viewport,
        quality: recording.quality,
        onFrame: ({ data }) => this._handleFrame(recording, entry, data)
      });
      entry.dispose = dispose;
      entry.started = true;
    } catch (err) {
      console.error(`[SCREENCAST] page.screencast.start failed for job ${recording.jobId} page ${pageId}: ${err.message}`);
      recording.pages.delete(page);
      return false;
    }

    // Highlight every clicked / typed / hovered element + show the action title.
    try {
      const actionsDispose = await page.screencast.showActions({
        duration: envInt('SCREENCAST_ACTION_HIGHLIGHT_MS', 1500),
        fontSize: envInt('SCREENCAST_ACTION_FONT_PX', 22),
        position: process.env.SCREENCAST_ACTION_POSITION || 'top-right'
      });
      entry.actionsDispose = actionsDispose;
    } catch (err) {
      console.warn(`[SCREENCAST] showActions failed for job ${recording.jobId} page ${pageId}: ${err.message}`);
    }

    page.once('close', () => {
      // Don't try to call .stop() here -- the file is already finalized when
      // the page is destroyed by the browser.
      const e = recording.pages.get(page);
      if (e) {
        e.started = false;
      }
    });

    console.log(`[SCREENCAST] Attached page #${pageId} for job ${recording.jobId} -> ${filePath}${isPrimary ? ' (primary)' : ''}`);
    return true;
  }

  _isPageUsable(page) {
    if (!page) return false;
    try {
      return typeof page.isClosed === 'function' ? !page.isClosed() : true;
    } catch (_) {
      return false;
    }
  }

  _handleFrame(recording, entry, data) {
    if (!recording || recording.stopped) return;
    if (!data || data.length === 0) return;

    // Only stream frames from the primary page; others would just spam the UI.
    if (!entry.isPrimary) return;

    const now = nowMs();
    if (now - recording.lastFrameUploadAt < recording.frameIntervalMs) {
      return;
    }
    recording.lastFrameUploadAt = now;
    entry.lastFrameAt = now;
    entry.frameCount += 1;

    const frameNumber = recording.frameSeq++;
    const jobId = recording.jobId;

    let currentUrl = '';
    try {
      const targetPage = recording.primaryPage;
      if (this._isPageUsable(targetPage)) {
        currentUrl = targetPage.url();
      }
    } catch (_) { /* ignore */ }

    // Mark activity for the activity-detector so inactive periods detect frame changes.
    try {
      if (recording.activityDetector && typeof recording.activityDetector.markFrameChange === 'function') {
        recording.activityDetector.markFrameChange();
      }
    } catch (_) { /* ignore */ }

    // data is a Buffer-like (Uint8Array). Send to backend asynchronously.
    this._sendFrame(jobId, data, frameNumber, currentUrl).catch((err) => {
      if (frameNumber % 50 === 0) {
        console.warn(`[SCREENCAST] frame ${frameNumber} send failed: ${err.message}`);
      }
    });
  }

  // -- Frame upload (presigned PUT + batched notify) ---------------------------

  async _sendFrame(jobId, frameBuffer, frameNumber, currentUrl) {
    if (!this.runnerToken) {
      if (!this._warnedNoRunnerToken) {
        this._warnedNoRunnerToken = true;
        console.warn('[SCREENCAST] RUNNER_TOKEN is required for live frame streaming; skipping frame uploads.');
      }
      return;
    }
    const slot = await this._takePresignedFrameSlot(jobId);
    if (!slot || !slot.url) return;
    const buffer = Buffer.isBuffer(frameBuffer) ? frameBuffer : Buffer.from(frameBuffer);
    try {
      await axios.put(slot.url, buffer, {
        headers: { 'Content-Type': 'image/jpeg' },
        maxBodyLength: Infinity,
        timeout: 10000
      });
    } catch (err) {
      // Drop the frame; do not retry to avoid backpressure.
      return;
    }
    this._queueStreamNotify(jobId, {
      jobId,
      key: slot.key,
      publicUrl: slot.publicUrl,
      timestamp: new Date().toISOString(),
      frameNumber,
      url: currentUrl
    });
  }

  async _takePresignedFrameSlot(jobId) {
    const jid = String(jobId || '');
    let pool = this.presignedPools.get(jid) || [];
    const refillAt = Math.max(0, envInt('SCREENCAST_PRESIGNED_REFILL_AT', 4));
    const batchSize = Math.max(4, Math.min(48, envInt('SCREENCAST_PRESIGNED_BATCH', 16)));
    if (pool.length <= refillAt) {
      try {
        const res = await axios.post(
          `${this.backendUrl}/api/upload/presigned-url-batch`,
          { type: 'frame', jobId: jid, count: batchSize },
          { timeout: 20000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
        );
        const items = Array.isArray(res.data?.items) ? res.data.items : [];
        pool = pool.concat(items);
      } catch (_) {
        try {
          const presignedRes = await axios.post(
            `${this.backendUrl}/api/upload/presigned-url`,
            { type: 'frame', jobId: jid },
            { timeout: 5000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
          );
          pool = pool.concat([presignedRes.data]);
        } catch (_) { /* swallow */ }
      }
    }
    const slot = pool.shift();
    this.presignedPools.set(jid, pool);
    return slot;
  }

  _notifyBatchSize() {
    return Math.max(1, Math.min(32, envInt('SCREENCAST_NOTIFY_BATCH', 8)));
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
    const debounce = envInt('SCREENCAST_NOTIFY_DEBOUNCE_MS', 120);
    const t = setTimeout(() => {
      this.notifyFlushTimers.delete(jid);
      this._flushNotifyBatch(jid).catch(() => {});
    }, debounce);
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
      url: row.url
    }));
    try {
      await axios.post(
        `${this.backendUrl}/api/runners/${this.runnerId}/stream-frame-batch`,
        { items },
        { timeout: 15000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
      );
    } catch (_) {
      for (const row of chunk) {
        try {
          await axios.post(
            `${this.backendUrl}/api/runners/${this.runnerId}/stream-frame`,
            row,
            { timeout: 5000, headers: { Authorization: `Bearer ${this.runnerToken}` } }
          );
        } catch (_) { /* swallow */ }
      }
    }
    if ((this.pendingNotify.get(jid) || []).length > 0) {
      await this._flushNotifyBatch(jid);
    }
  }

  // -- File / metadata upload --------------------------------------------------

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
    } catch (err) {
      return null;
    }
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

  async _uploadVideo(jobId, videoPath, fileSize, duration, startedAt, extras = {}) {
    const headers = {};
    if (this.runnerToken) {
      headers['Authorization'] = `Bearer ${this.runnerToken}`;
    }

    const presignRes = await axios.post(`${this.backendUrl}/api/upload/presigned-url`, {
      type: 'video',
      jobId,
      contentType: 'video/webm'
    }, { headers, timeout: 15000 });

    const { url: presignedUrl, key, publicUrl } = presignRes.data;

    console.log(`[SCREENCAST] Uploading primary video for job ${jobId} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`);
    const stream = fs.createReadStream(videoPath);
    await axios.put(presignedUrl, stream, {
      headers: { 'Content-Type': 'video/webm', 'Content-Length': fileSize },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000
    });

    const publicBackendUrl = this.resolvePublicBackendUrl();
    const backendVideoUrl = `${publicBackendUrl}/stream-video?key=${encodeURIComponent(key)}`;

    await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video`, {
      video_key: key,
      video_url: backendVideoUrl,
      duration,
      size_bytes: fileSize,
      format: 'webm',
      codec: 'vp8',
      resolution: `${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}`,
      fps: envInt('SCREENCAST_FPS_HINT', 30),
      started_at: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
      inactive_markers: Array.isArray(extras.inactiveMarkers) ? extras.inactiveMarkers : [],
      // New fields for Playwright 1.59 screencast.
      screencast_chapters: Array.isArray(extras.chapters) ? extras.chapters : [],
      screencast_overlays: Array.isArray(extras.overlays) ? extras.overlays : [],
      screencast_actions: Array.isArray(extras.actions) ? extras.actions : [],
      screencast_pages: Array.isArray(extras.screencastPages) ? extras.screencastPages : [],
      recorder: 'playwright-screencast-1.59'
    }, { headers, timeout: 15000 });

    console.log(`✅ [SCREENCAST] Video metadata saved for job ${jobId} (chapters=${extras.chapters?.length || 0}, overlays=${extras.overlays?.length || 0}, actions=${extras.actions?.length || 0}, pages=${extras.screencastPages?.length || 0})`);
    return { url: publicUrl || presignedUrl.split('?')[0], key };
  }

  async _uploadPageVideoAsSegment(jobId, candidate, recording) {
    if (!candidate || !candidate.path) return;
    try {
      const stats = await fs.promises.stat(candidate.path);
      if (!stats || stats.size <= 0) return;
      const segmentId = `page-${candidate.page_id}-${nowMs()}`;
      const headers = {};
      if (this.runnerToken) {
        headers['Authorization'] = `Bearer ${this.runnerToken}`;
      }
      const presignRes = await axios.post(`${this.backendUrl}/api/files/prepare-video`, {
        type: 'video',
        jobId,
        segment: true,
        metadata: { page_id: candidate.page_id, kind: 'screencast_page' }
      }, { headers, timeout: 10000 });
      const { uploadUrl, key, publicUrl } = presignRes.data;
      const stream = fs.createReadStream(candidate.path);
      await axios.put(uploadUrl, stream, {
        headers: { 'Content-Type': 'video/webm', 'Content-Length': stats.size },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300000
      });
      const finalUrl = publicUrl || uploadUrl.split('?')[0];
      const start_offset = Math.max(0, ((recording.startTime || nowMs()) - recording.startTime) / 1000);
      await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video-segment`, {
        segment_id: segmentId,
        label: `Popup page ${candidate.page_id}`,
        type: 'screencast_page',
        leg_id: null,
        journey_id: null,
        start_offset,
        end_offset: start_offset + (candidate.durationSeconds || 0),
        padded_start: start_offset,
        padded_end: start_offset + (candidate.durationSeconds || 0),
        duration: candidate.durationSeconds || 0,
        video_url: finalUrl,
        video_key: key,
        video_size_bytes: stats.size,
        metadata: { page_id: candidate.page_id, kind: 'screencast_page', frame_count: candidate.frameCount || 0 }
      }, { headers, timeout: 10000 });
    } catch (err) {
      console.warn(`[SCREENCAST] Could not upload extra page video as segment: ${err.message}`);
    }
  }

  async _processLegSegments(jobId, recording, fullVideoPath, fullDurationSeconds) {
    if (!recording?.segments || recording.segments.length === 0) return;
    const segmentsToProcess = recording.segments.filter((s) => s.endTimestamp && s.endTimestamp > s.startTimestamp);
    if (segmentsToProcess.length === 0) return;

    const headers = {};
    if (this.runnerToken) {
      headers['Authorization'] = `Bearer ${this.runnerToken}`;
    }
    const workDir = path.dirname(fullVideoPath);

    for (const segment of segmentsToProcess) {
      try {
        const startOffset = Math.max(0, (segment.startTimestamp - recording.startTime) / 1000);
        const endOffset = Math.max(startOffset, (segment.endTimestamp - recording.startTime) / 1000);
        const paddedStart = Math.max(0, startOffset - 0.35);
        const paddedEnd = Math.min(fullDurationSeconds, endOffset + 0.65);
        const clipDuration = Math.max(0.5, paddedEnd - paddedStart);
        if (!Number.isFinite(clipDuration) || clipDuration <= 0) continue;

        const segmentFilename = `${jobId}-${safeFilename(segment.label)}-${nowMs()}.webm`;
        const segmentPath = path.join(workDir, segmentFilename);
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', fullVideoPath,
          '-ss', paddedStart.toFixed(3),
          '-t', clipDuration.toFixed(3),
          '-c', 'copy',
          segmentPath
        ], { timeout: 600000 });

        const stats = await fs.promises.stat(segmentPath);
        const presignRes = await axios.post(`${this.backendUrl}/api/files/prepare-video`, {
          type: 'video',
          jobId,
          segment: true,
          metadata: segment.metadata || {}
        }, { headers, timeout: 10000 });
        const { uploadUrl, key, publicUrl } = presignRes.data;
        const stream = fs.createReadStream(segmentPath);
        await axios.put(uploadUrl, stream, {
          headers: { 'Content-Type': 'video/webm', 'Content-Length': stats.size },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 300000
        });
        const finalUrl = publicUrl || uploadUrl.split('?')[0];
        await axios.post(`${this.backendUrl}/api/jobs/${jobId}/video-segment`, {
          segment_id: segment.id,
          label: segment.label,
          type: segment.metadata?.type || 'workflow_leg',
          leg_id: segment.metadata?.leg_id || null,
          journey_id: segment.metadata?.journey_id || null,
          start_offset: startOffset,
          end_offset: endOffset,
          padded_start: paddedStart,
          padded_end: paddedEnd,
          duration: clipDuration,
          video_url: finalUrl,
          video_key: key,
          video_size_bytes: stats.size,
          metadata: { ...(segment.metadata || {}), end_metadata: segment.endMetadata || {} }
        }, { headers, timeout: 10000 });

        try { await fs.promises.unlink(segmentPath); } catch (_) { /* ignore */ }
      } catch (err) {
        console.warn(`[SCREENCAST] Failed to process leg segment "${segment.label}": ${err.message}`);
      }
    }
  }
}

export default ScreencastRecorder;
