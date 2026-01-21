/**
 * Execute Filter Response Step
 * Filters a response using a filter expression
 */

export async function executeFilterResponseStep(step, workflowState, workflowAnalyzer) {
  console.log(`🔍 Filtering response (${step.name})`);
  
  const responseToFilter = workflowState[step.config?.responseField || 'last_ai_response'];
  const filter = step.config?.filter;
  
  if (!responseToFilter || !filter) {
    console.log(`⚠️ No response or filter to apply for step: ${step.name}`);
    return;
  }
  
  // Basic filtering logic - can be enhanced with jq-like syntax
  try {
    const filteredResponse = workflowAnalyzer.applyFilter(responseToFilter, filter);
    workflowState[`${step.name}_filtered`] = filteredResponse;
    console.log(`✅ Response filtered successfully`);
  } catch (error) {
    console.error(`❌ Response filtering failed: ${error.message}`);
    throw error;
  }
}


















































