/**
 * Playwright Action Logger - Intercepts and logs Playwright actions in real-time
 * 
 * Wraps Playwright page object methods to log actions (fill, click, type, etc.)
 * as they are executed, providing visibility into what the automation is doing.
 */

import * as backendLogger from './backend-logger.js';

/**
 * Create a wrapped page object that logs all actions
 * @param {Page} page - Original Playwright page object
 * @param {string} jobId - Job ID for logging
 * @returns {Proxy} Wrapped page object with action logging
 */
export function createActionLoggedPage(page, jobId) {
  if (!page || !jobId) {
    return page; // Return original if no logging needed
  }

  // Helper to log an action
  const logAction = async (actionType, details) => {
    try {
      const message = formatActionMessage(actionType, details);
      await backendLogger.appendJobLog(
        jobId,
        'info',
        message,
        'PLAYWRIGHT-ACTION',
        {
          action_type: actionType,
          ...details,
          timestamp: new Date().toISOString()
        }
      );
    } catch (error) {
      // Don't fail script execution if logging fails
      console.warn(`[ActionLogger] Failed to log action: ${error.message}`);
    }
  };

  // Create proxy to intercept method calls
  return new Proxy(page, {
    get(target, prop) {
      const original = target[prop];

      // Intercept common Playwright actions
      if (typeof original === 'function') {
        // Handle locator-based actions (page.locator().fill(), etc.)
        if (prop === 'locator') {
          return function(selector) {
            const locator = original.call(target, selector);
            return createActionLoggedLocator(locator, selector, logAction);
          };
        }

        // Handle direct page actions
        switch (prop) {
          case 'fill':
            return async function(selector, value, options = {}) {
              await logAction('fill', {
                selector,
                value: maskSensitiveValue(value),
                value_length: value?.length || 0
              });
              return original.call(target, selector, value, options);
            };

          case 'click':
            return async function(selector, options = {}) {
              await logAction('click', {
                selector,
                button: options.button || 'left',
                click_count: options.clickCount || 1
              });
              return original.call(target, selector, options);
            };

          case 'type':
            return async function(selector, text, options = {}) {
              await logAction('type', {
                selector,
                text: maskSensitiveValue(text),
                text_length: text?.length || 0,
                delay: options.delay || 0
              });
              return original.call(target, selector, text, options);
            };

          case 'press':
            return async function(selector, key, options = {}) {
              await logAction('press', {
                selector: selector || 'page',
                key
              });
              return original.call(target, selector, key, options);
            };

          case 'selectOption':
            return async function(selector, values, options = {}) {
              await logAction('selectOption', {
                selector,
                values: Array.isArray(values) ? values : [values],
                values_count: Array.isArray(values) ? values.length : 1
              });
              return original.call(target, selector, values, options);
            };

          case 'check':
            return async function(selector, options = {}) {
              await logAction('check', {
                selector
              });
              return original.call(target, selector, options);
            };

          case 'uncheck':
            return async function(selector, options = {}) {
              await logAction('uncheck', {
                selector
              });
              return original.call(target, selector, options);
            };

          case 'goto':
            return async function(url, options = {}) {
              await logAction('goto', {
                url
              });
              return original.call(target, url, options);
            };

          case 'waitForSelector':
            return async function(selector, options = {}) {
              await logAction('waitForSelector', {
                selector,
                state: options.state || 'visible',
                timeout: options.timeout || 30000
              });
              return original.call(target, selector, options);
            };

          case 'waitForTimeout':
            return async function(timeout) {
              await logAction('waitForTimeout', {
                timeout_ms: timeout
              });
              return original.call(target, timeout);
            };

          case 'evaluate':
            return async function(pageFunction, arg) {
              await logAction('evaluate', {
                function_preview: String(pageFunction).substring(0, 200)
              });
              return original.call(target, pageFunction, arg);
            };

          case 'screenshot':
            return async function(options = {}) {
              await logAction('screenshot', {
                full_page: options.fullPage || false,
                path: options.path || null
              });
              return original.call(target, options);
            };

          case 'hover':
            return async function(selector, options = {}) {
              await logAction('hover', {
                selector
              });
              return original.call(target, selector, options);
            };

          case 'focus':
            return async function(selector, options = {}) {
              await logAction('focus', {
                selector
              });
              return original.call(target, selector, options);
            };

          case 'blur':
            return async function(selector, options = {}) {
              await logAction('blur', {
                selector
              });
              return original.call(target, selector, options);
            };

          case 'setInputFiles':
            return async function(selector, files, options = {}) {
              await logAction('setInputFiles', {
                selector,
                files_count: Array.isArray(files) ? files.length : 1,
                file_names: Array.isArray(files) 
                  ? files.map(f => typeof f === 'string' ? f : f.name || 'buffer').slice(0, 3)
                  : [typeof files === 'string' ? files : files.name || 'buffer']
              });
              return original.call(target, selector, files, options);
            };

          case 'waitForNavigation':
            return async function(options = {}) {
              await logAction('waitForNavigation', {
                url: options.url || null,
                waitUntil: options.waitUntil || 'load',
                timeout: options.timeout || 30000
              });
              return original.call(target, options);
            };

          case 'reload':
            return async function(options = {}) {
              await logAction('reload', {
                waitUntil: options.waitUntil || 'load'
              });
              return original.call(target, options);
            };

          case 'goBack':
            return async function(options = {}) {
              await logAction('goBack', {
                waitUntil: options.waitUntil || 'load'
              });
              return original.call(target, options);
            };

          case 'goForward':
            return async function(options = {}) {
              await logAction('goForward', {
                waitUntil: options.waitUntil || 'load'
              });
              return original.call(target, options);
            };

          default:
            // Return original method for non-intercepted methods
            return original;
        }
      }

      // Return original property for non-function properties
      return original;
    }
  });
}

/**
 * Create a wrapped locator that logs actions
 * @param {Locator} locator - Original Playwright locator
 * @param {string} selector - Selector string
 * @param {Function} logAction - Logging function
 * @returns {Proxy} Wrapped locator with action logging
 */
function createActionLoggedLocator(locator, selector, logAction) {
  return new Proxy(locator, {
    get(target, prop) {
      const original = target[prop];

      if (typeof original === 'function') {
        switch (prop) {
          case 'fill':
            return async function(value, options = {}) {
              await logAction('fill', {
                selector,
                value: maskSensitiveValue(value),
                value_length: value?.length || 0
              });
              return original.call(target, value, options);
            };

          case 'click':
            return async function(options = {}) {
              await logAction('click', {
                selector,
                button: options.button || 'left',
                click_count: options.clickCount || 1
              });
              return original.call(target, options);
            };

          case 'type':
            return async function(text, options = {}) {
              await logAction('type', {
                selector,
                text: maskSensitiveValue(text),
                text_length: text?.length || 0,
                delay: options.delay || 0
              });
              return original.call(target, text, options);
            };

          case 'press':
            return async function(key, options = {}) {
              await logAction('press', {
                selector,
                key
              });
              return original.call(target, key, options);
            };

          case 'selectOption':
            return async function(values, options = {}) {
              await logAction('selectOption', {
                selector,
                values: Array.isArray(values) ? values : [values],
                values_count: Array.isArray(values) ? values.length : 1
              });
              return original.call(target, values, options);
            };

          case 'check':
            return async function(options = {}) {
              await logAction('check', {
                selector
              });
              return original.call(target, options);
            };

          case 'uncheck':
            return async function(options = {}) {
              await logAction('uncheck', {
                selector
              });
              return original.call(target, options);
            };

          case 'hover':
            return async function(options = {}) {
              await logAction('hover', {
                selector
              });
              return original.call(target, options);
            };

          case 'focus':
            return async function(options = {}) {
              await logAction('focus', {
                selector
              });
              return original.call(target, options);
            };

          case 'setInputFiles':
            return async function(files, options = {}) {
              await logAction('setInputFiles', {
                selector,
                files_count: Array.isArray(files) ? files.length : 1,
                file_names: Array.isArray(files) 
                  ? files.map(f => typeof f === 'string' ? f : f.name || 'buffer').slice(0, 3)
                  : [typeof files === 'string' ? files : files.name || 'buffer']
              });
              return original.call(target, files, options);
            };

          default:
            // Return original method for non-intercepted methods
            return original;
        }
      }

      return original;
    }
  });
}

/**
 * Format action message for display
 * @param {string} actionType - Type of action
 * @param {object} details - Action details
 * @returns {string} Formatted message
 */
function formatActionMessage(actionType, details) {
  const actionEmojis = {
    fill: '✍️',
    click: '🖱️',
    type: '⌨️',
    press: '⌨️',
    selectOption: '📋',
    check: '☑️',
    uncheck: '☐',
    goto: '🌐',
    waitForSelector: '⏳',
    waitForTimeout: '⏸️',
    evaluate: '🔍',
    screenshot: '📸',
    hover: '👆',
    focus: '🎯',
    blur: '👋',
    setInputFiles: '📁',
    waitForNavigation: '⏳',
    reload: '🔄',
    goBack: '⬅️',
    goForward: '➡️'
  };

  const emoji = actionEmojis[actionType] || '⚙️';
  const selector = details.selector || 'page';
  
  switch (actionType) {
    case 'fill':
      return `${emoji} Filling field "${selector}" with ${details.value_length} characters`;
    
    case 'click':
      const clickInfo = details.click_count > 1 ? ` (${details.click_count}x)` : '';
      return `${emoji} Clicking "${selector}"${clickInfo}`;
    
    case 'type':
      return `${emoji} Typing ${details.text_length} characters into "${selector}"`;
    
    case 'press':
      return `${emoji} Pressing key "${details.key}" on "${selector}"`;
    
    case 'selectOption':
      return `${emoji} Selecting option(s) in "${selector}" (${details.values_count} value(s))`;
    
    case 'check':
      return `${emoji} Checking checkbox "${selector}"`;
    
    case 'uncheck':
      return `${emoji} Unchecking checkbox "${selector}"`;
    
    case 'goto':
      return `${emoji} Navigating to "${details.url}"`;
    
    case 'waitForSelector':
      return `${emoji} Waiting for selector "${selector}" (state: ${details.state})`;
    
    case 'waitForTimeout':
      return `${emoji} Waiting ${details.timeout_ms}ms`;
    
    case 'evaluate':
      return `${emoji} Evaluating JavaScript on page`;
    
    case 'screenshot':
      return `${emoji} Taking screenshot${details.full_page ? ' (full page)' : ''}`;
    
    case 'hover':
      return `${emoji} Hovering over "${selector}"`;
    
    case 'focus':
      return `${emoji} Focusing on "${selector}"`;
    
    case 'blur':
      return `${emoji} Blurring "${selector}"`;
    
    case 'setInputFiles':
      return `${emoji} Uploading ${details.files_count} file(s) to "${selector}"`;
    
    case 'waitForNavigation':
      return `${emoji} Waiting for navigation${details.url ? ` to "${details.url}"` : ''}`;
    
    case 'reload':
      return `${emoji} Reloading page`;
    
    case 'goBack':
      return `${emoji} Going back in history`;
    
    case 'goForward':
      return `${emoji} Going forward in history`;
    
    default:
      return `${emoji} ${actionType} on "${selector}"`;
  }
}

/**
 * Mask sensitive values (passwords, etc.)
 * @param {string} value - Value to mask
 * @returns {string} Masked value
 */
function maskSensitiveValue(value) {
  if (!value || typeof value !== 'string') {
    return value;
  }
  
  // Check if it looks like a password (common patterns)
  const passwordPatterns = [
    /password/i,
    /passwd/i,
    /pwd/i,
    /secret/i,
    /token/i,
    /api[_-]?key/i,
    /auth[_-]?token/i
  ];
  
  // If selector or context suggests password, mask it
  // We'll mask if value is longer than 8 chars (likely password)
  if (value.length > 8) {
    return '***' + value.substring(value.length - 2);
  }
  
  return value;
}


























































