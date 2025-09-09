#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync, createWriteStream, readFileSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE = path.resolve(__dirname, '..');
const startedProcs = [];

const MAX_WAIT = Number(process.env.MAX_WAIT || 20); // seconds
const CURL_MAX_TIME = Number(process.env.CURL_MAX_TIME || 15); // seconds

function log(msg) { process.stdout.write(`[test] ${msg}\n`); }
function debug(msg) { process.stdout.write(`[debug ${new Date().toTimeString().split(' ')[0]}] ${msg}\n`); }

function httpGetOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { resolve(res.statusCode >= 200 && res.statusCode < 300); });
    req.on('error', () => resolve(false));
    req.setTimeout(CURL_MAX_TIME * 1000, () => { try { req.destroy(); } catch {} resolve(false); });
  });
}

function rpc(url, body) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(CURL_MAX_TIME * 1000, () => { try { req.destroy(new Error('timeout')); } catch {} });
    req.write(data);
    req.end();
  });
}

async function waitFor(fn, label) {
  for (let i = 0; i < MAX_WAIT; i++) {
    const ok = await fn();
    if (ok) return true;
    process.stdout.write('.');
    await delay(1000);
  }
  process.stdout.write('\n');
  throw new Error(`timeout waiting for ${label}`);
}

function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function startProc(name, cwd, cmd, args, env = {}) {
  const logfile = path.join(BASE, `.test-${name}.log`);
  const out = createWriteStream(logfile, { flags: 'w' });
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  writeFileSync(path.join(BASE, `.test-${name}.pid`), String(child.pid));
  child.once('exit', () => { try { out.end(); } catch {} });
  const proc = { child, logfile, out, name };
  startedProcs.push(proc);
  return proc;
}

async function stopProc(proc, forceAfterMs = 1000) {
  if (!proc?.child || proc.child.killed) return;
  try { proc.child.kill('SIGTERM'); } catch {}
  const pExit = new Promise((resolve) => proc.child.once('exit', () => resolve()))
  await Promise.race([pExit, delay(forceAfterMs)]);
  if (!proc.child.killed) { try { proc.child.kill('SIGKILL'); } catch {} }
  if (proc.out) { try { proc.out.end(); } catch {} }
}

async function finalCleanup() {
  for (const p of startedProcs.splice(0)) {
    try { await stopProc(p); } catch {}
  }
}

async function ensurePlaywright(repoDir) {
  if (!existsSync(path.join(repoDir, 'package.json'))) return;
  const pkg = JSON.parse(readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
  if (!pkg.dependencies || !pkg.dependencies.playwright) return;
  log(`Installing Playwright browsers for ${path.basename(repoDir)} (up to 60s)`);
  const proc = startProc('pw-install', repoDir, 'npx', ['-y', 'playwright', 'install', 'chromium']);
  // Let it run for up to 60s
  await Promise.race([delay(60000), new Promise((r) => proc.child.on('exit', r))]);
  await stopProc(proc); // kill if still running
}

async function testUI() {
  log('UI build and preview');
  const uiDir = path.join(BASE, 'ui');
  // Build
  await new Promise((resolve, reject) => {
    const b = spawn('npm', ['run', '-s', 'build'], { cwd: uiDir, stdio: 'inherit' });
    b.on('exit', (code) => code === 0 ? resolve() : reject(new Error('ui build failed')));
  });
  const port = Number(process.env.UI_PORT || 5173);
  const proc = startProc('ui', uiDir, 'npm', ['run', '-s', 'preview', '--', '--port', String(port), '--strictPort']);
  try {
    await waitFor(async () => {
      const a = await httpGetOk(`http://127.0.0.1:${port}/`).catch(() => false);
      if (a) return true;
      const b = await httpGetOk(`http://localhost:${port}/`).catch(() => false);
      return b;
    }, `ui:${port}`);
    log('UI OK');
  } finally {
    await stopProc(proc);
  }
}

async function testAgentHealth(name, dir, port) {
  log(`${name} health`);
  await ensurePlaywright(dir);
  const proc = startProc(name, dir, 'node', ['src/server.js'], { PORT: String(port) });
  try {
    await waitFor(async () => {
      try {
        const r = await rpc(`http://127.0.0.1:${port}/rpc`, { jsonrpc: '2.0', id: '1', method: 'health', params: {} });
        return r.status === 200;
      } catch { return false; }
    }, `${name} health`);
    log(`${name} OK`);
  } finally {
    await stopProc(proc);
  }
}

async function testLogin(name, dir, port) {
  log(`${name} attemptLogin on PracticeTestAutomation`);
  await ensurePlaywright(dir);
  const proc = startProc(name, dir, 'node', ['src/server.js'], { PORT: String(port) });
  try {
    await waitFor(async () => {
      try {
        const r = await rpc(`http://127.0.0.1:${port}/rpc`, { jsonrpc: '2.0', id: '1', method: 'health', params: {} });
        return r.status === 200;
      } catch { return false; }
    }, `${name} health`);
    const body = {
      jsonrpc: '2.0', id: '1', method: 'attemptLogin', params: {
        url: 'https://practicetestautomation.com/practice-test-login/',
        credentials: { username: 'student', password: 'Password123' },
        options: { maxWaitMsPerAction: 20000, maxRetries: 1, headless: true }
      }
    };
    const r = await rpc(`http://127.0.0.1:${port}/rpc`, body);
    if (r.status !== 200 || !/"success":\s*true/.test(String(r.body || ''))) {
      throw new Error(`${name} attemptLogin failed`);
    }
    log(`${name} login OK`);
  } finally {
    await stopProc(proc);
  }
}

async function testBackend() {
  log('backend /healthz');
  const reachable = await tcpReachable('127.0.0.1', 27017);
  if (!reachable) { log('MongoDB not reachable, skipping backend test'); return; }
  const port = Number(process.env.BACK_PORT || 4000);
  const proc = startProc('backend', path.join(BASE, 'back'), 'node', ['src/index.js'], { PORT: String(port) });
  try {
    await waitFor(() => httpGetOk(`http://127.0.0.1:${port}/healthz`), `backend:${port}`);
    log('backend OK');
  } finally {
    await stopProc(proc);
  }
}

async function main() {
  const which = process.argv[2] || 'all';
  switch (which) {
    case 'ui':
      await testUI();
      break;
    case 'crawler-text':
      await testAgentHealth('crawler-text', path.join(BASE, 'crawler-text'), 3101);
      break;
    case 'crawler-media':
      await testAgentHealth('crawler-media', path.join(BASE, 'crawler-media'), 3102);
      break;
    case 'crawler-simplified':
      await testAgentHealth('crawler-simplified', path.join(BASE, 'crawler-simplified'), 3103);
      break;
    case 'crawler-static':
      await testAgentHealth('crawler-static', path.join(BASE, 'crawler-static'), 3104);
      break;
    case 'login-text':
      await testLogin('login-text', path.join(BASE, 'login-text'), 3002);
      break;
    case 'login-simplified':
      await testLogin('login-simplified', path.join(BASE, 'login-simplified'), 3001);
      break;
    case 'login-static':
      await testLogin('login-static', path.join(BASE, 'login-static'), 3004);
      break;
    case 'back':
      await testBackend();
      break;
    case 'all':
      await testUI();
      await testAgentHealth('crawler-text', path.join(BASE, 'crawler-text'), 3101);
      await testAgentHealth('crawler-media', path.join(BASE, 'crawler-media'), 3102);
      await testAgentHealth('crawler-simplified', path.join(BASE, 'crawler-simplified'), 3103);
      await testAgentHealth('crawler-static', path.join(BASE, 'crawler-static'), 3104);
      await testLogin('login-simplified', path.join(BASE, 'login-simplified'), 3001);
      await testLogin('login-text', path.join(BASE, 'login-text'), 3002);
      await testLogin('login-static', path.join(BASE, 'login-static'), 3004);
      await testBackend();
      break;
    default:
      console.error('Usage: node scripts/test-all.mjs [ui|crawler-static|login-text|login-static|back|all]');
      process.exit(2);
  }
}

main().then(() => {
  // Force clean exit to avoid any lingering open handles
  process.exit(0);
}).catch((e) => {
  console.error('[error]', e?.message || e);
  process.exit(1);
});


