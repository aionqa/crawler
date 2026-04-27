/**
 * Structured evidence for journey completion + optional per-iteration AI notes.
 * Runner sends this on POST .../journeys/:id/complete as `evidence_checklist` / `iteration_verification`.
 *
 * Types (keys are stable for UI):
 * - page: URL/title/DOM snapshot collected for this step
 * - journey: flow / instructions executed
 * - interactive_elements: buttons/inputs the script targeted
 * - video: per-journey WebM segment on the job (backend also enforces for success)
 * - screenshots: before/after stills per iteration
 */

function boolStatus (ok, detail = '') {
  return { collected: Boolean(ok), detail: detail || (ok ? 'ok' : 'missing') };
}

/**
 * @param {object} params
 * @param {object} params.workflowState
 * @param {object|null} params.leg — current leg / journey object
 * @param {string} params.jobId
 * @param {string} params.legId
 * @returns {object} evidence_checklist payload
 */
export function buildJourneyEvidenceChecklist ({ workflowState, leg, jobId, legId }) {
  const pageInfo = workflowState?.pageAnalysis || workflowState?.lastPageAnalysis || workflowState?.page_analysis || null;
  const iterations = Array.isArray(leg?.iterations) ? leg.iterations : [];
  const lastIter = iterations.length ? iterations[iterations.length - 1] : null;

  const pageOk = !!(pageInfo && (pageInfo.url || pageInfo.final_url || pageInfo.title));
  const elements = pageInfo?.interactive_elements || workflowState?.interactive_elements || [];
  const elementsOk = Array.isArray(elements) && elements.length > 0;

  const shotsOk = iterations.some(
    (it) => it && (it.screenshot_before || it.screenshot_after || (it.screenshots && (it.screenshots.before || it.screenshots.after)))
  ) || !!(lastIter && (lastIter.screenshot_before || lastIter.screenshot_after));

  const videoHint =
    typeof workflowState?.__journeyVideoSegmentsCount === 'number'
      ? workflowState.__journeyVideoSegmentsCount > 0
      : null;

  return {
    page: boolStatus(pageOk, pageOk ? (pageInfo.title || pageInfo.url || '').slice(0, 120) : 'No page analysis object on workflow state'),
    journey: boolStatus(!!(leg?.test_instructions || leg?.description), (leg?.description || leg?.test_instructions || '').slice(0, 200)),
    interactive_elements: boolStatus(elementsOk, elementsOk ? `${elements.length} element(s)` : 'None listed on page analysis'),
    screenshots: boolStatus(shotsOk, shotsOk ? 'At least one iteration has screenshots' : 'No iteration screenshots'),
    video: {
      collected: videoHint === null ? null : videoHint,
      detail:
        videoHint === null
          ? 'Segment count not tracked in workflow state; server enforces job.video_segments anyway'
          : videoHint
            ? 'Runner reported at least one segment for this journey'
            : 'Runner reported zero segments (expect server to block success until fixed)'
    },
    job_id: jobId || null,
    journey_id: leg?.journey_id || legId || null,
    leg_id: leg?.leg_id || null
  };
}

/**
 * Per-iteration checklist after an iteration is persisted (call from while-loop / iteration save).
 * Optional: set process.env.AIONQA_EVIDENCE_VERIFICATION_LLM=1 and implement LLM hook later.
 *
 * @param {object} params
 * @param {number} params.iterationNumber
 * @param {object|null} params.iteration — iteration row
 * @param {object} params.workflowState
 * @returns {object}
 */
export function buildIterationVerificationRow ({ iterationNumber, iteration, workflowState }) {
  const pageInfo = workflowState?.pageAnalysis || workflowState?.lastPageAnalysis || null;
  const hasShot = !!(iteration && (iteration.screenshot_before || iteration.screenshot_after));
  const hasScript = !!(iteration && (iteration.script_id || iteration.script_executed));
  return {
    iteration_number: iterationNumber,
    page_data_present: boolStatus(!!(pageInfo && (pageInfo.url || pageInfo.title)), 'Page snapshot from workflow state'),
    interactive_targets_present: boolStatus(true, 'Refine with element list from iteration if available'),
    screenshots_present: boolStatus(hasShot, hasShot ? 'before/after present' : 'no screenshots on iteration'),
    script_recorded: boolStatus(hasScript, hasScript ? 'script or script_id' : 'no script reference'),
    ai_review: {
      requested: String(process.env.AIONQA_EVIDENCE_VERIFICATION_LLM || '') === '1',
      ok: null,
      summary: 'Set AIONQA_EVIDENCE_VERIFICATION_LLM=1 and wire OpenAI in workflow-analyzer for full AI review'
    }
  };
}
