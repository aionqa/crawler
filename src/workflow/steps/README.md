# Workflow Step Executors

This directory contains step execution logic split by functionality.

## Structure

- `ai-prompt/` - AI prompt step execution
- `if-condition/` - If/conditional step execution  
- `for-each/` - For-each loop execution
- `while-loop/` - While loop execution
- `code-execution/` - Code execution steps
- `page-analysis/` - Page analysis steps
- `data-persistence/` - Data saving steps
- `cookies/` - Cookie operations
- `validation/` - Response validation
- `utilities/` - Utility steps (print, sleep, etc.)
- `workflow-management/` - Workflow creation/update
- `configuration/` - Configuration steps

## Base Class

All step executors extend `BaseStepExecutor` which provides:
- Access to workflowAnalyzer instance
- Common utility methods (resolvePathValue, storeStepResult, etc.)
- Logging helpers

## Pattern

Each step executor file exports a function:
```javascript
export async function executeStepType(page, step, workflowState, jobId, workflowAnalyzer) {
  // Step execution logic
}
```

The workflow-analyzer.js imports and calls these functions.
