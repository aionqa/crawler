/**
 * Base Step Executor
 * Provides shared utilities for all step executors
 */

export class BaseStepExecutor {
  constructor(workflowAnalyzer) {
    this.workflowAnalyzer = workflowAnalyzer;
    this.backendUrl = workflowAnalyzer.backendUrl;
    this.aiLogger = workflowAnalyzer.aiLogger;
    this.backendLogger = workflowAnalyzer.backendLogger;
    this.context = workflowAnalyzer.context;
  }

  // Delegate common methods to workflowAnalyzer
  resolvePathValue(source, path, sourceType) {
    return this.workflowAnalyzer.resolvePathValue(source, path, sourceType);
  }

  storeStepResult(step, result, workflowState) {
    return this.workflowAnalyzer.storeStepResult(step, result, workflowState);
  }

  sendLogToBackend(jobId, level, message, component, metadata) {
    return this.workflowAnalyzer.sendLogToBackend(jobId, level, message, component, metadata);
  }

  cleanScript(script) {
    return this.workflowAnalyzer.cleanScript(script);
  }

  initializeVariablePool(workflowState) {
    return this.workflowAnalyzer.initializeVariablePool(workflowState);
  }

  saveVariable(workflowState, name, value, namespace, cycleIndex) {
    return this.workflowAnalyzer.saveVariable(workflowState, name, value, namespace, cycleIndex);
  }

  readVariable(workflowState, name, namespace) {
    return this.workflowAnalyzer.readVariable(workflowState, name, namespace);
  }

  executeStepByType(page, step, workflowState, jobId, stepContext) {
    return this.workflowAnalyzer.executeStepByType(page, step, workflowState, jobId, stepContext);
  }

  getAuthHeaders() {
    return this.workflowAnalyzer.getAuthHeaders();
  }
}


















































