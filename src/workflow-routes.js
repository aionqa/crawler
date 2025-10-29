import express from 'express';
import { WorkflowStepExecutor } from './workflow-step-executor.js';

const router = express.Router();

// Initialize workflow step executor
const workflowExecutor = new WorkflowStepExecutor();

// Middleware for parsing JSON
router.use(express.json());

// Middleware for logging requests
router.use((req, res, next) => {
  console.log(`[WORKFLOW-API] ${req.method} ${req.path} - Job: ${req.body?.jobId || 'unknown'}`);
  next();
});

// Core Workflow Steps

/**
 * Screenshot Step
 * POST /api/workflow/screenshot
 */
router.post('/screenshot', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeScreenshotStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Screenshot step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'SCREENSHOT_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Playwright Analysis Step
 * POST /api/workflow/playwright-analysis
 */
router.post('/playwright-analysis', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executePlaywrightAnalysisStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Playwright analysis step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'PLAYWRIGHT_ANALYSIS_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Page Description Step
 * POST /api/workflow/page-description
 */
router.post('/page-description', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executePageDescriptionStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Page description step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'PAGE_DESCRIPTION_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Workflow Analysis Step
 * POST /api/workflow/workflow-analysis
 */
router.post('/workflow-analysis', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeWorkflowAnalysisStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Workflow analysis step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'WORKFLOW_ANALYSIS_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Execute Code Step
 * POST /api/workflow/execute-code
 */
router.post('/execute-code', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeCodeStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Execute code step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'EXECUTE_CODE_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Collect Elements Step
 * POST /api/workflow/collect-elements
 */
router.post('/collect-elements', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeCollectElementsStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Collect elements step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'COLLECT_ELEMENTS_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

// Workflow Management Steps

/**
 * Create Workflow Step
 * POST /api/workflow/create-workflow
 */
router.post('/create-workflow', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeCreateWorkflowStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Create workflow step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'CREATE_WORKFLOW_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Update Workflow Step
 * POST /api/workflow/update-workflow
 */
router.post('/update-workflow', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeUpdateWorkflowStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Update workflow step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'UPDATE_WORKFLOW_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Page Discovery Step
 * POST /api/workflow/page-discovery
 */
router.post('/page-discovery', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executePageDiscoveryStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Page discovery step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'PAGE_DISCOVERY_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

// AI Operations

/**
 * AI Prompt Step
 * POST /api/workflow/ai-prompt
 */
router.post('/ai-prompt', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeAIPromptStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] AI prompt step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'AI_PROMPT_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

// Control Flow Steps

/**
 * Cycle Start Step
 * POST /api/workflow/cycle-start
 */
router.post('/cycle-start', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeCycleStartStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Cycle start step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'CYCLE_START_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Cycle End Step
 * POST /api/workflow/cycle-end
 */
router.post('/cycle-end', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeCycleEndStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Cycle end step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'CYCLE_END_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Conditional Step
 * POST /api/workflow/conditional
 */
router.post('/conditional', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeConditionalStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Conditional step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'CONDITIONAL_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

// Validation Steps

/**
 * Validate Response Step
 * POST /api/workflow/validate-response
 */
router.post('/validate-response', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeValidateResponseStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Validate response step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'VALIDATE_RESPONSE_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

/**
 * Filter Response Step
 * POST /api/workflow/filter-response
 */
router.post('/filter-response', async (req, res) => {
  try {
    const { jobId, stepId, parameters, context } = req.body;
    
    if (!jobId || !stepId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMETERS', message: 'jobId and stepId are required' }
      });
    }

    const result = await workflowExecutor.executeFilterResponseStep(jobId, stepId, parameters, context);
    
    res.json({
      success: true,
      stepId,
      jobId,
      result,
      error: null,
      executionTime: result.executionTime || 0
    });
  } catch (error) {
    console.error(`[WORKFLOW-API] Filter response step failed:`, error);
    res.json({
      success: false,
      stepId: req.body.stepId,
      jobId: req.body.jobId,
      result: null,
      error: {
        code: 'FILTER_RESPONSE_FAILED',
        message: error.message,
        details: { stack: error.stack }
      },
      executionTime: 0
    });
  }
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'workflow-api',
    timestamp: new Date().toISOString()
  });
});

export default router;
