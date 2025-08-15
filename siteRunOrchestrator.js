#!/usr/bin/env node
// siteRunOrchestrator.js — crawl a site (same host) and run both page analyzer and action executor per page
//
// Usage (new run):
//   node siteRunOrchestrator.js \
//     --seed_url https://example.com \
//     [--project_id <ObjectId>] \
//     [--username <login>] [--password <pass>] \
//     --analyzer_bin /path/to/singlePageAnalyzer.js \
//     --executor_bin /path/to/actionAiExecutor.js \
//     [--max_pages 200] [--max_depth 6] [--concurrency 1] [--headless=true]
//
// Usage (resume):
//   node siteRunOrchestrator.js --run_id <ObjectId> [--username ...] [--password ...] [--analyzer_bin ...] [--executor_bin ...] [--headless=true]
//
// Persists state in `runs` and `run_frontier` so you can pause/continue.

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { spawn } from 'child_process';
import * as cheerio from 'cheerio';
import crypto from 'crypto';

// ---------------- CLI ----------------
function argvToOpts(argv) {
    const o = {}; // <— no defaults here
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run_id') o.run_id = argv[++i];
        else if (a === '--project_id') o.project_id = argv[++i];
        else if (a === '--seed_url') o.seed_url = argv[++i];
        else if (a === '--username') o.username = argv[++i];
        else if (a === '--password') o.password = argv[++i];
        else if (a === '--analyzer_bin') o.analyzer_bin = argv[++i];
        else if (a === '--executor_bin') o.executor_bin = argv[++i];
        else if (a === '--headless') o.headless = argv[++i];
        else if (a === '--concurrency') o.concurrency = argv[++i];
        else if (a === '--max_pages') o.max_pages = argv[++i];
        else if (a === '--max_depth') o.max_depth = argv[++i];
    }
    return o;
}

const opts = argvToOpts(process.argv.slice(2));

function mustObjectId(id, flagName) {
    if (!id || !ObjectId.isValid(id)) {
        console.error(`${flagName} must be a valid ObjectId`);
        process.exit(2);
    }
    return new ObjectId(id);
}

// IMPORTANT: normalize URL identity (drop fragment)
function normalizeUrl(u) {
    try {
        const url = new URL(u);
        url.hash = '';
        return url.toString();
    } catch {
        return '';
    }
}

function sameHost(u, base) {
    try { const A = new URL(u); const B = new URL(base); return A.host === B.host; } catch { return false; }
}

// ---------------- Env & Mongo ----------------
const {
    MONGODB_URI = 'mongodb://127.0.0.1:27017',
    DB_NAME = 'spa',
} = process.env;

const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Projects = db.collection('projects');
const Pages = db.collection('pages');
const Actions = db.collection('actions');
const Runs = db.collection('runs');
const Frontier = db.collection('run_frontier');

// ---------------- Child process helpers ----------------
function runNodeScript(binPath, args, { env = process.env, debug = true, label } = {}) {
    return new Promise((resolve) => {
        const proc = spawn(process.execPath, [binPath, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env
        });

        const name = (label || binPath.split(/[\\/]/).pop());
        const tag = `[child:${name}#${proc.pid}]`;

        let out = '', err = '';

        if (debug) {
            const prettyArgs = args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
            console.log(`${tag} spawn: node ${binPath} ${prettyArgs}`);
        }

        proc.stdout.on('data', (d) => {
            const s = d.toString();
            out += s;
            if (debug) process.stdout.write(`${tag} ${s}`);
        });

        proc.stderr.on('data', (d) => {
            const s = d.toString();
            err += s;
            if (debug) process.stderr.write(`${tag} ${s}`);
        });

        proc.on('close', (code) => {
            if (debug) console.log(`${tag} exit ${code}`);
            resolve({ code, out, err });
        });
    });
}

async function upsertPage({ project_id, url }) {
    const u = normalizeUrl(url);
    const existing = await Pages.findOne({ project_id, url: u });
    if (existing) return existing._id;
    const doc = {
        project_id,
        url: u,
        created_at: new Date(),
        page_summary: null,
        html_file_id: null,
        screenshot_file_id: null,
        prompt_ref: null,
        reanalyzed: false,
    };
    const ins = await Pages.insertOne(doc);
    return ins.insertedId;
}

// ------------- Frontier helpers (with lease) -------------
const LEASE_MS = 60_000; // keep whatever you had

async function claimNextFrontier(runId) {
    const now = new Date();
    const leaseExpired = new Date(now.getTime() - LEASE_MS);

    const result = await Frontier.findOneAndUpdate(
        {
            run_id: runId,
            $or: [
                { status: 'pending' },
                { status: 'processing', picked_at: { $lt: leaseExpired } }
            ],
        },
        { $set: { status: 'processing', picked_at: now, updated_at: now } },
        {
            sort: { status: 1, depth: 1, _id: 1 },
            returnDocument: 'after',
            includeResultMetadata: true,
        }
    );

    if (!result) return null;
    const doc = Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
    return doc ?? null;
}

async function markFrontier(runFrontierId, patch) {
    await Frontier.updateOne({ _id: runFrontierId }, { $set: { ...patch, updated_at: new Date() } });
}

async function addToFrontier({ run_id, url, depth, discovered_from }) {
    const u = normalizeUrl(url);
    const exists = await Frontier.findOne({ run_id, url: u });
    if (exists) return exists._id;
    const doc = {
        run_id,
        url: u,
        depth,
        discovered_from: discovered_from ? normalizeUrl(discovered_from) : null,
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
        picked_at: null
    };
    const ins = await Frontier.insertOne(doc);
    return ins.insertedId;
}

function extractLinks(html, baseUrl) {
    const out = [];
    try {
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
            let href = $(el).attr('href') || '';
            if (!href) return;
            try { href = new URL(href, baseUrl).toString(); } catch { return; }
            if (!/^https?:\/\//i.test(href)) return;
            out.push(normalizeUrl(href)); // drop hash
        });
    } catch {}
    return Array.from(new Set(out));
}

async function fetchHtml(url) {
    try {
        const fetchImpl = globalThis.fetch || (await import('node-fetch')).default;
        const res = await fetchImpl(url, { redirect: 'follow' });
        if (!res.ok) return '';
        return await res.text();
    } catch { return ''; }
}

// Ensure there is at least one *claimable* URL in the frontier for this run
async function ensureFrontierSeeded(run) {
    const [pending, processing, total] = await Promise.all([
        Frontier.countDocuments({ run_id: run._id, status: 'pending' }),
        Frontier.countDocuments({ run_id: run._id, status: 'processing' }),
        Frontier.countDocuments({ run_id: run._id }),
    ]);
    if (total === 0 || (pending === 0 && processing === 0)) {
        await addToFrontier({ run_id: run._id, url: run.seed_url, depth: 0 });
        console.log('🌱 Seeded frontier with seed_url');
    }
}

async function logFrontierStats(runId) {
    const [p, pr, d] = await Promise.all([
        Frontier.countDocuments({ run_id: runId, status: 'pending' }),
        Frontier.countDocuments({ run_id: runId, status: 'processing' }),
        Frontier.countDocuments({ run_id: runId, status: 'done' }),
    ]);
    console.log(`Frontier — pending:${p} processing:${pr} done:${d}`);
}

// ---------------- Project resolution ----------------
function escapeForRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findOrCreateProjectByUrl(seed_url, providedProjectId, creds) {
    if (providedProjectId) {
        const _id = mustObjectId(providedProjectId, '--project_id');
        const proj = await Projects.findOne({ _id });
        if (!proj) throw new Error('Project not found for provided --project_id');
        if (creds?.username && creds?.password) {
            await Projects.updateOne({ _id }, { $set: { credentials: { type: 'login-form', username: creds.username, password: creds.password } } });
        }
        return await Projects.findOne({ _id });
    }

    const url = normalizeUrl(seed_url);
    if (!url) throw new Error('--seed_url must be a valid URL when --project_id is not provided');
    const host = new URL(url).host;

    // (1) Exact URL match
    const exact = await Pages.findOne({ url });
    if (exact) {
        if (creds?.username && creds?.password) {
            await Projects.updateOne({ _id: exact.project_id }, { $set: { credentials: { type: 'login-form', username: creds.username, password: creds.password } } });
        }
        return await Projects.findOne({ _id: exact.project_id });
    }

    // (2) Any page on same host → unique project?
    const escapedHost = escapeForRegex(host);
    const hostPattern = new RegExp(`^https?://${escapedHost}(?:[/:?#]|$)`, 'i');
    const cursor = Pages.find({ url: { $regex: hostPattern } });
    const projIds = new Set();
    for await (const p of cursor) projIds.add(String(p.project_id));
    if (projIds.size === 1) {
        const _id = new ObjectId([...projIds][0]);
        if (creds?.username && creds?.password) {
            await Projects.updateOne({ _id }, { $set: { credentials: { type: 'login-form', username: creds.username, password: creds.password } } });
        }
        return await Projects.findOne({ _id });
    }

    // (3) Create a new project
    const name = host;
    const baseDoc = { name, created_at: new Date(), cookies: [], credentials: null };
    if (creds?.username && creds?.password) baseDoc.credentials = { type: 'login-form', username: creds.username, password: creds.password };
    const ins = await Projects.insertOne(baseDoc);
    return await Projects.findOne({ _id: ins.insertedId });
}

// ---------------- DB bootstrap (create collections/indexes if missing) ----------------
async function ensureDatabaseSetup() {
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
    async function ensureCollection(name) {
        if (!existing.has(name)) {
            await db.createCollection(name);
            console.log(`🆕 Created collection: ${name}`);
        }
        return db.collection(name);
    }
    await ensureCollection('projects');
    await ensureCollection('pages');
    await ensureCollection('actions');
    await ensureCollection('runs');
    await ensureCollection('run_frontier');

    await Projects.createIndex({ name: 1 }, { name: 'projects_name_idx' });

    await Pages.createIndex({ project_id: 1, url: 1 }, { unique: true, name: 'pages_project_url_uq' });
    await Pages.createIndex({ project_id: 1 }, { name: 'pages_project_idx' });

    await Actions.createIndex({ project_id: 1, page_id: 1 }, { name: 'actions_project_page_idx' });

    await Runs.createIndex({ project_id: 1 }, { name: 'runs_project_idx' });
    await Runs.createIndex({ status: 1, created_at: -1 }, { name: 'runs_status_created_idx' });

    await Frontier.createIndex({ run_id: 1, url: 1 }, { unique: true, name: 'frontier_run_url_uq' });
    await Frontier.createIndex({ run_id: 1, status: 1, picked_at: 1, depth: 1 }, { name: 'frontier_claim_idx' });
}

// ---------------- Run management ----------------
async function ensureRun(opts) {
    if (opts.run_id) {
        const _id = mustObjectId(opts.run_id, '--run_id');
        const doc = await Runs.findOne({ _id });
        if (!doc) throw new Error('Run not found');

        if (opts.username && opts.password) {
            await Projects.updateOne({ _id: doc.project_id }, { $set: { credentials: { type: 'login-form', username: opts.username, password: opts.password } } });
        }
        return doc;
    }

    const seed_url = normalizeUrl(opts.seed_url);
    if (!seed_url) throw new Error('--seed_url is required for a new run');

    const project = await findOrCreateProjectByUrl(seed_url, opts.project_id, { username: opts.username, password: opts.password });
    const project_id = project._id;

    const host = new URL(seed_url).host;
    const runDoc = {
        project_id,
        seed_url,
        allowed_host: host,
        status: 'running',
        created_at: new Date(),
        updated_at: new Date(),
        stop_requested: false,
        options: {
            headless: String(opts.headless ?? 'true'),
            analyzer_bin: opts.analyzer_bin || './singlePageAnalyzer.js',
            executor_bin: opts.executor_bin || './actionAiExecutor.js',
            max_pages: Number(opts.max_pages || '200'),
            max_depth: Number(opts.max_depth || '6'),
            concurrency: Number(opts.concurrency || '1'),
        },
        stats: { pages_claimed: 0, pages_done: 0, actions_run: 0, errors: 0, last_url: null },
        notes: [],
    };
    const ins = await Runs.insertOne(runDoc);
    const run_id = ins.insertedId;
    await addToFrontier({ run_id, url: seed_url, depth: 0 });
    return await Runs.findOne({ _id: run_id });
}

async function updateRun(_id, patch) {
    await Runs.updateOne({ _id }, { $set: { ...patch, updated_at: new Date() } });
}

async function tickStopFlag(run) {
    const fresh = await Runs.findOne({ _id: run._id });
    return !!fresh?.stop_requested;
}

async function analyzeAndExecuteForPage({ run, pageUrl }) {
    const { project_id } = run;
    const analyzer = run.options.analyzer_bin;
    const executor = run.options.executor_bin;

    // 1) Ensure page doc exists
    const page_id = await upsertPage({ project_id: run.project_id, url: pageUrl });

    // 2) Analyze page to discover actions
    const aArgs = ['--url', pageUrl, '--project', String(project_id), '--page_id', String(page_id), '--force'];
    const aRes = await runNodeScript(analyzer, aArgs, { label: `analyzer ${new URL(pageUrl).pathname}` });

    // Persist analyzer note
    const pageLog = { stage: 'analyze', url: pageUrl, exit_code: aRes.code, out: aRes.out.slice(0, 4000), err: aRes.err.slice(0, 4000), ts: new Date() };
    await Runs.updateOne({ _id: run._id }, { $push: { notes: pageLog }, $set: { 'stats.last_url': pageUrl } });

    // Fail fast if analyzer crashed
    if (aRes.code !== 0) {
        throw new Error(`Analyzer failed for ${pageUrl} (exit ${aRes.code})`);
    }

    // 3) For each action on that page, run executor
    // (tolerate either ObjectId or string stored by analyzer)
    const actions = await Actions.find({
        $or: [
            { project_id: run.project_id, page_id },
            { project_id: String(run.project_id), page_id: String(page_id) }
        ]
    }).toArray();

    for (const action of actions) {
        const eArgs = [
            '--project_id', String(project_id),
            '--page_id', String(page_id),
            '--action_id', String(action._id),
            '--headless', String(run.options.headless)
        ];
        const eRes = await runNodeScript(executor, eArgs, { label: `executor ${action._id}` });
        await Runs.updateOne(
            { _id: run._id },
            { $inc: { 'stats.actions_run': 1 }, $push: { notes: { stage: 'execute', url: pageUrl, action_id: action._id, exit_code: eRes.code, out: eRes.out.slice(0, 4000), err: eRes.err.slice(0, 4000), ts: new Date() } } }
        );
    }

    // 4) Fetch HTML and extract same-host links
    const html = await fetchHtml(pageUrl);
    let links = extractLinks(html, pageUrl);
    links = links.filter(u => sameHost(u, run.seed_url));

    return { page_id, links };
}

async function main() {
    await client.connect();
    console.log('✅ MongoDB connected');

    await ensureDatabaseSetup();

    let run = await ensureRun(opts);

    const patch = { options: { ...run.options } };

    if (opts.analyzer_bin) patch.options.analyzer_bin = opts.analyzer_bin;
    if (opts.executor_bin) patch.options.executor_bin = opts.executor_bin;
    if (typeof opts.headless !== 'undefined') patch.options.headless = String(opts.headless);
    if (typeof opts.max_pages !== 'undefined')   patch.options.max_pages = Number(opts.max_pages);
    if (typeof opts.max_depth !== 'undefined')   patch.options.max_depth = Number(opts.max_depth);
    if (typeof opts.concurrency !== 'undefined') patch.options.concurrency = Number(opts.concurrency);

    await updateRun(run._id, patch);
    run = await Runs.findOne({ _id: run._id });

    console.log(`▶️  Run ID: ${run._id}`);

    await ensureFrontierSeeded(run);

    let stopping = false;
    process.on('SIGINT', async () => {
        console.log(`\n✋ Caught SIGINT; marking run paused…`);
        stopping = true;
        await updateRun(run._id, { status: 'paused' });
        process.exit(130);
    });

    await updateRun(run._id, { status: 'running' });

    await Frontier.updateMany({ run_id: run._id, status: 'processing' }, { $set: { status: 'pending' } });

    while (!stopping) {
        if (await tickStopFlag(run)) {
            console.log('🛑 stop_requested=true — pausing');
            await updateRun(run._id, { status: 'paused' });
            break;
        }

        const doneCount = await Frontier.countDocuments({ run_id: run._id, status: 'done' });
        if (doneCount >= run.options.max_pages) {
            console.log(`⛳ Reached max_pages=${run.options.max_pages}`);
            await updateRun(run._id, { status: 'done' });
            break;
        }

        await logFrontierStats(run._id);

        let item = await claimNextFrontier(run._id);
        if (!item) {
            await ensureFrontierSeeded(run);
            item = await claimNextFrontier(run._id);
            if (!item) {
                const [p, pr] = await Promise.all([
                    Frontier.countDocuments({ run_id: run._id, status: 'pending' }),
                    Frontier.countDocuments({ run_id: run._id, status: 'processing' }),
                ]);
                if (p === 0 && pr === 0) {
                    await updateRun(run._id, { status: 'done' });
                    console.log('🎉 Frontier empty — run complete');
                    break;
                }
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
        }

        try {
            if (item.depth > run.options.max_depth) {
                await markFrontier(item._id, { status: 'done', reason: 'max_depth' });
                continue;
            }

            await Runs.updateOne({ _id: run._id }, { $inc: { 'stats.pages_claimed': 1 } });

            console.log(`\n🌐 Page: ${item.url} (depth ${item.depth})`);
            const { page_id, links } = await analyzeAndExecuteForPage({ run, pageUrl: item.url });

            for (const href of links) {
                if (!sameHost(href, run.seed_url)) continue;
                await addToFrontier({ run_id: run._id, url: normalizeUrl(href), depth: item.depth + 1, discovered_from: item.url });
            }

            await markFrontier(item._id, { status: 'done', page_id });
            await Runs.updateOne({ _id: run._id }, { $inc: { 'stats.pages_done': 1 } });

        } catch (err) {
            console.error('❌ Error on page:', item.url, err?.message || err);
            await markFrontier(item._id, { status: 'done', error: String(err?.message || err) });
            await Runs.updateOne({ _id: run._id }, { $inc: { 'stats.errors': 1 }, $push: { notes: { stage: 'error', url: item.url, err: String(err?.stack || err), ts: new Date() } } });
        }

        run = await Runs.findOne({ _id: run._id });
    }

    await client.close();
}

main().catch(async (e) => {
    console.error(e);
    try { await client.close(); } catch {}
    process.exit(1);
});
