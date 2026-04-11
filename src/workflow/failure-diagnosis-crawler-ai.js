/**
 * Failure-diagnosis "why it failed" answer: runs on the crawler after workflow legs execute,
 * calls the project AI service (same path as other crawler LLM calls), then POSTs structured JSON to the backend.
 */

import axios from 'axios';
import { createOpenAIClient } from '../openai-client-factory.js';

function safeJson(value, maxLen = 24000) {
  try {
    const s = JSON.stringify(value, (k, v) => {
      if (typeof v === 'string' && v.length > 4000) return `${v.slice(0, 4000)}…`;
      return v;
    });
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

const SYSTEM_PROMPT = [
  'You are a senior QA automation engineer. A diagnostic crawl just executed workflow legs on a page after a prior failure.',
  '',
  'You receive JSON with: prior_scan_signals (from the last stored page analysis), page_url, focused_journey_id, focused_leg_id, workflow_id, and this_run_leg_results (execution outcomes from THIS crawl).',
  '',
  'Task: explain WHY the focused journey (or page) failed or what the diagnostic run revealed, in language a developer can act on.',
  '',
  'Rules:',
  '- Ground conclusions in prior_scan_signals and this_run_leg_results; do not invent URLs or errors.',
  '- If the focused journey id is set, anchor the narrative to that journey.',
  '- If evidence is thin, say so and give ranked hypotheses.',
  '',
  'Return STRICT JSON only with keys:',
  'why_failed, root_cause_category (selector_ui_change|auth_session|timing_network|site_defect|test_data|performance|captcha_blocking|ambiguous_unknown),',
  'evidence_bullets (array of string, max 10), recommended_actions (array of string, max 8), confidence (high|medium|low).',
].join('\n');

/**
 * @param {object} deps
 * @param {object} deps.context - Runner job context (project_id, job_id, why_failure, failure_diagnosis_context, …)
 * @param {string} deps.backendUrl
 * @param {() => Record<string,string>} deps.getAuthHeaders
 * @param {{ appendJobLog?: Function } | null} deps.backendLogger
 * @param {string} jobId
 * @param {string} workflowId
 * @param {Array} legResults
 */
export async function runFailureDiagnosisCrawlerAi(deps, jobId, workflowId, legResults) {
  const { context, backendUrl, getAuthHeaders, backendLogger } = deps;
  if (!context?.why_failure && !context?.options?.why_failure) return;

  const projectId = context.project_id || context.projectId;
  if (!projectId || !jobId) {
    console.warn('[failure-diagnosis-crawler-ai] missing project_id or job_id; skip');
    return;
  }

  let priorSignals = String(
    context.failure_diagnosis_context || context?.options?.failure_diagnosis_context || ''
  ).trim();
  const pageUrl = String(context.start_url || context?.options?.start_url || '');
  const focusJ = String(context.failure_focus_journey_id || '');
  const focusL = String(context.failure_focus_leg_id || '');

  if (!priorSignals && backendUrl && getAuthHeaders) {
    try {
      const jr = await axios.get(`${backendUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
        headers: getAuthHeaders(),
        timeout: 15000,
      });
      priorSignals = String(jr.data?.context?.failure_diagnosis_context || '').trim();
    } catch (e) {
      console.warn('[failure-diagnosis-crawler-ai] could not load job for signals:', e.message);
    }
  }

  const userPayload = {
    prior_scan_signals: priorSignals || '(none)',
    page_url: pageUrl,
    focused_journey_id: focusJ || null,
    focused_leg_id: focusL || null,
    workflow_id: workflowId,
    this_run_leg_results: safeJson(legResults || []),
  };

  const aiCtx = {
    ...context,
    project_id: projectId,
    job_id: jobId,
    jobId,
  };

  const client = createOpenAIClient(aiCtx);

  let rawText = '';
  try {
    const resp = await client.chat.completions.create({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
      max_tokens: 2000,
    });
    rawText = (resp?.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    const errMsg = e?.message || String(e);
    console.error('[failure-diagnosis-crawler-ai] AI call failed:', errMsg);
    if (backendLogger?.appendJobLog) {
      await backendLogger.appendJobLog(
        jobId,
        'warn',
        `[Failure diagnosis] AI summary failed: ${errMsg.slice(0, 500)}`,
        'FAILURE-WHY-AI',
        { workflow_id: workflowId }
      );
    }
    await axios
      .post(
        `${backendUrl}/api/jobs/${encodeURIComponent(jobId)}/failure-diagnosis-answer`,
        {
          for_terminal_status: 'workflow_executor',
          answer: {
            why_failed: null,
            error: errMsg.slice(0, 2000),
            raw_text: '',
          },
        },
        { headers: getAuthHeaders(), timeout: 60000 }
      )
      .catch((postErr) => console.error('[failure-diagnosis-crawler-ai] POST error answer failed:', postErr.message));
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { why_failed: rawText.slice(0, 8000) };
  }

  let jobStatus = 'running';
  try {
    const st = await axios.get(`${backendUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
      headers: getAuthHeaders(),
      timeout: 10000,
    });
    jobStatus = String(st.data?.status || 'unknown');
  } catch {
    /* ignore */
  }

  const successPayload = {
    for_terminal_status: jobStatus,
    answer: {
      why_failed: parsed?.why_failed != null ? String(parsed.why_failed) : rawText.slice(0, 8000),
      root_cause_category: parsed?.root_cause_category,
      evidence_bullets: Array.isArray(parsed?.evidence_bullets) ? parsed.evidence_bullets : [],
      recommended_actions: Array.isArray(parsed?.recommended_actions) ? parsed.recommended_actions : [],
      confidence: parsed?.confidence,
      raw_text: rawText.slice(0, 12000),
    },
  };

  try {
    await axios.post(
      `${backendUrl}/api/jobs/${encodeURIComponent(jobId)}/failure-diagnosis-answer`,
      successPayload,
      { headers: getAuthHeaders(), timeout: 60000 }
    );
  } catch (postErr) {
    const detail =
      postErr?.response?.data?.error ||
      postErr?.response?.data?.message ||
      postErr?.message ||
      String(postErr);
    console.error('[failure-diagnosis-crawler-ai] POST success answer failed:', detail);
    try {
      await axios.post(
        `${backendUrl}/api/jobs/${encodeURIComponent(jobId)}/failure-diagnosis-answer`,
        {
          for_terminal_status: jobStatus,
          answer: {
            why_failed: null,
            error: `Failed to save diagnosis summary: ${String(detail).slice(0, 1800)}`,
            raw_text: rawText.slice(0, 12000),
          },
        },
        { headers: getAuthHeaders(), timeout: 60000 }
      );
    } catch (fallbackErr) {
      console.error(
        '[failure-diagnosis-crawler-ai] POST fallback error answer failed:',
        fallbackErr?.message || fallbackErr
      );
    }
  }

  if (backendLogger?.appendJobLog) {
    const preview = String(parsed?.why_failed || rawText).slice(0, 320);
    await backendLogger.appendJobLog(
      jobId,
      'info',
      `[Failure diagnosis] AI explanation posted to job (${preview}…)`,
      'FAILURE-WHY-AI',
      { workflow_id: workflowId }
    );
  }
}
