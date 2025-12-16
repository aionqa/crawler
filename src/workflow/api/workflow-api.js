/**
 * Workflow API Endpoints for Crawler
 * Provides HTTP endpoints for each workflow step type
 * Called by backend to execute individual workflow steps
 */

import express from 'express';
import {
  executeAiRequest,
  executeScreenshot,
  executePlaywrightAnalysis,
  executeCode,
  executeConditional,
  executeValidateResponse,
  executeFilterReplace,
  executeLogToHistory,
  executeSkipToNextPage,
  executeStopJob
} from './workflow-functions.js';

const router = express.Router();

// Middleware to get current page from runner context
const getCurrentPage = (req, res, next) => {
  // This would be injected by the runner when setting up the API
  req.page = global.currentPage;
  if (!req.page) {
    return res.status(500).json({
      success: false,
      error: 'No active page context available'
    });
  }
  next();
};

// Apply middleware to all routes
router.use(getCurrentPage);

/**
 * AI Request endpoint
 */
router.post('/api/workflow/ai-request', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeAiRequest(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Screenshot endpoint
 */
router.post('/api/workflow/screenshot', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeScreenshot(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Playwright Analysis endpoint
 */
router.post('/api/workflow/playwright-analysis', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executePlaywrightAnalysis(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Execute Code endpoint
 */
router.post('/api/workflow/execute-code', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeCode(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Conditional endpoint
 */
router.post('/api/workflow/conditional', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeConditional(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Validate Response endpoint
 */
router.post('/api/workflow/validate-response', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeValidateResponse(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Filter & Replace endpoint
 */
router.post('/api/workflow/filter-replace', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeFilterReplace(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Log to History endpoint
 */
router.post('/api/workflow/log-to-history', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeLogToHistory(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Skip to Next Page endpoint
 */
router.post('/api/workflow/skip-to-next-page', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeSkipToNextPage(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Stop Job endpoint
 */
router.post('/api/workflow/stop-job', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeStopJob(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Legacy endpoints for backward compatibility
router.post('/api/workflow/ai-prompt', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeAiRequest(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/workflow/filter-response', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    const result = await executeFilterReplace(req.page, jobId, stepId, parameters, context);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;


