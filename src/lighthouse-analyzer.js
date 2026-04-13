/**
 * Page Performance Analyzer
 * Uses Playwright's Performance API to measure page load performance and Core Web Vitals
 * Compatible with Playwright's embedded browser (no CDP endpoint required)
 */

import * as backendLogger from './backend-logger.js';

/** Web vitals from the browser should be small positive durations (ms), not epoch timestamps. */
function sanitizeWebVitalMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Reject epoch-scale values (legacy PerformanceTiming.* uses UNIX ms) and absurd durations.
  if (n > 600000) return 0;
  return n;
}

/**
 * Analyze page performance using Playwright's Performance API
 * @param {Object} page - Playwright page object
 * @param {string} jobId - Job ID for logging
 * @param {string} pageUrl - URL of the page being analyzed
 * @param {Object} options - Configuration options
 * @returns {Object} Performance results with metrics
 */
export async function analyzePageWithLighthouse(page, jobId, pageUrl, options = {}) {
  const startTime = Date.now();
  const categories = Array.isArray(options.categories) && options.categories.length > 0
    ? options.categories
    : ['performance', 'accessibility', 'best-practices', 'seo'];
  const device = typeof options.device === 'string' ? options.device : 'desktop';
  
  try {
    await backendLogger.appendJobLog(jobId, 'info', `🔍 Starting performance analysis for ${pageUrl}`, 'performance-analyzer', {
      page_url: pageUrl,
      action: 'performance_analysis_start',
      categories,
      device
    });

    // Wait for page to be fully loaded (with timeout)
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
      console.warn('Page DOM not fully loaded after 30s, continuing with Lighthouse analysis');
    });

    // Get performance metrics using Playwright's evaluate
    const performanceMetrics = await page.evaluate(() => {
      const perfData = window.performance.timing;
      const paintEntries = performance.getEntriesByType('paint');
      const navStart = perfData.navigationStart || 0;

      // Calculate key metrics
      const dns = perfData.domainLookupEnd - perfData.domainLookupStart;
      const tcp = perfData.connectEnd - perfData.connectStart;
      const ssl = perfData.connectEnd - perfData.secureConnectionStart;
      const ttfb = perfData.responseStart - perfData.requestStart;
      const download = perfData.responseEnd - perfData.responseStart;
      const domProcessing = perfData.domComplete - perfData.domLoading;
      const domContentLoaded = perfData.domContentLoadedEventEnd - perfData.domContentLoadedEventStart;
      const loadComplete = perfData.loadEventEnd - perfData.loadEventStart;

      // Find paint entries (relative high-resolution time, ms)
      const fcp = paintEntries.find((e) => e.name === 'first-contentful-paint')?.startTime || 0;

      // True LCP from Paint Timing / Element Timing (relative ms); avoid legacy timing fields — they are often UNIX epoch ms.
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      let largestContentfulPaint = 0;
      if (lcpEntries && lcpEntries.length) {
        const last = lcpEntries[lcpEntries.length - 1];
        largestContentfulPaint = last.renderTime || last.loadTime || last.startTime || 0;
      }
      if (!largestContentfulPaint && navStart > 0 && perfData.loadEventEnd > navStart) {
        largestContentfulPaint = perfData.loadEventEnd - navStart;
      }

      // Rough response-complete duration (never use raw responseEnd as a paint metric)
      const responseCompleteMs =
        navStart > 0 && perfData.responseEnd > navStart ? perfData.responseEnd - navStart : 0;

      // Calculate total page load time
      const pageLoadTime = navStart > 0 ? perfData.loadEventEnd - navStart : 0;

      return {
        dnsTime: dns,
        tcpTime: tcp,
        sslTime: ssl || 0,
        ttfb: ttfb,
        downloadTime: download,
        domProcessingTime: domProcessing,
        domContentLoadedTime: domContentLoaded,
        loadCompleteTime: loadComplete,
        firstContentfulPaint: fcp,
        firstMeaningfulPaint: responseCompleteMs,
        largestContentfulPaint,
        pageLoadTime: pageLoadTime,
        totalTime: pageLoadTime,
        domSize: document.querySelectorAll('*').length,
        resourceCount: performance.getEntriesByType('resource').length
      };
    });

    const analysisDuration = Date.now() - startTime;
    
    // Calculate performance score (simple heuristic)
    const performanceScore = calculatePerformanceScore(performanceMetrics);
    
    // Log successful analysis
    await backendLogger.appendJobLog(jobId, 'info', `✅ Performance analysis completed in ${(analysisDuration / 1000).toFixed(1)}s`, 'performance-analyzer', {
      page_url: pageUrl,
      action: 'performance_analysis_complete',
      duration_ms: analysisDuration,
      performance_score: performanceScore,
      page_load_time: performanceMetrics.pageLoadTime,
      first_contentful_paint: performanceMetrics.firstContentfulPaint
    });

    const fcpMs = sanitizeWebVitalMs(performanceMetrics.firstContentfulPaint);
    const lcpMs = sanitizeWebVitalMs(
      performanceMetrics.largestContentfulPaint ?? performanceMetrics.firstMeaningfulPaint,
    );
    const ttiMs = sanitizeWebVitalMs(performanceMetrics.domContentLoadedTime);
    const ttfbMs = sanitizeWebVitalMs(performanceMetrics.ttfb);

    return {
      success: true,
      metrics: {
        performance: performanceScore,
        firstContentfulPaint: fcpMs,
        largestContentfulPaint: lcpMs,
        speedIndex: sanitizeWebVitalMs(performanceMetrics.pageLoadTime),
        cumulativeLayoutShift: 0, // Not available via Performance API
        totalBlockingTime: 0, // Not available via Performance API
        interactive: ttiMs,
        serverResponseTime: ttfbMs,
        domSize: performanceMetrics.domSize,
        pageLoadTime: sanitizeWebVitalMs(performanceMetrics.pageLoadTime),
        dnsTime: performanceMetrics.dnsTime,
        tcpTime: performanceMetrics.tcpTime,
        sslTime: performanceMetrics.sslTime,
        downloadTime: performanceMetrics.downloadTime,
        resourceCount: performanceMetrics.resourceCount
      },
      categories,
      device,
      analysisDuration,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    const analysisDuration = Date.now() - startTime;
    
    await backendLogger.appendJobLog(jobId, 'error', `❌ Performance analysis failed: ${error.message}`, 'performance-analyzer', {
      page_url: pageUrl,
      action: 'performance_analysis_error',
      duration_ms: analysisDuration,
      error: error.message,
      stack: error.stack
    });

    return {
      success: false,
      error: error.message,
      categories,
      device,
      analysisDuration,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Calculate performance score based on metrics
 * @param {Object} metrics - Performance metrics
 * @returns {number} Performance score (0-100)
 */
function calculatePerformanceScore(metrics) {
  let score = 100;
  
  // Deduct points for slow metrics
  if (metrics.pageLoadTime > 3000) score -= 30;
  else if (metrics.pageLoadTime > 2000) score -= 20;
  else if (metrics.pageLoadTime > 1000) score -= 10;
  
  if (metrics.firstContentfulPaint > 1800) score -= 25;
  else if (metrics.firstContentfulPaint > 1200) score -= 15;
  else if (metrics.firstContentfulPaint > 800) score -= 5;
  
  if (metrics.ttfb > 600) score -= 15;
  else if (metrics.ttfb > 400) score -= 10;
  else if (metrics.ttfb > 200) score -= 5;
  
  if (metrics.domSize > 1500) score -= 10;
  else if (metrics.domSize > 1000) score -= 5;
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Extract key metrics from Lighthouse results
 * @param {Object} results - Raw Lighthouse results
 * @returns {Object} Extracted metrics
 */
function extractLighthouseMetrics(results) {
  const audits = results.lhr.audits;
  const categories = results.lhr.categories;

  return {
    // Overall scores (0-100)
    performance: Math.round(categories.performance.score * 100),
    accessibility: Math.round(categories.accessibility.score * 100),
    bestPractices: Math.round(categories['best-practices'].score * 100),
    seo: Math.round(categories.seo.score * 100),

    // Core Web Vitals
    firstContentfulPaint: audits['first-contentful-paint']?.numericValue || 0,
    largestContentfulPaint: audits['largest-contentful-paint']?.numericValue || 0,
    cumulativeLayoutShift: audits['cumulative-layout-shift']?.numericValue || 0,
    speedIndex: audits['speed-index']?.numericValue || 0,
    totalBlockingTime: audits['total-blocking-time']?.numericValue || 0,
    interactive: audits['interactive']?.numericValue || 0,
    firstMeaningfulPaint: audits['first-meaningful-paint']?.numericValue || 0,
    maxPotentialFID: audits['max-potential-fid']?.numericValue || 0,

    // Performance metrics
    serverResponseTime: audits['server-response-time']?.numericValue || 0,
    domSize: audits['dom-size']?.numericValue || 0,

    // Resource optimization
    renderBlockingResources: audits['render-blocking-resources']?.details?.items?.length || 0,
    unusedCSSRules: audits['unused-css-rules']?.details?.items?.length || 0,
    unusedJavaScript: audits['unused-javascript']?.details?.items?.length || 0,
    unminifiedCSS: audits['unminified-css']?.details?.items?.length || 0,
    unminifiedJavaScript: audits['unminified-javascript']?.details?.items?.length || 0,

    // Image optimization
    usesOptimizedImages: audits['uses-optimized-images']?.score === 1,
    usesWebPImages: audits['uses-webp-images']?.score === 1,
    usesResponsiveImages: audits['uses-responsive-images']?.score === 1,
    modernImageFormats: audits['modern-image-formats']?.score === 1,
    offscreenImages: audits['offscreen-images']?.details?.items?.length || 0,

    // Caching and compression
    usesTextCompression: audits['uses-text-compression']?.score === 1,
    usesLongCacheTTL: audits['uses-long-cache-ttl']?.score === 1,
    usesHTTP2: audits['uses-http2']?.score === 1,

    // Accessibility metrics
    colorContrast: audits['color-contrast']?.score === 1,
    imageAlt: audits['image-alt']?.score === 1,
    label: audits['label']?.score === 1,
    linkName: audits['link-name']?.score === 1,
    buttonName: audits['button-name']?.score === 1,
    documentTitle: audits['document-title']?.score === 1,
    metaDescription: audits['meta-description']?.score === 1,
    viewport: audits['viewport']?.score === 1,

    // SEO metrics
    isCrawlable: audits['is-crawlable']?.score === 1,
    robotsTxt: audits['robots-txt']?.score === 1,
    validLang: audits['valid-lang']?.score === 1,

    // Best practices
    usesPassiveEventListeners: audits['uses-passive-event-listeners']?.score === 1,
    noDocumentWrite: audits['no-document-write']?.score === 1,
    usesRelPreconnect: audits['uses-rel-preconnect']?.score === 1,
    usesRelPreload: audits['uses-rel-preload']?.score === 1,
    fontDisplay: audits['font-display']?.score === 1,

    // Critical request chains
    criticalRequestChains: audits['critical-request-chains']?.details?.chains ? 
      Object.keys(audits['critical-request-chains'].details.chains).length : 0,

    // Additional performance insights
    efficientAnimatedContent: audits['efficient-animated-content']?.score === 1,
    usesAriaAttributes: audits['uses-aria-attributes']?.score === 1,
    usesAriaRoles: audits['uses-aria-roles']?.score === 1,
    bypass: audits['bypass']?.score === 1,
    focusTraps: audits['focus-traps']?.score === 1,
    focusableControls: audits['focusable-controls']?.score === 1,
    managedFocus: audits['managed-focus']?.score === 1,
    offscreenContentHidden: audits['offscreen-content-hidden']?.score === 1,
    useLandmarks: audits['use-landmarks']?.score === 1,
    visualOrderFollowsDom: audits['visual-order-follows-dom']?.score === 1,
    worksWithoutJS: audits['works-without-js']?.score === 1,

    // Detailed audit results
    auditResults: {
      passed: Object.values(audits).filter(audit => audit.score === 1).length,
      failed: Object.values(audits).filter(audit => audit.score === 0).length,
      notApplicable: Object.values(audits).filter(audit => audit.score === null).length,
      total: Object.keys(audits).length
    }
  };
}

/**
 * Run Lighthouse analysis with custom configuration
 * @param {Object} page - Playwright page object
 * @param {string} jobId - Job ID for logging
 * @param {string} pageUrl - URL of the page being analyzed
 * @param {Object} customConfig - Custom Lighthouse configuration
 * @returns {Object} Lighthouse results
 */
export async function analyzePageWithCustomLighthouse(page, jobId, pageUrl, customConfig = {}) {
  const defaultConfig = {
    settings: {
      throttlingMethod: 'simulate',
      throttling: {
        rttMs: 40,
        throughputKbps: 10240,
        cpuSlowdownMultiplier: 1
      },
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false
      }
    }
  };

  const mergedConfig = {
    ...defaultConfig,
    ...customConfig,
    settings: {
      ...defaultConfig.settings,
      ...customConfig.settings
    }
  };

  return await analyzePageWithLighthouse(page, jobId, pageUrl, mergedConfig);
}

/**
 * Run mobile-specific Lighthouse analysis
 * @param {Object} page - Playwright page object
 * @param {string} jobId - Job ID for logging
 * @param {string} pageUrl - URL of the page being analyzed
 * @returns {Object} Lighthouse results
 */
export async function analyzePageMobileLighthouse(page, jobId, pageUrl) {
  const mobileConfig = {
    settings: {
      throttlingMethod: 'simulate',
      throttling: {
        rttMs: 150,
        throughputKbps: 1638.4,
        cpuSlowdownMultiplier: 4
      },
      screenEmulation: {
        mobile: true,
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        disabled: false
      }
    }
  };

  return await analyzePageWithLighthouse(page, jobId, pageUrl, mobileConfig);
}

/**
 * Run desktop-specific Lighthouse analysis
 * @param {Object} page - Playwright page object
 * @param {string} jobId - Job ID for logging
 * @param {string} pageUrl - URL of the page being analyzed
 * @returns {Object} Lighthouse results
 */
export async function analyzePageDesktopLighthouse(page, jobId, pageUrl) {
  const desktopConfig = {
    settings: {
      throttlingMethod: 'simulate',
      throttling: {
        rttMs: 40,
        throughputKbps: 10240,
        cpuSlowdownMultiplier: 1
      },
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false
      }
    }
  };

  return await analyzePageWithLighthouse(page, jobId, pageUrl, desktopConfig);
}

export default {
  analyzePageWithLighthouse,
  analyzePageWithCustomLighthouse,
  analyzePageMobileLighthouse,
  analyzePageDesktopLighthouse
};
