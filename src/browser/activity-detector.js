/**
 * Activity Detector
 * Monitors page activity to identify active and inactive periods for video compression
 * Similar to OpenReplay's activity detection
 */

class ActivityDetector {
  constructor(page, recordingStartTime) {
    this.page = page;
    this.recordingStartTime = recordingStartTime;
    this.activityPeriods = []; // Array of {start: timestamp, end: timestamp, type: string}
    this.lastActivityTime = recordingStartTime;
    this.currentPeriod = { start: recordingStartTime, end: null, type: 'active' };
    this.activityTimeout = 500; // ms - if no activity for this long, consider inactive
    this.minInactiveDuration = 3000; // ms - minimum inactive period to compress (3 seconds)
    this.maxInactiveDisplay = 3000; // ms - max time to show inactive period (3 seconds)
    
    // DOM mutation observer
    this.mutationObserver = null;
    
    // Network activity tracking
    this.networkRequests = new Set();
    this.networkResponses = new Set();
    
    // User interaction tracking
    this.lastInteractionTime = recordingStartTime;
    this.interactionTypes = new Set();
    
    // Frame change tracking (from screencast)
    this.lastFrameChangeTime = recordingStartTime;
    
    this.isActive = false;
  }

  /**
   * Start monitoring page activity
   */
  async start() {
    if (this.isActive) return;
    this.isActive = true;
    
    // Monitor DOM mutations
    await this.page.evaluate(() => {
      const observer = new MutationObserver(() => {
        // Notify Node.js side via CDP
        window.__activityDetected = true;
        window.__lastActivityTime = Date.now();
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: false,
        characterData: true
      });
      
      // Store observer for cleanup
      window.__mutationObserver = observer;
    });

    // Monitor user interactions
    await this.page.evaluate(() => {
      const events = ['click', 'keydown', 'input', 'scroll', 'mousemove'];
      const handleActivity = () => {
        window.__activityDetected = true;
        window.__lastActivityTime = Date.now();
      };
      
      events.forEach(event => {
        document.addEventListener(event, handleActivity, { capture: true, passive: true });
      });
      
      window.__activityListeners = { events, handler: handleActivity };
    });

    // Monitor network activity via CDP
    const cdpSession = await this.page.context().newCDPSession(this.page);
    
    cdpSession.on('Network.requestWillBeSent', () => {
      this.markActivity('network_request');
    });
    
    cdpSession.on('Network.responseReceived', () => {
      this.markActivity('network_response');
    });
    
    this.cdpSession = cdpSession;
    
    // Periodically check for activity
    this.checkInterval = setInterval(() => {
      this.checkActivity();
    }, 200); // Check every 200ms
    
    // Also check for inactivity transitions
    this.inactivityCheckInterval = setInterval(() => {
      const timeSinceLastActivity = Date.now() - this.lastActivityTime;
      if (timeSinceLastActivity >= this.activityTimeout && this.currentPeriod.type === 'active') {
        // Transition to inactive
        this.finishPeriod();
        this.currentPeriod = { start: this.lastActivityTime, end: null, type: 'inactive' };
      }
    }, 500); // Check every 500ms
    
    console.log('[ActivityDetector] Started monitoring page activity');
  }

  /**
   * Mark activity detected
   */
  markActivity(type = 'unknown') {
    const now = Date.now();
    this.lastActivityTime = now;
    this.lastInteractionTime = now;
    this.interactionTypes.add(type);
    
    // If we're in an inactive period, end it and start a new active period
    if (this.currentPeriod.type === 'inactive') {
      this.finishPeriod();
      this.currentPeriod = { start: now, end: null, type: 'active' };
    }
  }

  /**
   * Check for activity from page
   */
  async checkActivity() {
    try {
      const hasActivity = await this.page.evaluate(() => {
        if (window.__activityDetected) {
          window.__activityDetected = false;
          return true;
        }
        return false;
      });
      
      if (hasActivity) {
        this.markActivity('dom_mutation');
      }
    } catch (error) {
      // Page might be closed, ignore
      if (!error.message.includes('Target closed')) {
        console.warn('[ActivityDetector] Error checking activity:', error.message);
      }
    }
  }

  /**
   * Mark frame change (called from screencast handler)
   */
  markFrameChange() {
    const now = Date.now();
    const timeSinceLastChange = now - this.lastFrameChangeTime;
    
    // If frame changed significantly, it's activity
    if (timeSinceLastChange > 100) { // Only count as activity if change is noticeable
      this.markActivity('frame_change');
      this.lastFrameChangeTime = now;
    }
  }

  /**
   * Finish current period and add to list
   */
  finishPeriod() {
    if (this.currentPeriod.start && !this.currentPeriod.end) {
      this.currentPeriod.end = Date.now();
      
      // Only record periods that are meaningful
      const duration = this.currentPeriod.end - this.currentPeriod.start;
      if (duration >= 100) { // At least 100ms
        this.activityPeriods.push({ ...this.currentPeriod });
      }
    }
  }

  /**
   * Stop monitoring and finalize periods
   */
  async stop() {
    if (!this.isActive) return;
    this.isActive = false;
    
    // Finalize current period
    this.finishPeriod();
    
    // Clean up
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    if (this.inactivityCheckInterval) {
      clearInterval(this.inactivityCheckInterval);
      this.inactivityCheckInterval = null;
    }
    
    try {
      // Clean up page-side observers
      await this.page.evaluate(() => {
        if (window.__mutationObserver) {
          window.__mutationObserver.disconnect();
          window.__mutationObserver = null;
        }
        
        if (window.__activityListeners) {
          const { events, handler } = window.__activityListeners;
          events.forEach(event => {
            document.removeEventListener(event, handler, { capture: true });
          });
          window.__activityListeners = null;
        }
      });
    } catch (error) {
      // Page might be closed, ignore
    }
    
    if (this.cdpSession) {
      try {
        await this.cdpSession.detach();
      } catch (error) {
        // Ignore
      }
      this.cdpSession = null;
    }
    
    console.log(`[ActivityDetector] Stopped. Recorded ${this.activityPeriods.length} activity periods`);
  }

  /**
   * Get compressed timeline - compresses inactive periods to max 3 seconds
   * Returns array of {originalStart, originalEnd, displayStart, displayEnd, type, compressed}
   */
  getCompressedTimeline() {
    const timeline = [];
    let displayTime = 0; // Accumulated display time
    
    for (const period of this.activityPeriods) {
      const originalDuration = period.end - period.start;
      
      if (period.type === 'active') {
        // Active periods: show in full
        timeline.push({
          originalStart: period.start,
          originalEnd: period.end,
          displayStart: displayTime,
          displayEnd: displayTime + originalDuration,
          type: 'active',
          compressed: false,
          duration: originalDuration
        });
        displayTime += originalDuration;
      } else {
        // Inactive periods: compress to max 3 seconds
        const compressedDuration = Math.min(originalDuration, this.maxInactiveDisplay);
        
        timeline.push({
          originalStart: period.start,
          originalEnd: period.end,
          displayStart: displayTime,
          displayEnd: displayTime + compressedDuration,
          type: 'inactive',
          compressed: originalDuration > this.maxInactiveDisplay,
          originalDuration,
          compressedDuration
        });
        displayTime += compressedDuration;
      }
    }
    
    return {
      timeline,
      originalDuration: this.activityPeriods.length > 0 
        ? this.activityPeriods[this.activityPeriods.length - 1].end - this.recordingStartTime
        : 0,
      displayDuration: displayTime,
      compressionRatio: displayTime > 0 
        ? (timeline.reduce((sum, p) => sum + (p.originalEnd - p.originalStart), 0) / displayTime)
        : 1
    };
  }

  /**
   * Get inactive period markers for timeline visualization.
   * @param {Object} options
   * @param {boolean} options.useCompressedTimeline - When true, markers use compressed display timeline.
   */
  getInactiveMarkers(options = {}) {
    const { useCompressedTimeline = true } = options;
    const markers = [];

    if (!useCompressedTimeline) {
      for (const period of this.activityPeriods) {
        if (period.type !== 'inactive') continue;
        const durationMs = period.end - period.start;
        if (!Number.isFinite(durationMs) || durationMs < this.minInactiveDuration) continue;

        const startSeconds = (period.start - this.recordingStartTime) / 1000;
        const endSeconds = (period.end - this.recordingStartTime) / 1000;
        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) continue;

        const durationSeconds = durationMs / 1000;
        markers.push({
          start: Math.max(0, startSeconds),
          end: Math.max(0, endSeconds),
          originalDuration: durationSeconds,
          compressedDuration: durationSeconds
        });
      }
      return markers;
    }

    const compressedTimeline = this.getCompressedTimeline();
    for (const segment of compressedTimeline.timeline) {
      if (segment.type === 'inactive' && segment.compressed) {
        markers.push({
          start: segment.displayStart / 1000, // Convert to seconds
          end: segment.displayEnd / 1000,
          originalDuration: segment.originalDuration / 1000,
          compressedDuration: segment.compressedDuration / 1000
        });
      }
    }

    return markers;
  }
}

export default ActivityDetector;

