/**
 * Modal Path Notation Utility
 * 
 * Implements path notation for modal and multi-step workflows as per rule 55.
 * Format: {base_url}.{action1}.{page2}.{action2}.{page3}...
 * 
 * Example: https://example.com/path.button1.page2.fill-form.submit
 */

/**
 * Generate path notation for an action
 * @param {string} baseUrl - Base page URL
 * @param {Array} actionChain - Array of {action: string, page?: string} objects
 * @returns {string} Path notation string
 */
export function generateModalPath(baseUrl, actionChain = []) {
  if (!baseUrl) {
    throw new Error('Base URL is required');
  }
  
  // Normalize base URL (remove trailing slash, hash, query params for base)
  const normalizedBase = baseUrl.split('#')[0].split('?')[0].replace(/\/$/, '');
  
  const parts = [normalizedBase];
  
  for (const step of actionChain) {
    if (step.action) {
      // Sanitize action name (remove spaces, special chars)
      const actionName = sanitizePathComponent(step.action);
      parts.push(actionName);
    }
    
    if (step.page) {
      // Sanitize page name
      const pageName = sanitizePathComponent(step.page);
      parts.push(pageName);
    }
  }
  
  return parts.join('.');
}

/**
 * Parse path notation into components
 * @param {string} pathNotation - Path notation string
 * @returns {Object} {baseUrl: string, steps: Array}
 */
export function parseModalPath(pathNotation) {
  if (!pathNotation || typeof pathNotation !== 'string') {
    return { baseUrl: '', steps: [] };
  }
  
  // Split by dots, but preserve URL structure
  // URL contains dots, so we need to detect where URL ends
  const urlMatch = pathNotation.match(/^https?:\/\/[^\s]+/);
  if (!urlMatch) {
    // No valid URL found, treat entire string as base
    return { baseUrl: pathNotation, steps: [] };
  }
  
  const baseUrl = urlMatch[0];
  const remaining = pathNotation.substring(baseUrl.length);
  
  // Remove leading dot if present
  const stepsStr = remaining.startsWith('.') ? remaining.substring(1) : remaining;
  
  // Split remaining by dots
  const stepParts = stepsStr ? stepsStr.split('.') : [];
  
  // Group into action/page pairs
  const steps = [];
  for (let i = 0; i < stepParts.length; i += 2) {
    const step = {
      action: stepParts[i] || null
    };
    
    if (i + 1 < stepParts.length) {
      step.page = stepParts[i + 1];
    }
    
    steps.push(step);
  }
  
  return {
    baseUrl,
    steps
  };
}

/**
 * Append action to existing path
 * @param {string} existingPath - Current path notation
 * @param {string} action - Action name to append
 * @param {string} page - Optional page name
 * @returns {string} Updated path notation
 */
export function appendToModalPath(existingPath, action, page = null) {
  const parsed = parseModalPath(existingPath);
  const newStep = { action };
  if (page) {
    newStep.page = page;
  }
  parsed.steps.push(newStep);
  return generateModalPath(parsed.baseUrl, parsed.steps);
}

/**
 * Get parent path (remove last step)
 * @param {string} pathNotation - Current path notation
 * @returns {string} Parent path notation
 */
export function getParentModalPath(pathNotation) {
  const parsed = parseModalPath(pathNotation);
  if (parsed.steps.length === 0) {
    return parsed.baseUrl;
  }
  
  parsed.steps.pop();
  return generateModalPath(parsed.baseUrl, parsed.steps);
}

/**
 * Sanitize path component (action or page name)
 * @param {string} component - Component name
 * @returns {string} Sanitized name
 */
function sanitizePathComponent(component) {
  if (!component) {
    return '';
  }
  
  // Replace spaces and special chars with hyphens
  // Keep alphanumeric, hyphens, underscores
  return component
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extract action name from element
 * @param {Object} element - Interactive element
 * @returns {string} Action identifier
 */
export function getActionNameFromElement(element) {
  if (!element) {
    return 'action';
  }
  
  // Priority: id > text > selector > type
  if (element.id) {
    return element.id;
  }
  
  if (element.text && element.text.trim()) {
    return element.text.trim().substring(0, 50);
  }
  
  if (element.selector) {
    // Extract meaningful part from selector
    const match = element.selector.match(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)\]|:has-text\(["']([^"']+)["']\)/);
    if (match) {
      return match[1] || match[2] || match[3] || match[4] || 'element';
    }
  }
  
  if (element.type) {
    return element.type;
  }
  
  return 'action';
}

/**
 * Extract page/screen name from modal
 * @param {Object} modalInfo - Modal information
 * @param {number} stepNumber - Step number if multi-step
 * @returns {string} Page identifier
 */
export function getPageNameFromModal(modalInfo, stepNumber = null) {
  if (!modalInfo) {
    return stepNumber ? `step${stepNumber}` : 'modal';
  }
  
  // Priority: step name > modal id > modal class > step number
  if (modalInfo.currentStep && modalInfo.currentStep.name) {
    return sanitizePathComponent(modalInfo.currentStep.name);
  }
  
  if (modalInfo.modalId) {
    return sanitizePathComponent(modalInfo.modalId);
  }
  
  if (modalInfo.modalClass) {
    const firstClass = modalInfo.modalClass.split(/\s+/)[0];
    return sanitizePathComponent(firstClass);
  }
  
  if (stepNumber !== null) {
    return `step${stepNumber}`;
  }
  
  return 'modal';
}

export default {
  generateModalPath,
  parseModalPath,
  appendToModalPath,
  getParentModalPath,
  getActionNameFromElement,
  getPageNameFromModal
};











