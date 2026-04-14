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

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Get stealth browser launch arguments
 * @param {{ width: number, height: number }|undefined} viewport - Optional viewport (default 1920x1080)
 */
export function getStealthLaunchArgs(viewport) {
  const v = viewport && typeof viewport.width === 'number' && typeof viewport.height === 'number'
    ? viewport
    : DEFAULT_VIEWPORT;
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Prefer HTTP/1.1 for main document/subresources when servers or intermediaries
    // mishandle HTTP/2 (common symptom: net::ERR_HTTP2_PROTOCOL_ERROR, empty DOM).
    '--disable-http2',
    `--window-size=${v.width},${v.height}`,
    // Opt in to software WebGL to silence "Automatic fallback to software WebGL has been deprecated" (headless/CI often has no GPU)
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    // Stealth arguments to avoid detection
    '--disable-blink-features=AutomationControlled', // Remove automation flags
    '--disable-features=IsolateOrigins,site-per-process', // Avoid fingerprinting
    '--disable-site-isolation-trials',
    // Keep browser behavior close to real users; avoid changing core web security model.
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
    viewport: (options.viewport && typeof options.viewport.width === 'number' && typeof options.viewport.height === 'number')
      ? options.viewport
      : DEFAULT_VIEWPORT,
    userAgent: options.userAgent || getRealisticUserAgent(),
    locale: 'en-US',
    timezoneId: 'America/New_York', // Common timezone
    permissions: ['geolocation'], // Common permission
    geolocation: { latitude: 40.7128, longitude: -74.0060 }, // New York coordinates
    colorScheme: 'light',
    // Do not force global extra headers.
    // They can alter CORS/preflight behavior on third-party assets (e.g. reCAPTCHA/fonts)
    // and break login pages. Let Chromium generate request headers naturally.
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

    // Provide minimal chrome object only when absent.
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }

    // Override permissions
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query
      ? window.navigator.permissions.query.bind(window.navigator.permissions)
      : null;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }

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
    // Ensure navigator.connection supports listener methods in all Chromium variants.
    // Some builds expose connection but only with addListener/removeListener.
    if ('connection' in navigator && navigator.connection) {
      try {
        const conn = navigator.connection;
        const proto = Object.getPrototypeOf(conn);
        if (proto && typeof conn.addEventListener !== 'function') {
          if (typeof conn.addListener === 'function') {
            proto.addEventListener = function(type, listener) {
              if (type === 'change') return this.addListener(listener);
            };
          } else {
            proto.addEventListener = function() {};
          }
        }
        if (proto && typeof conn.removeEventListener !== 'function') {
          if (typeof conn.removeListener === 'function') {
            proto.removeEventListener = function(type, listener) {
              if (type === 'change') return this.removeListener(listener);
            };
          } else {
            proto.removeEventListener = function() {};
          }
        }
      } catch (_) {
        // ignore compatibility patch failures
      }
    } else {
      const listeners = new Map();
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          onchange: null,
          addEventListener: (type, listener) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
          },
          removeEventListener: (type, listener) => {
            if (listeners.has(type)) listeners.get(type).delete(listener);
          },
          dispatchEvent: () => true
        }),
      });
    }

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

    // Avoid overriding Function.prototype.toString globally.
    // This is high-risk and can break app/runtime internals.

    // Compatibility polyfill:
    // Some app bundles assume MediaQueryList supports addEventListener/removeEventListener.
    // In some Chromium environments only addListener/removeListener exist, which can crash SPAs.
    // Provide a minimal mapping (only for 'change') so code keeps running.
    try {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        const testMql = window.matchMedia('(min-width: 0px)');
        if (testMql && typeof testMql.addEventListener !== 'function' && typeof testMql.addListener === 'function') {
          const proto = Object.getPrototypeOf(testMql);
          if (proto && typeof proto.addEventListener !== 'function') {
            proto.addEventListener = function(type, listener) {
              try {
                if (type === 'change') return this.addListener(listener);
              } catch (_) {}
            };
          }
          if (proto && typeof proto.removeEventListener !== 'function' && typeof proto.removeListener === 'function') {
            proto.removeEventListener = function(type, listener) {
              try {
                if (type === 'change') return this.removeListener(listener);
              } catch (_) {}
            };
          }
        }
      }
    } catch (_) {
      // ignore
    }
  });

  // Add realistic mouse and keyboard behavior
  // Use addInitScript instead of evaluateOnNewDocument (more compatible)
  await page.addInitScript(() => {
    // Add realistic mouse movement tracking
    let lastMouseMove = Date.now();
    if (typeof document !== 'undefined') {
      document.addEventListener('mousemove', () => {
        lastMouseMove = Date.now();
      });
    }

    // Override requestAnimationFrame to add slight delays
    if (typeof window !== 'undefined' && window.requestAnimationFrame) {
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
    }
  });
}

/**
 * Add human-like delays and behaviors
 */
export async function addHumanBehavior(page) {
  // Random mouse movements with realistic patterns
  const moveMouse = async (targetX = null, targetY = null) => {
    const viewport = page.viewportSize();
    if (viewport) {
      const x = targetX !== null ? targetX : Math.random() * viewport.width;
      const y = targetY !== null ? targetY : Math.random() * viewport.height;
      // Use curved movement with multiple steps for realism
      const steps = Math.floor(Math.random() * 15) + 10;
      await page.mouse.move(x, y, { steps });
      // Small random pause after movement
      await humanDelay(50, 200);
    }
  };

  // Random scrolls with human-like patterns
  const randomScroll = async (direction = 'down', amount = null) => {
    const viewport = page.viewportSize();
    if (viewport) {
      const scrollY = amount !== null ? amount : (Math.random() * viewport.height * 0.3) + 100;
      const finalY = direction === 'down' ? scrollY : -scrollY;
      // Scroll in small increments like humans do
      const increments = Math.floor(Math.random() * 3) + 2;
      for (let i = 0; i < increments; i++) {
        await page.mouse.wheel(0, finalY / increments);
        await humanDelay(100, 300);
      }
    }
  };

  // Human-like click with mouse movement first
  const humanClick = async (selector, options = {}) => {
    const element = await page.locator(selector).first();
    const box = await element.boundingBox();
    
    if (box) {
      // Move mouse to element with slight offset (humans rarely click dead center)
      const offsetX = (Math.random() - 0.5) * 10;
      const offsetY = (Math.random() - 0.5) * 10;
      await page.mouse.move(box.x + box.width / 2 + offsetX, box.y + box.height / 2 + offsetY, {
        steps: Math.floor(Math.random() * 10) + 5
      });
      await humanDelay(100, 300); // Pause before clicking
      await element.click(options);
      await humanDelay(50, 150); // Pause after clicking
    } else {
      await element.click(options);
    }
  };

  // Human-like hover
  const humanHover = async (selector) => {
    const element = await page.locator(selector).first();
    const box = await element.boundingBox();
    
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
        steps: Math.floor(Math.random() * 8) + 5
      });
      await humanDelay(200, 500); // Humans hover for a moment
    } else {
      await element.hover();
    }
  };

  return { moveMouse, randomScroll, humanClick, humanHover };
}

/**
 * Wait with human-like random delay (uses realistic timing patterns).
 * Slower defaults so video playback clearly shows each action.
 */
export async function humanDelay(min = 300, max = 900) {
  // Use exponential distribution for more realistic delays
  const lambda = 1 / ((min + max) / 2);
  const delay = Math.min(max, Math.max(min, -Math.log(Math.random()) / lambda));
  await new Promise(resolve => setTimeout(resolve, Math.floor(delay)));
}

/**
 * Human-like typing delay between characters (slower for visible video).
 */
export function getTypingDelay() {
  const baseDelay = 120 + Math.random() * 280;
  if (Math.random() < 0.12) {
    return baseDelay + Math.random() * 800;
  }
  return baseDelay;
}

/**
 * Simulate human reading time (for pages, forms, etc.)
 */
export async function humanReadingTime(textLength = 0) {
  // Average reading speed: 200-300 words per minute
  // Assume average word length: 5 characters
  const words = textLength / 5;
  const readingTimeMs = (words / 250) * 60 * 1000; // Convert to milliseconds
  // Add randomness: humans read at variable speeds
  const delay = readingTimeMs * (0.5 + Math.random() * 1.0);
  await humanDelay(Math.min(500, delay), Math.min(3000, delay + 1000));
}

