/**
 * Stealth browser configuration to make automation appear more human-like
 * and avoid detection by services like Vercel, Cloudflare, etc.
 */

/**
 * Get a modern, realistic user agent string
 */
export function getRealisticUserAgent() {
  // Use a recent Chrome user agent on Windows (most common)
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

/**
 * Get stealth browser launch arguments
 */
export function getStealthLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080',
    '--force-device-scale-factor=1',
    // Stealth arguments to avoid detection
    '--disable-blink-features=AutomationControlled', // Remove automation flags
    '--disable-features=IsolateOrigins,site-per-process', // Avoid fingerprinting
    '--disable-site-isolation-trials',
    '--disable-web-security', // Some sites check for this
    '--disable-features=BlockInsecurePrivateNetworkRequests',
    // Make it look more like a real browser
    '--lang=en-US,en',
    '--accept-lang=en-US,en;q=0.9',
  ];
}

/**
 * Get stealth context options with realistic browser properties
 */
export function getStealthContextOptions(options = {}) {
  const baseOptions = {
    viewport: options.viewport || { width: 1920, height: 1080 },
    userAgent: options.userAgent || getRealisticUserAgent(),
    locale: 'en-US',
    timezoneId: 'America/New_York', // Common timezone
    permissions: ['geolocation'], // Common permission
    geolocation: { latitude: 40.7128, longitude: -74.0060 }, // New York coordinates
    colorScheme: 'light',
    // Extra HTTP headers to look more realistic
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1', // Do Not Track
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
    // Record video if needed
    ...(options.recordVideo ? { recordVideo: options.recordVideo } : {}),
    ignoreHTTPSErrors: true,
  };

  return baseOptions;
}

/**
 * Inject stealth scripts into the page to override automation detection
 * This should be called before navigation for best results
 */
export async function injectStealthScripts(page) {
  // Inject scripts to hide automation indicators (runs before page loads)
  await page.addInitScript(() => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    // Override chrome object
    window.chrome = {
      runtime: {},
    };

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // Override plugins to look realistic
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5], // Fake plugins array
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Override platform
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
    });

    // Override hardwareConcurrency (CPU cores)
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8, // Common value
    });

    // Override deviceMemory
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8, // Common value in GB
    });

    // Override connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
      }),
    });

    // Mock WebGL to avoid fingerprinting
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) {
        return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      }
      if (parameter === 37446) {
        return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      }
      return getParameter.call(this, parameter);
    };

    // Override toString to hide automation
    const originalToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this === navigator.webdriver || this === window.chrome) {
        return 'function() { [native code] }';
      }
      return originalToString.call(this);
    };
  });

  // Add realistic mouse and keyboard behavior
  await page.evaluateOnNewDocument(() => {
    // Add realistic mouse movement
    let lastMouseMove = Date.now();
    document.addEventListener('mousemove', () => {
      lastMouseMove = Date.now();
    });

    // Override requestAnimationFrame to add slight delays
    const originalRAF = window.requestAnimationFrame;
    let rafCallCount = 0;
    window.requestAnimationFrame = function(callback) {
      rafCallCount++;
      // Add occasional slight delays to mimic human behavior
      if (rafCallCount % 100 === 0) {
        return originalRAF.call(window, () => {
          setTimeout(callback, Math.random() * 5);
        });
      }
      return originalRAF.call(window, callback);
    };
  });
}

/**
 * Add human-like delays and behaviors
 */
export async function addHumanBehavior(page) {
  // Random mouse movements
  const moveMouse = async () => {
    const viewport = page.viewportSize();
    if (viewport) {
      const x = Math.random() * viewport.width;
      const y = Math.random() * viewport.height;
      await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
    }
  };

  // Random scrolls
  const randomScroll = async () => {
    const viewport = page.viewportSize();
    if (viewport) {
      const scrollY = Math.random() * viewport.height * 0.5;
      await page.mouse.wheel(0, scrollY);
    }
  };

  return { moveMouse, randomScroll };
}

/**
 * Wait with human-like random delay
 */
export async function humanDelay(min = 100, max = 500) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

