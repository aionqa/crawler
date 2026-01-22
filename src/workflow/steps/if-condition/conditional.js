/**
 * Execute Conditional Step
 * Evaluates a condition on a response field
 */

export async function executeConditionalStep(step, workflowState, workflowAnalyzer) {
  console.log(`❓ Evaluating condition (${step.name})`);
  
  const field = step.config?.field;
  const operator = step.config?.operator || '==';
  const value = step.config?.value;
  const responseField = step.config?.responseField || 'last_ai_response';
  
  const responseToCheck = workflowState[responseField];
  if (!responseToCheck) {
    console.log(`⚠️ No response to check condition for step: ${step.name}`);
    return;
  }
  
  let conditionMet = false;
  const fieldValue = workflowAnalyzer.getNestedValue(responseToCheck, field);
  
  switch (operator) {
    case '==':
      conditionMet = fieldValue == value;
      break;
    case '!=':
      conditionMet = fieldValue != value;
      break;
    case '>':
      conditionMet = fieldValue > value;
      break;
    case '<':
      conditionMet = fieldValue < value;
      break;
    case 'contains':
      conditionMet = String(fieldValue).includes(String(value));
      break;
    default:
      console.log(`⚠️ Unknown operator: ${operator}`);
  }
  
  console.log(`${conditionMet ? '✅' : '❌'} Condition ${field} ${operator} ${value}: ${conditionMet}`);
  
  // Store condition result
  workflowState[`${step.name}_condition_met`] = conditionMet;
}























































