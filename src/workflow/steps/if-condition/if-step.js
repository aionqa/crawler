/**
 * Execute If Step
 * Conditionally executes nested steps based on a condition
 */

export async function executeIfStep(page, step, workflowState, jobId, workflowAnalyzer) {
  console.log(`🔀 Executing if-step (${step.name})`);
  
  // Send log to backend
  await workflowAnalyzer.sendLogToBackend(jobId, 'info', `🔀 Executing if-step (${step.name})`, 'WORKFLOW-ANALYZER', {
    step_id: step.id,
    step_name: step.name || step.type,
    step_type: 'if-step'
  });
  
  const config = step.config || {};
  const conditionCode = config.conditionCode; // JavaScript code that returns boolean
  const conditionPath = config.conditionPath; // Path to check for condition value
  const conditionType = config.conditionType || 'code'; // 'code', 'path', or 'ai-response'
  const nestedSteps = config.steps || [];
  const elseSteps = config.elseSteps || []; // Optional else branch
  
  // Validate required fields based on conditionType
  if (conditionType === 'code' && !conditionCode) {
    const errorMessage = `Missing required field "conditionCode" in if-step "${step.name || step.id}" (conditionType is "code")`;
    const missingPath = 'step.config.conditionCode';
    console.error(`❌ ${errorMessage}`);
    console.error(`❌ Missing JSON path: ${missingPath}`);
    console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
    console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
    
    const fullContext = {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: step.type,
      step_config: step.config,
      conditionType: conditionType,
      full_step: step
    };
    
    if (jobId && workflowAnalyzer.backendLogger) {
      try {
        await workflowAnalyzer.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
          ...fullContext,
          missing_path: missingPath
        });
      } catch (e) {
        console.error(`❌ Failed to log error to backend:`, e.message);
      }
    }
    
    throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
  }
  
  if ((conditionType === 'path' || conditionType === 'ai-response') && !conditionPath) {
    const errorMessage = `Missing required field "conditionPath" in if-step "${step.name || step.id}" (conditionType is "${conditionType}")`;
    const missingPath = 'step.config.conditionPath';
    console.error(`❌ ${errorMessage}`);
    console.error(`❌ Missing JSON path: ${missingPath}`);
    console.error(`❌ Full step:`, JSON.stringify(step, null, 2));
    console.error(`❌ Step config:`, JSON.stringify(step.config, null, 2));
    
    const fullContext = {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: step.type,
      step_config: step.config,
      conditionType: conditionType,
      full_step: step
    };
    
    if (jobId && workflowAnalyzer.backendLogger) {
      try {
        await workflowAnalyzer.backendLogger.appendJobLog(jobId, 'error', errorMessage, 'WORKFLOW-ANALYZER', {
          ...fullContext,
          missing_path: missingPath
        });
      } catch (e) {
        console.error(`❌ Failed to log error to backend:`, e.message);
      }
    }
    
    throw new Error(`${errorMessage}\nMissing JSON path: ${missingPath}\nFull step: ${JSON.stringify(step, null, 2)}`);
  }
  
  if (!nestedSteps.length) {
    console.log(`⚠️ If-step has no nested steps`);
    return;
  }
  
  let condition = false;
  
  try {
    // Evaluate condition
    if (conditionType === 'code' && conditionCode) {
      // Clean the code before execution
      let cleanedCode = workflowAnalyzer.cleanScript(conditionCode);
      if (!cleanedCode || cleanedCode.trim().length === 0) {
        throw new Error('Condition code is empty after cleaning');
      }
      // Execute code to get condition
      const conditionResult = await page.evaluate(
        ({ code, workflowState }) => {
          const runner = new Function('workflowState', `return (${code});`);
          return runner(workflowState);
        },
        { code: cleanedCode, workflowState }
      );
      condition = conditionResult === true || conditionResult === 'true' || conditionResult === 1;
      
    } else if (conditionType === 'path' || conditionType === 'ai-response') {
      // Get condition from workflowState path
      const conditionValue = workflowAnalyzer.resolvePathValue(workflowState, conditionPath || 'determine_completion.is_complete', 'results');
      
      if (conditionValue !== undefined && conditionValue !== null) {
        condition = conditionValue === true || conditionValue === 'true' || conditionValue === 1 || conditionValue === 'complete';
      }
    }
    
    console.log(`🔀 Condition evaluated: ${condition}`);
    
    // Send log to backend
    await workflowAnalyzer.sendLogToBackend(jobId, 'info', `🔀 Condition evaluated: ${condition}`, 'WORKFLOW-ANALYZER', {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: 'if-step',
      condition: condition,
      condition_type: conditionType
    });
    
    // Execute appropriate branch
    const stepsToExecute = condition ? nestedSteps : elseSteps;
    
    if (stepsToExecute.length > 0) {
      for (let nestedIdx = 0; nestedIdx < stepsToExecute.length; nestedIdx++) {
        const nestedStep = stepsToExecute[nestedIdx];
        
        try {
          await workflowAnalyzer.executeStepByType(page, nestedStep, workflowState, jobId, {
            stepIndex: nestedIdx,
            siblings: stepsToExecute
          });
        } catch (nestedError) {
          console.error(`❌ Nested step ${nestedIdx + 1} failed in if-step: ${nestedError.message}`);
          if (nestedStep.config?.critical) {
            throw nestedError;
          }
        }
      }
    }
    
    const result = {
      condition,
      conditionType,
      executedBranch: condition ? 'then' : 'else',
      stepsExecuted: stepsToExecute.length
    };
    
    workflowAnalyzer.storeStepResult(step, result, workflowState);
    console.log(`✅ If-step completed: executed ${condition ? 'then' : 'else'} branch (${stepsToExecute.length} steps)`);
    
    // Send log to backend
    await workflowAnalyzer.sendLogToBackend(jobId, 'info', `✅ If-step completed: executed ${condition ? 'then' : 'else'} branch (${stepsToExecute.length} steps)`, 'WORKFLOW-ANALYZER', {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: 'if-step',
      condition: condition,
      executed_branch: condition ? 'then' : 'else',
      steps_executed: stepsToExecute.length
    });
    
  } catch (error) {
    console.error(`❌ If-step failed: ${error.message}`);
    
    // Send error log to backend
    await workflowAnalyzer.sendLogToBackend(jobId, 'error', `❌ If-step failed: ${error.message}`, 'WORKFLOW-ANALYZER', {
      step_id: step.id,
      step_name: step.name || step.type,
      step_type: 'if-step',
      error: error.message
    });
    
    throw error;
  }
}


