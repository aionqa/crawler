/**
 * Modal Detection Utility
 * 
 * Detects modals/dialogs that appear after action execution and analyzes their content
 * to create sub-legs for modal interactions (rule 55).
 */

/**
 * Detect if a modal/dialog is currently visible on the page
 * @param {Page} page - Playwright page object
 * @returns {Promise<Object|null>} Modal info or null if no modal detected
 */
export async function detectModal(page) {
  try {
    const modalInfo = await page.evaluate(() => {
      // Common modal/dialog selectors
      const modalSelectors = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '.modal',
        '.modal-dialog',
        '.modal-content',
        '.dialog',
        '.popup',
        '.overlay',
        '[class*="modal"]',
        '[class*="dialog"]',
        '[class*="popup"]',
        '[id*="modal"]',
        '[id*="dialog"]',
        '[id*="popup"]',
        'dialog', // HTML5 dialog element
        '[data-modal]',
        '[data-dialog]'
      ];
      
      // Find visible modal
      for (const selector of modalSelectors) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const element of elements) {
            // Check if element is visible
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            
            if (style.display !== 'none' && 
                style.visibility !== 'hidden' && 
                style.opacity !== '0' &&
                rect.width > 0 && 
                rect.height > 0) {
              
              // Get modal information
              const modalId = element.id || null;
              const modalClass = element.className || '';
              const modalText = element.innerText?.trim().substring(0, 200) || '';
              
              // Find all interactive elements inside modal
              const interactiveElements = [];
              const buttons = element.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]');
              const inputs = element.querySelectorAll('input, textarea, select');
              const forms = element.querySelectorAll('form');
              
              buttons.forEach((btn, idx) => {
                const text = btn.textContent?.trim() || btn.value || '';
                const id = btn.id || '';
                const role = btn.getAttribute('role') || '';
                const type = btn.type || '';
                
                interactiveElements.push({
                  type: 'button',
                  text: text.substring(0, 100),
                  id: id,
                  selector: id ? `#${id}` : (text ? `button:has-text("${text.substring(0, 30)}")` : `button:nth-of-type(${idx + 1})`),
                  role: role,
                  buttonType: type
                });
              });
              
              inputs.forEach((input, idx) => {
                const type = input.type || 'text';
                const name = input.name || '';
                const id = input.id || '';
                const placeholder = input.placeholder || '';
                
                if (type !== 'submit' && type !== 'button') {
                  interactiveElements.push({
                    type: 'input',
                    inputType: type,
                    name: name,
                    id: id,
                    selector: id ? `#${id}` : (name ? `input[name="${name}"]` : `input[type="${type}"]:nth-of-type(${idx + 1})`),
                    placeholder: placeholder
                  });
                }
              });
              
              // Detect multi-step indicators
              const stepIndicators = element.querySelectorAll('[class*="step"], [class*="wizard"], [class*="stepper"], [data-step]');
              const isMultiStep = stepIndicators.length > 0;
              
              // Get current step if multi-step
              let currentStep = null;
              if (isMultiStep) {
                const activeStep = element.querySelector('[class*="active"], [class*="current"], [data-step][class*="active"]');
                if (activeStep) {
                  currentStep = {
                    number: parseInt(activeStep.getAttribute('data-step') || activeStep.textContent?.match(/\d+/)?.[0] || '1'),
                    name: activeStep.textContent?.trim().substring(0, 50) || `step${activeStep.getAttribute('data-step') || '1'}`
                  };
                }
              }
              
              return {
                detected: true,
                selector: selector,
                modalId: modalId,
                modalClass: modalClass,
                modalText: modalText,
                interactiveElements: interactiveElements,
                forms: Array.from(forms).map((form, idx) => ({
                  id: form.id || `form_${idx}`,
                  action: form.action || '',
                  method: form.method || 'get',
                  fields: Array.from(form.querySelectorAll('input, textarea, select')).length
                })),
                isMultiStep: isMultiStep,
                currentStep: currentStep,
                totalSteps: isMultiStep ? stepIndicators.length : 1
              };
            }
          }
        } catch (e) {
          // Continue to next selector
        }
      }
      
      return null;
    });
    
    return modalInfo;
  } catch (error) {
    console.error(`[ModalDetector] Error detecting modal: ${error.message}`);
    return null;
  }
}

/**
 * Analyze modal content to identify distinct paths/options
 * @param {Object} modalInfo - Modal information from detectModal
 * @returns {Array} Array of distinct paths/options in the modal
 */
export function analyzeModalPaths(modalInfo) {
  if (!modalInfo || !modalInfo.detected) {
    return [];
  }
  
  const paths = [];
  
  // Group interactive elements by their purpose
  const buttons = modalInfo.interactiveElements.filter(el => el.type === 'button');
  const forms = modalInfo.forms || [];
  
  // If modal has multiple buttons with distinct text, each is a potential path
  if (buttons.length > 0) {
    for (const button of buttons) {
      // Skip close/cancel buttons (common patterns)
      const buttonText = (button.text || '').toLowerCase();
      const isCloseButton = buttonText.includes('close') || 
                           buttonText.includes('cancel') || 
                           buttonText.includes('×') ||
                           buttonText.includes('x');
      
      if (!isCloseButton) {
        paths.push({
          type: 'button_click',
          action: button.text || button.id || 'button',
          selector: button.selector,
          description: button.text || `Click ${button.id || 'button'}`
        });
      }
    }
  }
  
  // If modal has forms, each form is a potential path
  if (forms.length > 0) {
    for (const form of forms) {
      paths.push({
        type: 'form_submit',
        action: 'fill-form',
        formId: form.id,
        description: `Fill and submit form ${form.id || 'in modal'}`
      });
    }
  }
  
  // If no distinct paths found, create a default path
  if (paths.length === 0) {
    paths.push({
      type: 'interact',
      action: 'interact-with-modal',
      description: 'Interact with modal content'
    });
  }
  
  return paths;
}

/**
 * Wait for modal to appear after action
 * @param {Page} page - Playwright page object
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @returns {Promise<Object|null>} Modal info or null
 */
export async function waitForModal(page, timeout = 5000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const modal = await detectModal(page);
    if (modal && modal.detected) {
      return modal;
    }
    await new Promise(resolve => setTimeout(resolve, 200)); // Check every 200ms
  }
  
  return null;
}

/**
 * Check if modal is still visible
 * @param {Page} page - Playwright page object
 * @param {string} modalSelector - Selector of the modal to check
 * @returns {Promise<boolean>} True if modal is still visible
 */
export async function isModalVisible(page, modalSelector) {
  try {
    const visible = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      
      return style.display !== 'none' && 
             style.visibility !== 'hidden' && 
             style.opacity !== '0' &&
             rect.width > 0 && 
             rect.height > 0;
    }, modalSelector);
    
    return visible;
  } catch (error) {
    return false;
  }
}

export default {
  detectModal,
  analyzeModalPaths,
  waitForModal,
  isModalVisible
};




































