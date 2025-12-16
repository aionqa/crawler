/**
 * Execute Sleep Step
 * Pauses execution for a specified duration
 */

export async function executeSleepStep(step, workflowState, workflowAnalyzer) {
  console.log(`😴 Sleeping (${step.name})`);
  
  const config = step.config || {};
  const ms = config.ms || 1000;

  if (ms < 0 || ms > 300000) {
    const errorMessage = `Invalid sleep duration "${ms}" in sleep step "${step.name || step.id}". Must be between 0 and 300000ms`;
    const missingPath = 'step.config.ms';
    console.error(`❌ ${errorMessage}`);
    console.error(`❌ Invalid value path: ${missingPath}`);
    console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
    console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
    
    const fullContext = {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: step.type,
      step_config: step.config,
      invalid_value: ms,
      full_step: step
    };
    
    // Note: jobId is not available in executeSleepStep signature, but we can try to get it from workflowState or context
    const effectiveJobId = workflowState.jobId || workflowAnalyzer.context?.jobId;
    if (effectiveJobId && workflowAnalyzer.backendLogger) {
      try {
        await workflowAnalyzer.backendLogger.appendJobLog(effectiveJobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
          ...fullContext,
          invalid_path: missingPath
        });
      } catch (e) {
        console.error(`❌ Failed to log error to backend:`, e.message);
      }
    }
    
    throw new Error(`${errorMessage}\nInvalid value path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
  }

  try {
    await new Promise(resolve => setTimeout(resolve, ms));
    workflowAnalyzer.storeStepResult(step, { duration: ms, slept: true }, workflowState);
    console.log(`✅ Slept for ${ms}ms`);
  } catch (error) {
    console.error(`❌ Sleep step failed: ${error.message}`);
    throw error;
  }
}


