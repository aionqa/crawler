#!/usr/bin/env node
// executeAction.js
// Runs the AI-provided playwright_script for one action (no crawling).

import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'crypto';

// ---------- Scoped logger ----------
function scopedLogger(id) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => originalLog(`[${id}]`, ...args);
  console.warn = (...args) => originalWarn(`[${id}] ⚠️`, ...args);
  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
  };
}

// Create a run-scoped logger ID
const RUN_ID = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
const restoreLog = scopedLogger(RUN_ID);

const {
  MONGODB_URI = 'mongodb://127.0.0.1:27017',
  DB_NAME = 'spa',
  HEADLESS = 'true',
} = process.env;

const actionId = process.argv[2];
if (!actionId) {
  console.error('Usage: node executeAction.js <actionId>');
  restoreLog();
  process.exit(2);
}

console.log(`🚀 executeAction starting for action: ${actionId}`);
console.log(`🔧 Config → DB="${MONGODB_URI}/${DB_NAME}", HEADLESS=${HEADLESS}`);

const client = new MongoClient(MONGODB_URI);

(async () => {
  console.log('🧵 Connecting to MongoDB…');
  await client.connect();
  console.log('✅ MongoDB connected');

  const db = client.db(DB_NAME);
  const Actions = db.collection('actions');
  const Pages = db.collection('pages');
  const CodeTests = db.collection('code_tests');
  const Runs = db.collection('runs');

  // Load action + page
  const action = await Actions.findOne({ _id: new ObjectId(actionId) });
  if (!action) throw new Error(`Action not found: ${actionId}`);

  const pageDoc = await Pages.findOne({ _id: action.page_id });
  if (!pageDoc) throw new Error(`Page not found for action ${actionId}`);

  // Attach latest code test for this action, if present
  const codeTest = await CodeTests.findOne(
      { action_id: action._id },
      { sort: { created_at: -1 } }
  );
  if (!codeTest) throw new Error(`No code test attached to action ${actionId}`);

  const run = {
    action_id: action._id,
    page_id: pageDoc._id,
    project_id: pageDoc.project_id,
    started_at: new Date(),
    inputs: action.inputs ?? [],
    submit_button: action.submit_button ?? null,
    source: action.source ?? 'model',
  };
  const runId = (await Runs.insertOne({ ...run, general_outcome: 'action-run-started' })).insertedId;
  console.log(`📌 Run ID: ${String(runId)}`);

  console.log('🎭 Launching Playwright browser…');
  const browser = await chromium.launch({ headless: HEADLESS !== 'false' });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`🌐 Navigating to: ${pageDoc.url}`);
    await page.goto(pageDoc.url, { waitUntil: 'networkidle', timeout: 60_000 });
    console.log('✅ Navigation complete');

    console.log('🤖 Executing AI-generated script…');

    // UNSANDBOXED: running model-produced JS. Consider reviewing before execution.
    // Expects 'page' and optional 'params' arg.
    const fn = new Function('page', 'params', `
      return (async () => {
        ${codeTest.script}
      })();
    `);

    await fn(page, {});
    console.log('✅ Script execution finished');

    const afterUrl = page.url();
    console.log(`🔗 URL after execution: ${afterUrl}`);

    console.log('💾 Inserting success result…');
    const result = {
      run_id: runId,
      action_id: action._id,
      page_id: pageDoc._id,
      created_at: new Date(),
      ok: true,
      after_url: afterUrl,
      checks: codeTest.result_checks ?? [],
    };
    await db.collection('results').insertOne(result);

    console.log('🧾 Updating run(finish)…');
    await Runs.updateOne(
        { _id: runId },
        { $set: { finished_at: new Date(), general_outcome: 'action-run-success' } }
    );
  } catch (err) {
    console.warn('❌ Action execution failed:', err?.message || err);
    console.log('💾 Inserting failure result…');
    const result = {
      run_id: runId,
      action_id: action._id,
      page_id: pageDoc._id,
      created_at: new Date(),
      ok: false,
      error: String(err?.stack || err),
    };
    await db.collection('results').insertOne(result);

    console.log('🧾 Updating run(finish) → failure…');
    await Runs.updateOne(
        { _id: runId },
        { $set: { finished_at: new Date(), general_outcome: 'action-run-failure', logs: [String(err)] } }
    );
    throw err;
  } finally {
    console.log('🛑 Closing browser & DB…');
    await context.close();
    await browser.close();
    await client.close();
    restoreLog();
  }
})().catch(e => { console.error(e); process.exit(1); });
