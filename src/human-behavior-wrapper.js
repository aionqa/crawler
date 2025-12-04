/**
 * Human Behavior Wrapper
 * Wraps Playwright actions to automatically add human-like behaviors
 */

import { humanDelay, getTypingDelay } from './stealth-config.js';

/**
 * Wrap page.click() with human-like behavior
 */
export async function humanClick(page, selector, options = {}) {
  const element = await page.locator(selector).first();
  const box = await element.boundingBox();
  
  if (box) {
    // Move mouse to element with slight offset (humans rarely click dead center)
    const offsetX = (Math.random() - 0.5) * 10;
    const offsetY = (Math.random() - 0.5) * 10;
    const targetX = box.x + box.width / 2 + offsetX;
    const targetY = box.y + box.height / 2 + offsetY;
    
    // Move mouse in curved path (humans don't move in straight lines)
    const steps = Math.floor(Math.random() * 10) + 10;
    await page.mouse.move(targetX, targetY, { steps });
    
    // Hover before clicking (humans hover before clicking)
    await humanDelay(200, 500);
    
    // Click
    await element.click(options);
    
    // Pause after clicking
    await humanDelay(50, 150);
  } else {
    await element.click(options);
  }
}

/**
 * Wrap page.fill() with human-like typing
 */
export async function humanFill(page, selector, text, options = {}) {
  const element = await page.locator(selector).first();
  const box = await element.boundingBox();
  
  if (box) {
    // Move mouse to input field
    const offsetX = (Math.random() - 0.5) * 10;
    const offsetY = (Math.random() - 0.5) * 10;
    await page.mouse.move(box.x + box.width / 2 + offsetX, box.y + box.height / 2 + offsetY, {
      steps: Math.floor(Math.random() * 10) + 5
    });
    
    // Hover before clicking
    await humanDelay(100, 300);
    
    // Click to focus
    await element.click();
    await humanDelay(150, 400);
    
    // Clear existing content
    await page.keyboard.press('Control+A');
    await humanDelay(50, 100);
    
    // Type character by character with human-like delays
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      // Type the character
      await page.keyboard.type(char, { delay: getTypingDelay() });
      
      // Pause after punctuation or spaces (humans pause)
      if (['.', ',', '!', '?', ' '].includes(char)) {
        if (Math.random() < 0.3) {
          await humanDelay(150, 400);
        }
      }
      
      // Occasional longer pause mid-typing (humans think)
      if (Math.random() < 0.1 && i > 0 && i < text.length - 1) {
        await humanDelay(300, 800);
      }
    }
    
    // Pause after completing field (humans verify what they typed)
    await humanDelay(300, 600);
  } else {
    // Fallback to regular fill if element not found
    await element.fill(text);
  }
}

/**
 * Wrap page.goto() with human-like behavior
 */
export async function humanGoto(page, url, options = {}) {
  await page.goto(url, options);
  
  // Wait for page to settle
  await humanDelay(500, 1500);
  
  // Scroll down slightly to simulate reading (humans scroll when page loads)
  const scrollAmount = 50 + Math.random() * 150;
  await page.mouse.wheel(0, scrollAmount);
  await humanDelay(200, 400);
}

/**
 * Wrap page.hover() with human-like behavior
 */
export async function humanHover(page, selector) {
  const element = await page.locator(selector).first();
  const box = await element.boundingBox();
  
  if (box) {
    // Move mouse to element
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: Math.floor(Math.random() * 8) + 5
    });
    
    // Hover for realistic duration
    await humanDelay(200, 500);
    
    await element.hover();
  } else {
    await element.hover();
  }
}

/**
 * Inject human behavior helpers into page context
 * This makes humanClick, humanFill, etc. available in scripts
 */
export async function injectHumanHelpers(page) {
  await page.addInitScript(() => {
    // These will be available in the browser context if needed
    // But most actions should use Node.js context wrappers
  });
}





