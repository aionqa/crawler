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
 *
 * Post-processing (when `SCREENCAST_DECIMATE` is on): if the stage has
 * `action_started` / `action_completed` marks from `showAction`, we trim
 * leading/trailing idle and long AI gaps with aggressive mpdecimate, but keep
 * Playwright execution intervals at full frame rate (no mid-action decimation).
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
// Hard cap on a single stage's wall-clock duration. The workflow can take
// minutes when an LLM call gets stuck; we don't want that to translate into a
// minutes-long WebM full of idle frames. Anything that exceeds this gets
// auto-ended (the next stage will simply start a fresh clip).
const STAGE_MAX_DURATION_MS = Math.max(
  5_000,
  Number.parseInt(process.env.SCREENCAST_STAGE_MAX_MS || '45000', 10) || 45_000
);
// mpdecimate post-processing cuts near-duplicate frames before upload so the
// final clip only contains frames where something actually changed (typing,
// clicks, navigations, animations). Set `SCREENCAST_DECIMATE=false` to skip
// this — useful only when debugging.
const DECIMATE_ENABLED = String(process.env.SCREENCAST_DECIMATE ?? 'true').toLowerCase() !== 'false';

function envInt(name, fallback) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envFloat(name, fallback) {
  const raw = Number.parseFloat(process.env[name] || '');
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * mpdecimate compares 8x8 blocks on a coarse grid. With a high `frac`, only
 * large screen changes (many medium-diff blocks) keep frames — small motion
 * (cursor, text caret, subtle hover) is dropped. Defaults favor instructional
 * clips; tighten storage via env:
 *   SCREENCAST_MPDECIMATE_FILTER — full -vf chain (overrides hi/lo/frac)
 *   SCREENCAST_MPDECIMATE_HI / _LO / _FRAC — integers / float for mpdecimate=
 */
function buildMpdecimateVideoFilter() {
  const full = String(process.env.SCREENCAST_MPDECIMATE_FILTER || '').trim();
  if (full) return full;
  const hiParsed = Number.parseInt(process.env.SCREENCAST_MPDECIMATE_HI || '', 10);
  const loParsed = Number.parseInt(process.env.SCREENCAST_MPDECIMATE_LO || '', 10);
  const fracParsed = Number.parseFloat(process.env.SCREENCAST_MPDECIMATE_FRAC || '');
  const hi = Number.isFinite(hiParsed) && hiParsed > 0 ? hiParsed : 64 * 8; // 512 — catch small UI deltas
  const lo = Number.isFinite(loParsed) && loParsed > 0 ? loParsed : 64 * 4; // 256
  const frac = Number.isFinite(fracParsed) && fracParsed > 0 && fracParsed <= 1
    ? fracParsed
    : 0.008; // low vs old 0.33 so cursor / typing keep far more frames
  return `mpdecimate=hi=${hi}:lo=${lo}:frac=${frac},setpts=N/FRAME_RATE/TB`;
}

/** Harsh mpdecimate for LLM / static gaps only (not used on automation spans). */
function buildAggressiveIdleMpdecimateFilter() {
  const full = String(process.env.SCREENCAST_MPDECIMATE_IDLE_FILTER || '').trim();
  if (full) return full;
  return 'mpdecimate=hi=64*14:lo=64*5:frac=0.26,setpts=N/FRAME_RATE/TB';
}

function normalizeAutomationMarks(marks) {
  if (!Array.isArray(marks) || marks.length === 0) return [];
  return marks
    .filter((m) => m && Number.isFinite(m.t))
    .map((m) => ({ t: Math.max(0, Number(m.t)), kind: String(m.kind || '') }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Wall-time spans where Playwright was driving the browser (padded), merged.
 */
function protectedIntervalsFromMarks(marks, rawDuration, padBefore, padAfter) {
  const sorted = normalizeAutomationMarks(marks).filter(
    (m) => m.kind === 'action_started' || m.kind === 'action_completed' || m.kind === 'action_failed'
  );
  const raw = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const pre = Math.max(0, padBefore);
  const post = Math.max(0, padAfter);
  const stack = [];
  const intervals = [];
  for (const m of sorted) {
    if (m.kind === 'action_started') {
      stack.push(m.t);
    } else if (m.kind === 'action_completed' || m.kind === 'action_failed') {
      if (stack.length) {
        const s = stack.pop();
        const a = Math.max(0, s - pre);
        const b = Math.min(raw, m.t + post);
        if (b > a + 0.04) intervals.push([a, b]);
      }
    }
  }
  while (stack.length) {
    const s = stack.pop();
    const a = Math.max(0, s - pre);
    const b = raw;
    if (b > a + 0.04) intervals.push([a, b]);
  }
  if (intervals.length === 0) return [];
  intervals.sort((x, y) => x[0] - y[0]);
  const merged = [];
  let [cs, ce] = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s <= ce + 0.05) ce = Math.max(ce, e);
    else {
      merged.push([cs, ce]);
      [cs, ce] = [s, e];
    }
  }
  merged.push([cs, ce]);
  return merged;
}

/**
 * Alternating idle vs automation slices on the stage timeline.
 * @returns {{ kind: 'idle_long'|'idle_short'|'automation', start: number, end: number }[]}
 */
function timelinePiecesFromProtected(protectedIv, rawDuration, longGapSec) {
  const raw = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const thr = Math.max(0.1, longGapSec);
  const pieces = [];
  let cur = 0;
  for (const [ps, pe] of protectedIv) {
    if (ps > cur + 0.02) {
      const len = ps - cur;
      pieces.push({
        kind: len >= thr ? 'idle_long' : 'idle_short',
        start: cur,
        end: ps
      });
    }
    if (pe > ps + 0.02) {
      pieces.push({ kind: 'automation', start: ps, end: pe });
    }
    cur = Math.max(cur, pe);
  }
  if (raw > cur + 0.02) {
    const len = raw - cur;
    pieces.push({
      kind: len >= thr ? 'idle_long' : 'idle_short',
      start: cur,
      end: raw
    });
  }
  return pieces;
}

const FFMPEG_VP9_OUT = [
  '-an',
  '-c:v', 'libvpx-vp9',
  '-row-mt', '1',
  '-tile-columns', '2',
  '-frame-parallel', '1',
  '-quality', 'good',
  '-cpu-used', '1',
  '-b:v', '4M',
  '-deadline', 'good',
  '-r', '25'
];

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
      // Seconds since stage start — drives region-aware compaction (idle vs Playwright).
      automationMarks: [],
      // Per-stage in-video metadata (chapters/actions/overlays).
      stageChapters: [],
      stageActions: [],
      // Watchdog timer that auto-ends the stage if it overruns
      // STAGE_MAX_DURATION_MS. Without this a stuck workflow leg can record
      // for several minutes of pure idle waiting.
      watchdog: null
    };

    try {
      stage.startDispose = await job.page.screencast.start({
        path: filePath,
        size: job.viewport,
        // Bumped from 70 to 92: at 70 the per-frame JPEG compression produces visible blocking on
        // text-heavy SPA tables (FMClarity dashboard), and that gets carried into the final WebM
        // because mpdecimate drops duplicates without re-encoding the kept frames.
        quality: envInt('SCREENCAST_JPEG_QUALITY', 92)
      });
    } catch (err) {
      console.error(`[SCREENCAST] page.screencast.start failed for job ${jobId} stage "${label}": ${err.message}`);
      return null;
    }

    try {
      stage.actionsDispose = await job.page.screencast.showActions({
        duration: envInt('SCREENCAST_ACTION_HIGHLIGHT_MS', 2800),
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
          duration: envInt('SCREENCAST_STAGE_CHAPTER_MS', 2400)
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

    // Arm the watchdog so a stuck stage can't grow unbounded. Use unref so
    // the timer doesn't keep the runner process alive on its own.
    try {
      stage.watchdog = setTimeout(() => {
        if (!stage.stopped) {
          console.warn(`[SCREENCAST] Stage "${stage.label}" exceeded ${STAGE_MAX_DURATION_MS}ms — auto-ending to prevent idle bloat.`);
          this.endStage(jobId, stage.id, { reason: 'max_duration_exceeded' }).catch(() => {});
        }
      }, STAGE_MAX_DURATION_MS);
      if (typeof stage.watchdog?.unref === 'function') stage.watchdog.unref();
    } catch (_) { /* ignore */ }

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

    // Clear the watchdog (we got here either naturally or from the watchdog
    // itself firing — either way the timer is no longer needed).
    if (stage.watchdog) {
      try { clearTimeout(stage.watchdog); } catch (_) { /* ignore */ }
      stage.watchdog = null;
    }

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

    // Stat / measure.
    let stats = null;
    try { stats = await fs.promises.stat(stage.filePath); } catch (_) { stats = null; }
    if (!stats || stats.size <= 0) {
      console.warn(`[SCREENCAST] Stage "${stage.label}" produced no WebM file at ${stage.filePath}; skipping upload.`);
      return null;
    }
    const rawDuration = await this._probeDurationSeconds(stage.filePath);
    const rawSize = stats.size;
    const startOffset = Math.max(0, (stage.startTime - job.jobStartTime) / 1000);

    // Prefer region-aware compaction when we have Playwright action marks:
    // compress leading/trailing idle + long AI gaps only; keep automation spans intact.
    let compacted = null;
    const marks = stage.automationMarks || [];
    if (DECIMATE_ENABLED && marks.length > 0) {
      compacted = await this._compactClipRegionAware(stage.filePath, rawDuration, marks, stage.label);
    }
    if (!compacted && DECIMATE_ENABLED) {
      // Uniform gentle mpdecimate (or no-op for very short clips) when there are no marks.
      compacted = await this._compactClipWithMpdecimate(stage.filePath, rawDuration);
    }
    const finalPath = compacted?.path || stage.filePath;
    const finalDuration = Number.isFinite(compacted?.duration) ? compacted.duration : rawDuration;
    const finalSize = compacted?.size ?? rawSize;
    const endOffset = startOffset + (Number.isFinite(finalDuration) ? finalDuration : 0);

    if (compacted && compacted.path !== stage.filePath) {
      const ratio = rawDuration && Number.isFinite(rawDuration) && rawDuration > 0
        ? (finalDuration / rawDuration)
        : 1;
      console.log(`[SCREENCAST] Compacted "${stage.label}": ${rawDuration?.toFixed(2)}s -> ${finalDuration?.toFixed(2)}s (${(ratio * 100).toFixed(0)}% kept), ${(rawSize / 1024).toFixed(0)} KB -> ${(finalSize / 1024).toFixed(0)} KB`);
    }

    let uploadInfo = null;
    try {
      uploadInfo = await this._uploadSegmentFile(jobId, stage, finalSize, finalPath);
    } catch (err) {
      console.error(`[SCREENCAST] Failed to upload stage "${stage.label}" for job ${jobId}: ${err.message}`);
    }

    // Cleanup local files (raw + compacted if separate).
    try { await fs.promises.unlink(stage.filePath); } catch (_) { /* ignore */ }
    if (finalPath !== stage.filePath) {
      try { await fs.promises.unlink(finalPath); } catch (_) { /* ignore */ }
    }

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
      duration: Number.isFinite(finalDuration) ? finalDuration : 0,
      video_url: uploadInfo.videoUrl,
      video_key: uploadInfo.key,
      video_size_bytes: finalSize,
      metadata: {
        ...(stage.metadata || {}),
        end_metadata: extra || {},
        chapters: stage.stageChapters,
        actions: stage.stageActions,
        recorder: RECORDER_TAG,
        // Pre-compaction stats so the UI can show how much idle time was
        // trimmed (or so a future debug page can re-examine the raw clip).
        raw_duration_seconds: Number.isFinite(rawDuration) ? rawDuration : null,
        raw_size_bytes: rawSize,
        compacted: finalPath !== stage.filePath,
        compaction_mode: compacted?.regionPieces != null ? 'region' : (compacted ? 'uniform' : 'none'),
        region_piece_count: compacted?.regionPieces != null ? compacted.regionPieces : undefined
      }
    };

    job.segments.push(segment);
    console.log(`✅ [SCREENCAST] Stage "${stage.label}" uploaded: ${(finalSize / 1024).toFixed(0)} KB, ${segment.duration.toFixed(2)}s -> ${uploadInfo.videoUrl}`);

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
  async showChapter(jobId, title, description = null, durationMs = null) {
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
          duration: Math.max(500, Number(durationMs) || envInt('SCREENCAST_STAGE_CHAPTER_MS', 2400))
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
    this._recordAutomationMark(stage, kind);
    const safeTitle = String(title || '').slice(0, 200);
    const time_offset_stage = Math.max(0, (nowMs() - stage.startTime) / 1000);
    const time_offset_job = Math.max(0, (nowMs() - job.jobStartTime) / 1000);
    stage.stageActions.push({ time_offset: time_offset_stage, title: safeTitle, kind, stage_id: stage.id });
    job.actions.push({ time_offset: time_offset_job, title: safeTitle, kind, stage_id: stage.id });
    try {
      const sc = stage.page.screencast;
      if (sc && typeof sc.showOverlay === 'function') {
        const html = `<div style="padding:8px 14px;background:rgba(15,23,42,0.85);color:#fff;border-radius:8px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.35);">${escapeHtml(safeTitle)}</div>`;
        await sc.showOverlay(html, { duration: envInt('SCREENCAST_ACTION_OVERLAY_MS', 2400) });
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

  _recordAutomationMark(stage, kind) {
    if (!stage || !Array.isArray(stage.automationMarks)) return;
    const k = String(kind || '');
    if (k !== 'action_started' && k !== 'action_completed' && k !== 'action_failed') return;
    stage.automationMarks.push({
      t: Math.max(0, (nowMs() - stage.startTime) / 1000),
      kind: k
    });
  }

  async _vp9EncodeFilteredSegment(inputPath, vf, outPath) {
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-loglevel', 'error',
        '-i', inputPath,
        '-vf', vf,
        ...FFMPEG_VP9_OUT,
        outPath
      ], { timeout: 600000 });
    } catch (err) {
      console.warn(`[SCREENCAST] segment encode failed: ${err.message}`);
      try { await fs.promises.unlink(outPath); } catch (_) { /* ignore */ }
      return false;
    }
    const st = await fs.promises.stat(outPath).catch(() => null);
    return Boolean(st && st.size > 0);
  }

  async _concatWebmSegments(segmentPaths, outPath) {
    if (!segmentPaths.length) return false;
    if (segmentPaths.length === 1) {
      await fs.promises.copyFile(segmentPaths[0], outPath);
      return true;
    }
    const listPath = outPath.replace(/\.webm$/i, '') + '-concat.txt';
    const escapeForConcat = (absPath) => absPath.replace(/\\/g, '/').replace(/'/g, "'\\''");
    const body = segmentPaths
      .map((p) => `file '${escapeForConcat(path.resolve(p))}'`)
      .join('\n');
    await fs.promises.writeFile(listPath, body, 'utf8');
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-loglevel', 'error',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        ...FFMPEG_VP9_OUT,
        outPath
      ], { timeout: 600000 });
    } catch (err) {
      console.warn(`[SCREENCAST] concat failed: ${err.message}`);
      try { await fs.promises.unlink(outPath); } catch (_) { /* ignore */ }
      return false;
    } finally {
      try { await fs.promises.unlink(listPath); } catch (_) { /* ignore */ }
    }
    const st = await fs.promises.stat(outPath).catch(() => null);
    return Boolean(st && st.size > 0);
  }

  /**
   * Trim idle at the start/end of a stage and long gaps between actions, but
   * keep full frame cadence during Playwright execution (between action_started
   * and action_completed/failed), including short human-like pauses.
   */
  async _compactClipRegionAware(inputPath, rawDuration, marks, logLabel) {
    if (!DECIMATE_ENABLED || !inputPath || !fs.existsSync(inputPath)) return null;
    if (!Number.isFinite(rawDuration) || rawDuration <= 0) return null;

    const norm = normalizeAutomationMarks(marks).filter(
      (m) => m.kind === 'action_started' || m.kind === 'action_completed' || m.kind === 'action_failed'
    );
    if (norm.length === 0) return null;

    const longGap = Math.max(0.15, envFloat('SCREENCAST_IDLE_GAP_COMPRESS_SEC', 2.5));
    const padBefore = envFloat('SCREENCAST_AUTOMATION_PAD_BEFORE', 0.35);
    const padAfter = envFloat('SCREENCAST_AUTOMATION_PAD_AFTER', 0.85);

    const protectedIv = protectedIntervalsFromMarks(marks, rawDuration, padBefore, padAfter);
    if (protectedIv.length === 0) return null;

    const pieces = timelinePiecesFromProtected(protectedIv, rawDuration, longGap);
    if (pieces.length === 0) return null;

    const base = inputPath.replace(/\.webm$/i, '');
    const segmentPaths = [];
    const toCleanup = [];

    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.end <= p.start + 0.02) continue;
      const s = p.start.toFixed(6);
      const e = p.end.toFixed(6);
      let vf = `trim=start=${s}:end=${e},setpts=PTS-STARTPTS`;
      if (p.kind === 'idle_long') {
        vf += `,${buildAggressiveIdleMpdecimateFilter()}`;
      }
      const segPath = `${base}-rseg-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.webm`;
      toCleanup.push(segPath);
      const ok = await this._vp9EncodeFilteredSegment(inputPath, vf, segPath);
      if (!ok) {
        for (const f of toCleanup) {
          try { await fs.promises.unlink(f); } catch (_) { /* ignore */ }
        }
        return null;
      }
      segmentPaths.push(segPath);
    }

    if (segmentPaths.length === 0) {
      for (const f of toCleanup) {
        try { await fs.promises.unlink(f); } catch (_) { /* ignore */ }
      }
      return null;
    }

    const outPath = `${base}-region.webm`;
    const concatOk = await this._concatWebmSegments(segmentPaths, outPath);
    for (const f of segmentPaths) {
      try { await fs.promises.unlink(f); } catch (_) { /* ignore */ }
    }
    if (!concatOk) {
      try { await fs.promises.unlink(outPath); } catch (_) { /* ignore */ }
      return null;
    }

    const outStats = await fs.promises.stat(outPath).catch(() => null);
    const outDuration = await this._probeDurationSeconds(outPath);
    if (!outStats || !outStats.size || !Number.isFinite(outDuration) || outDuration <= 0) {
      try { await fs.promises.unlink(outPath); } catch (_) { /* ignore */ }
      return null;
    }

    console.log(
      `[SCREENCAST] Region-compacted "${logLabel || 'stage'}": ${pieces.length} span(s), raw ${rawDuration.toFixed(2)}s -> ${outDuration.toFixed(2)}s`
    );
    return { path: outPath, size: outStats.size, duration: outDuration, regionPieces: pieces.length };
  }

  async _uploadSegmentFile(jobId, stage, sizeBytes, filePath) {
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

    const sourcePath = filePath || stage.filePath;
    const stream = fs.createReadStream(sourcePath);
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

  /**
   * Drop near-duplicate frames from `inputPath` using ffmpeg's `mpdecimate`
   * filter. Effectively this collapses long static / idle stretches (waiting
   * for the LLM, slow page loads, etc.) so the resulting clip only contains
   * frames where something actually changed on screen. PTS is reset so the
   * output plays at constant 25fps without pauses.
   *
   * Returns `{ path, size, duration }` for the compacted file, or `null` if
   * compaction was skipped or failed (caller should fall back to the raw
   * input).
   */
  async _compactClipWithMpdecimate(inputPath, rawDuration) {
    if (!DECIMATE_ENABLED) return null;
    if (!inputPath || !fs.existsSync(inputPath)) return null;

    // Skip very short clips — overhead isn't worth it. Raised from 1.5s to 5s so the
    // common "click failed pre-flight in <2s" / "click timed out fast in 8s" clips keep their
    // original frame stream and don't get crunched into a blocky 1s of duplicates.
    if (Number.isFinite(rawDuration) && rawDuration < 5) return null;

    const outputPath = inputPath.replace(/\.webm$/i, '') + '-compact.webm';
    const filter = buildMpdecimateVideoFilter();

    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-loglevel', 'error',
        '-i', inputPath,
        '-vf', filter,
        '-an',
        // libvpx-vp9 produces noticeably cleaner text/UI than libvpx (VP8) at the same bitrate.
        '-c:v', 'libvpx-vp9',
        '-row-mt', '1',
        '-tile-columns', '2',
        '-frame-parallel', '1',
        '-quality', 'good',
        // Slower encode but much sharper text/buttons — the previous cpu-used 2 + 1M VP8 was the
        // direct cause of the "video itself is in squares" blockiness on the dashboard tables.
        '-cpu-used', '1',
        '-b:v', '4M',
        '-deadline', 'good',
        '-r', '25',
        outputPath
      ], { timeout: 600000 });
    } catch (err) {
      console.warn(`[SCREENCAST] mpdecimate failed for ${inputPath}: ${err.message}`);
      try { await fs.promises.unlink(outputPath); } catch (_) { /* ignore */ }
      return null;
    }

    let outStats = null;
    try { outStats = await fs.promises.stat(outputPath); } catch (_) { outStats = null; }
    if (!outStats || outStats.size <= 0) {
      try { await fs.promises.unlink(outputPath); } catch (_) { /* ignore */ }
      return null;
    }
    const outDuration = await this._probeDurationSeconds(outputPath);
    if (!Number.isFinite(outDuration) || outDuration <= 0) {
      try { await fs.promises.unlink(outputPath); } catch (_) { /* ignore */ }
      return null;
    }

    return { path: outputPath, size: outStats.size, duration: outDuration };
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
