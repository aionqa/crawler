const FALLBACK_REQUIREMENTS = {
  'workflow-analysis': () =>
    [
      'Return a JSON object containing a "legs" array of interactions to execute.',
      'Each leg should include at minimum: leg_id, description, type, selector or element_info, and expected_outcome.'
    ],
  'execute-code': (step) => {
    if (step?.config?.sourceField) {
      return [
        `Populate the workflow state key referenced by "${step.config.sourceField}" with the data needed for script execution.`
      ];
    }
    return [
      'Return a JSON object that exposes the fields referenced by the upcoming execute-code step.',
      'Include any Playwright scripts or structured data the code expects to read from workflowState.'
    ];
  },
  'validate-response': () => [
    'Return a JSON object that matches the schema expected by the upcoming validation step.'
  ],
  'validate-login': () => [
    'Provide login execution results, including success flag, message, and any credential/session details required for validation.'
  ]
};

const SECTION_HEADING = 'Requirements enforced by the next workflow step (non-editable)';

export function getRequirementTextForNextStep(nextStep) {
  if (!nextStep) {
    return null;
  }

  const explicit = Array.isArray(nextStep.config?.input_requirements)
    ? nextStep.config.input_requirements.filter(Boolean)
    : [];

  if (explicit.length > 0) {
    return formatRequirementText(explicit);
  }

  const fallback = FALLBACK_REQUIREMENTS[nextStep.type];
  if (typeof fallback === 'function') {
    return formatRequirementText(fallback(nextStep) || []);
  }

  return null;
}

export function formatRequirementText(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return null;
  }

  const bulletList = lines
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');

  if (!bulletList.trim()) {
    return null;
  }

  return `${SECTION_HEADING}\n${bulletList}`;
}

export function appendRequirementToTemplate(template, requirementText) {
  if (!requirementText) {
    return template;
  }

  const trimmedTemplate = (template || '').trimEnd();
  const divider = trimmedTemplate.endsWith('\n') ? '' : '\n\n';

  return `${trimmedTemplate}${divider}---\n${requirementText}\n---`;
}





