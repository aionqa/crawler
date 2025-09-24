/**
 * Utility functions for unified crawler
 */

/**
 * Creates a standardized success response
 */
export function createSuccessResponse(data, id = null) {
  return {
    jsonrpc: "2.0",
    result: {
      success: true,
      ...data
    },
    id
  };
}

/**
 * Creates a standardized error response
 */
export function createErrorResponse(error, id = null) {
  return {
    jsonrpc: "2.0",
    error: {
      code: error.code || -32603,
      message: error.message || 'Internal error',
      data: error.details || error
    },
    id
  };
}

/**
 * Generates potential actions for AI analysis
 */
export function generatePotentialActions(pageState) {
  const actions = [];
  
  // Add form-based actions
  if (pageState.forms && pageState.forms.length > 0) {
    actions.push({
      type: 'form_submission',
      description: 'Submit login form',
      confidence: 0.8
    });
  }
  
  // Add link-based actions
  if (pageState.links && pageState.links.length > 0) {
    actions.push({
      type: 'link_click',
      description: 'Click on navigation links',
      confidence: 0.6
    });
  }
  
  // Add button-based actions
  if (pageState.buttons && pageState.buttons.length > 0) {
    actions.push({
      type: 'button_click',
      description: 'Click on interactive buttons',
      confidence: 0.7
    });
  }
  
  return actions;
}

/**
 * Validates mode parameter
 */
export function validateMode(mode) {
  const validModes = ['auto', 'media', 'text', 'forms', 'static', 'script'];
  return validModes.includes(mode);
}

/**
 * Gets mode description
 */
export function getModeDescription(mode) {
  const descriptions = {
    auto: 'AI-driven approach with automatic mode selection',
    media: 'Screenshot analysis with AI vision capabilities',
    text: 'HTML text analysis with AI language processing',
    forms: 'Form field analysis using Playwright selectors',
    static: 'Standard field ID matching for common patterns',
    script: 'Custom script execution for advanced scenarios'
  };
  
  return descriptions[mode] || 'Unknown mode';
}

/**
 * Sanitizes HTML content for AI analysis
 */
export function sanitizeHtmlContent(html, maxLength = 10000) {
  // Remove script tags and their content
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  
  // Remove style tags and their content
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  
  // Remove comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  
  // Truncate if too long
  if (html.length > maxLength) {
    html = html.substring(0, maxLength) + '...[truncated]';
  }
  
  return html;
}

/**
 * Extracts form data from page
 */
export async function extractFormData(page) {
  try {
    const forms = await page.$$eval('form', forms => forms.map((form, index) => ({
      index,
      action: form.action,
      method: form.method,
      inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
        type: input.type,
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        required: input.required,
        value: input.value
      })),
      buttons: Array.from(form.querySelectorAll('button, input[type="submit"]')).map(button => ({
        text: button.textContent?.trim() || button.value,
        type: button.type,
        id: button.id,
        name: button.name
      }))
    })));
    
    return { forms, success: true };
  } catch (error) {
    return { forms: [], success: false, error: error.message };
  }
}

/**
 * Extracts link data from page
 */
export async function extractLinkData(page) {
  try {
    const links = await page.$$eval('a[href]', links => links.map(link => ({
      text: link.textContent?.trim(),
      href: link.href,
      title: link.title,
      target: link.target
    })));
    
    return { links, success: true };
  } catch (error) {
    return { links: [], success: false, error: error.message };
  }
}

/**
 * Extracts button data from page
 */
export async function extractButtonData(page) {
  try {
    const buttons = await page.$$eval('button, input[type="button"], input[type="submit"]', buttons => buttons.map(button => ({
      text: button.textContent?.trim() || button.value,
      type: button.type,
      id: button.id,
      name: button.name,
      className: button.className
    })));
    
    return { buttons, success: true };
  } catch (error) {
    return { buttons: [], success: false, error: error.message };
  }
}

/**
 * Creates a standardized page state object
 */
export async function createPageState(page) {
  const [forms, links, buttons] = await Promise.all([
    extractFormData(page),
    extractLinkData(page),
    extractButtonData(page)
  ]);
  
  return {
    url: page.url(),
    title: await page.title(),
    forms: forms.forms,
    links: links.links,
    buttons: buttons.buttons,
    timestamp: new Date().toISOString()
  };
}

/**
 * Logs operation with structured format
 */
export function logOperation(level, operation, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    operation,
    message,
    data
  };
  
  console.log(`[${level.toUpperCase()}] [${operation}] ${message}`, data);
  return logEntry;
}

/**
 * Retries an operation with exponential backoff
 */
export async function retryOperation(operation, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Validates URL format
 */
export function validateUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts domain from URL
 */
export function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Creates a unique job ID
 */
export function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Formats duration in milliseconds to human readable format
 */
export function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    return `${(ms / 60000).toFixed(1)}m`;
  }
}

/**
 * Creates a standardized error object
 */
export function createError(code, message, details = {}) {
  return {
    code,
    message,
    details,
    timestamp: new Date().toISOString()
  };
}

/**
 * Validates credentials object
 */
export function validateCredentials(credentials) {
  if (!credentials) {
    return { valid: false, error: 'Credentials object is required' };
  }
  
  if (!credentials.username) {
    return { valid: false, error: 'Username is required' };
  }
  
  if (!credentials.password) {
    return { valid: false, error: 'Password is required' };
  }
  
  return { valid: true };
}

/**
 * Sanitizes credentials for logging
 */
export function sanitizeCredentials(credentials) {
  if (!credentials) {
    return null;
  }
  
  return {
    username: credentials.username,
    password: credentials.password ? '*'.repeat(credentials.password.length) : 'Not provided'
  };
}
