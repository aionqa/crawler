/**
 * OWASP ZAP baseline scan runner
 * Runs ZAP in command-line mode (-quickurl) and produces a JSON report.
 * Report is written to the given output path; caller uploads to backend.
 */

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import net from 'net';

const ZAP_HOME = process.env.ZAP_HOME || '/opt/zap';
const ZAP_SCRIPT = `${ZAP_HOME}/zap.sh`;
const DEFAULT_SPIDER_MINS = 1;
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

async function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = (address && typeof address === 'object') ? address.port : null;
      server.close((err) => {
        if (err) return reject(err);
        if (!port) return reject(new Error('Unable to allocate free TCP port'));
        resolve(port);
      });
    });
  });
}

/**
 * Run ZAP baseline scan against target URL.
 * Uses -quickurl for a quick passive scan (no active attacks).
 * @param {string} targetUrl - Full URL to scan (e.g. https://example.com)
 * @param {string} reportPath - Absolute path for JSON report output
 * @returns {Promise<{ success: boolean, reportPath?: string, summary?: object, error?: string }>}
 */
export async function runZapBaseline(targetUrl, reportPath = '/tmp/zap-report.json') {
  if (!targetUrl || !targetUrl.startsWith('http')) {
    return { success: false, error: 'Invalid target URL (must be http(s)://)' };
  }

  if (!existsSync(ZAP_SCRIPT)) {
    return { success: false, error: `ZAP not found at ${ZAP_SCRIPT}. Install ZAP in the container image.` };
  }

  const zapPort = await allocateFreePort().catch(() => 0);
  return new Promise((resolve) => {
    const args = [
      '-cmd',
      ...(zapPort > 0 ? ['-port', String(zapPort)] : []),
      '-quickurl', targetUrl,
      '-quickout', reportPath,
      '-quickprogress'
    ];

    const proc = spawn(ZAP_SCRIPT, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ZAP_HOME }
    });

    let stderr = '';
    let stdout = '';
    const startTime = Date.now();

    proc.stdout?.on('data', (chunk) => { stdout += chunk; });
    proc.stderr?.on('data', (chunk) => { stderr += chunk; });

    proc.on('error', (err) => {
      resolve({ success: false, error: `ZAP spawn error: ${err.message}` });
    });

    proc.on('close', (code, signal) => {
      const durationMs = Date.now() - startTime;
      // ZAP exit codes: 0 = success, 1 = FAIL, 2 = WARN, 3 = other
      const completed = code !== null && code !== 127;
      if (!existsSync(reportPath)) {
        resolve({
          success: false,
          error: `ZAP did not produce report (code=${code}, signal=${signal}). stderr: ${stderr.slice(-500)}`
        });
        return;
      }

      readFile(reportPath, 'utf8')
        .then((raw) => {
          let summary = { high: 0, medium: 0, low: 0, informational: 0, total: 0 };
          try {
            const data = JSON.parse(raw);
            const alerts = data?.site?.[0]?.alerts ?? data?.alerts ?? [];
            summary.total = alerts.length;
            for (const a of alerts) {
              const risk = String(a.risk || a.riskcode || '').toLowerCase();
              if (risk === 'high') summary.high++;
              else if (risk === 'medium') summary.medium++;
              else if (risk === 'low') summary.low++;
              else summary.informational++;
            }
          } catch (_) {
            // Keep default summary
          }
          resolve({
            success: true,
            reportPath,
            summary,
            duration_ms: durationMs,
            exitCode: code,
            signal
          });
        })
        .catch((err) => {
          resolve({
            success: true,
            reportPath,
            summary: { high: 0, medium: 0, low: 0, informational: 0, total: 0 },
            duration_ms: durationMs,
            readError: err.message
          });
        });
    });

    // Timeout
    const t = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch (_) {}
      if (!existsSync(reportPath)) {
        resolve({
          success: false,
          error: `ZAP scan timed out after ${MAX_WAIT_MS / 60000} minutes`
        });
      } else {
        readFile(reportPath, 'utf8')
          .then((raw) => {
            let summary = { high: 0, medium: 0, low: 0, informational: 0, total: 0 };
            try {
              const data = JSON.parse(raw);
              const alerts = data?.site?.[0]?.alerts ?? data?.alerts ?? [];
              summary.total = alerts.length;
              for (const a of alerts) {
                const risk = String(a.risk || a.riskcode || '').toLowerCase();
                if (risk === 'high') summary.high++;
                else if (risk === 'medium') summary.medium++;
                else if (risk === 'low') summary.low++;
                else summary.informational++;
              }
            } catch (_) {}
            resolve({
              success: true,
              reportPath,
              summary,
              duration_ms: MAX_WAIT_MS,
              timeout: true
            });
          })
          .catch(() => resolve({ success: false, error: 'ZAP scan timed out and report read failed' }));
      }
    }, MAX_WAIT_MS);

    proc.on('close', () => clearTimeout(t));
  });
}
