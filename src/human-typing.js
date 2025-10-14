/**
 * Humanized Typing Module
 * Simulates human-like typing behavior with:
 * - Variable typing speed
 * - Occasional typos and corrections
 * - Natural pauses
 * - Mouse movements before typing
 */

/**
 * Generate a random delay within a range
 */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Simulate human-like mouse movement to element
 */
async function moveMouseToElement(page, selector) {
  try {
    const element = await page.$(selector);
    if (!element) return;

    const box = await element.boundingBox();
    if (!box) return;

    // Move mouse to element with slight randomness
    const x = box.x + box.width / 2 + randomDelay(-5, 5);
    const y = box.y + box.height / 2 + randomDelay(-5, 5);

    await page.mouse.move(x, y, { steps: randomDelay(10, 20) });
    await page.waitForTimeout(randomDelay(100, 300));
  } catch (error) {
    // Ignore errors
  }
}

/**
 * Common typo patterns (keyboard proximity)
 */
const typoPatterns = {
  'a': ['s', 'q', 'w'],
  'b': ['v', 'n', 'g'],
  'c': ['x', 'v', 'd'],
  'd': ['s', 'f', 'e'],
  'e': ['w', 'r', 'd'],
  'f': ['d', 'g', 'r'],
  'g': ['f', 'h', 't'],
  'h': ['g', 'j', 'y'],
  'i': ['u', 'o', 'k'],
  'j': ['h', 'k', 'u'],
  'k': ['j', 'l', 'i'],
  'l': ['k', 'o', 'p'],
  'm': ['n', 'j', 'k'],
  'n': ['b', 'm', 'h'],
  'o': ['i', 'p', 'l'],
  'p': ['o', 'l'],
  'q': ['w', 'a'],
  'r': ['e', 't', 'f'],
  's': ['a', 'd', 'w'],
  't': ['r', 'y', 'g'],
  'u': ['y', 'i', 'j'],
  'v': ['c', 'b', 'f'],
  'w': ['q', 'e', 's'],
  'x': ['z', 'c', 's'],
  'y': ['t', 'u', 'h'],
  'z': ['x', 'a']
};

/**
 * Generate a typo for a character
 */
function generateTypo(char) {
  const lowerChar = char.toLowerCase();
  const possibleTypos = typoPatterns[lowerChar];
  
  if (!possibleTypos || Math.random() > 0.15) { // 15% chance of typo
    return null;
  }
  
  const typo = possibleTypos[Math.floor(Math.random() * possibleTypos.length)];
  return char === char.toUpperCase() ? typo.toUpperCase() : typo;
}

/**
 * Type text in a human-like manner
 * @param {Page} page - Playwright page
 * @param {string} selector - Element selector
 * @param {string} text - Text to type
 * @param {Object} options - Typing options
 */
export async function humanType(page, selector, text, options = {}) {
  const {
    minDelay = 80,        // Minimum delay between keystrokes (ms)
    maxDelay = 250,       // Maximum delay between keystrokes (ms)
    typoChance = 0.08,    // 8% chance of making a typo
    pauseChance = 0.15,   // 15% chance of pausing mid-typing
    pauseDuration = [500, 1500], // Pause duration range
    moveMouseFirst = true  // Move mouse to element first
  } = options;

  console.log(`[HUMAN-TYPING] Starting to type "${text.substring(0, 20)}..." in ${selector}`);

  try {
    // Move mouse to element first
    if (moveMouseFirst) {
      await moveMouseToElement(page, selector);
    }

    // Click the element to focus
    await page.click(selector);
    await page.waitForTimeout(randomDelay(100, 300));

    // Clear existing content
    await page.fill(selector, '');
    await page.waitForTimeout(randomDelay(50, 150));

    let typedText = '';
    let typosMade = 0;
    let pausesMade = 0;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      // Random pause mid-typing
      if (Math.random() < pauseChance && i > 0 && i < text.length - 1) {
        const pauseTime = randomDelay(pauseDuration[0], pauseDuration[1]);
        console.log(`[HUMAN-TYPING] Pausing for ${pauseTime}ms`);
        await page.waitForTimeout(pauseTime);
        pausesMade++;
      }

      // Decide if we should make a typo
      const shouldTypo = Math.random() < typoChance && i < text.length - 1;
      
      if (shouldTypo) {
        const typo = generateTypo(char);
        if (typo) {
          // Type the wrong character
          await page.type(selector, typo, { delay: randomDelay(minDelay, maxDelay) });
          typedText += typo;
          typosMade++;
          
          // Pause (realizing the mistake)
          await page.waitForTimeout(randomDelay(200, 500));
          
          // Delete the typo
          await page.keyboard.press('Backspace');
          typedText = typedText.slice(0, -1);
          await page.waitForTimeout(randomDelay(100, 200));
          
          console.log(`[HUMAN-TYPING] Made typo: "${typo}" instead of "${char}", corrected`);
        }
      }

      // Type the correct character
      await page.type(selector, char, { delay: randomDelay(minDelay, maxDelay) });
      typedText += char;

      // Occasional longer pause after punctuation or spaces
      if (['.', ',', '!', '?', ' '].includes(char)) {
        if (Math.random() < 0.3) {
          await page.waitForTimeout(randomDelay(150, 400));
        }
      }
    }

    console.log(`[HUMAN-TYPING] ✅ Finished typing. Made ${typosMade} typos and ${pausesMade} pauses`);
    
    return {
      success: true,
      typosMade,
      pausesMade,
      finalText: typedText
    };
  } catch (error) {
    console.error(`[HUMAN-TYPING] ❌ Error typing: ${error.message}`);
    throw error;
  }
}

/**
 * Type with even more human-like behavior (slower, more mistakes)
 */
export async function veryHumanType(page, selector, text, options = {}) {
  return humanType(page, selector, text, {
    minDelay: 120,
    maxDelay: 350,
    typoChance: 0.12, // 12% chance
    pauseChance: 0.20, // 20% chance
    pauseDuration: [800, 2000],
    ...options
  });
}

/**
 * Type quickly (still human-like but faster)
 */
export async function fastHumanType(page, selector, text, options = {}) {
  return humanType(page, selector, text, {
    minDelay: 50,
    maxDelay: 150,
    typoChance: 0.05, // 5% chance
    pauseChance: 0.10, // 10% chance
    pauseDuration: [300, 800],
    ...options
  });
}

