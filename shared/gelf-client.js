/**
 * GELF Client for sending logs directly to Graylog
 * Used by agents to send logs via GELF protocol
 */

import axios from 'axios';

class GELFClient {
  constructor(graylogGelfUrl = 'http://graylog:12201') {
    this.graylogGelfUrl = graylogGelfUrl;
    this.enabled = process.env.GRAYLOG_ENABLED !== 'false';
  }

  /**
   * Send a log entry to Graylog via GELF
   */
  async sendLog(level, message, additionalFields = {}) {
    if (!this.enabled) {
      console.debug('GELF: Graylog disabled, skipping log');
      return;
    }

    try {
      const gelfMessage = {
        version: '1.1',
        host: process.env.HOSTNAME || 'aionqa-agent',
        short_message: message,
        timestamp: new Date().getTime() / 1000,
        level: this.mapLevel(level),
        ...additionalFields
      };

      // Send via GELF HTTP
      await axios.post(`${this.graylogGelfUrl}/gelf`, gelfMessage, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      console.debug(`GELF: Log sent successfully - ${level}: ${message}`);
    } catch (error) {
      console.error(`GELF: Failed to send log - ${error.message}`);
      // Don't throw - logging should not break the application
    }
  }

  /**
   * Send job-specific log
   */
  async sendJobLog(jobId, level, message, component = 'agent', metadata = {}) {
    await this.sendLog(level, message, {
      _jobId: jobId,
      _component: component,
      _agentName: process.env.AGENT_NAME || 'unknown',
      ...metadata
    });
  }

  /**
   * Map application levels to GELF levels
   */
  mapLevel(level) {
    const mapping = {
      debug: 7,
      info: 6,
      notice: 5,
      warn: 4,
      error: 3,
      critical: 2,
      alert: 1,
      emergency: 0
    };
    return mapping[level.toLowerCase()] || 6; // Default to info
  }

  /**
   * Convenience methods
   */
  async debug(message, metadata = {}) {
    return this.sendLog('debug', message, metadata);
  }

  async info(message, metadata = {}) {
    return this.sendLog('info', message, metadata);
  }

  async warn(message, metadata = {}) {
    return this.sendLog('warn', message, metadata);
  }

  async error(message, metadata = {}) {
    return this.sendLog('error', message, metadata);
  }
}

// Create singleton instance
const gelfClient = new GELFClient();

export default gelfClient;

