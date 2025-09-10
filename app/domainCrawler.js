import { analyzePage } from '/app/ai/pageAnalysis.js';
import { openai } from '/app/ai/client.js';
import { codeWrap, safeEvalFunction } from '/app/runtime/sandbox.js';
import { buildLoginMessages } from '/app/ai/login.js';
import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { z } from 'zod';

// ------------- CLI -------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') o.project = argv[++i];
    else if (a === '--config') o.config = argv[++i];
    else if (a === '--max-pages') o.maxPages = parseInt(argv[++i]);
    else if (a === '--max-depth') o.maxDepth = parseInt(argv[++i]);
    else if (a === '--job-id') o.jobId = argv[++i];
    else if (a === '--force') o.force = true;
  }
  return o;
}

const { 
  project: projectRaw, 
  config: configRaw, 
  maxPages = 100, 
  maxDepth = 3, 
  jobId: JOB_ID,
  force: FORCE 
} = parseArgs(process.argv.slice(2));

if (!projectRaw || !ObjectId.isValid(projectRaw)) {
  console.error('Error: --project must be a valid Mongo ObjectId (24 hex chars).');
  process.exit(2);
}

if (!configRaw || !ObjectId.isValid(configRaw)) {
  console.error('Error: --config must be a valid Mongo ObjectId (24 hex chars).');
  process.exit(2);
}

const PROJECT_ID = new ObjectId(projectRaw);
const CONFIG_ID = new ObjectId(configRaw);

// ---------------- Env ----------------
const {
  OPENAI_API_KEY,
  MONGODB_URI = 'mongodb://127.0.0.1:27017',
  DB_NAME = 'spa',
} = process.env;

if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

// ---------------- Mongo ----------------
const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Projects = db.collection('projects');
const Pages = db.collection('pages');
const Actions = db.collection('actions');
const Prompts = db.collection('prompts');
const Configurations = db.collection('configurations');
const Runs = db.collection('runs');
const bucket = new GridFSBucket(db, { bucketName: 'artifacts' });

// ---------------- Utils ----------------
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function identityUrl(u) { const x = new URL(u); x.hash = ''; return x.toString(); }

async function uploadToGridFS({ filename, buffer, contentType, metadata }) {
  return new Promise((resolve, reject) => {
    const up = bucket.openUploadStream(filename, { contentType, metadata });
    up.on('finish', () => resolve(up.id));
    up.on('error', reject);
    up.end(buffer);
  });
}

async function toDataUrlPng(buf) { return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`; }

function deriveShortSummary(html) {
  try {
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g,' ').trim();
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const base = [title, h1].filter(Boolean).join(' — ');
    if (!base) return 'Web page summary unavailable.';
    const words = base.split(/\s+/);
    return words.slice(0, 40).join(' ');
  } catch { return 'Web page summary unavailable.'; }
}

// ---- Zod schema for model output ----
const OptStr = z.string().trim().min(1).max(20000).nullish();
const ShortStr = z.string().trim().min(1).max(280);
const NonEmptyStr = z.string().trim().min(1).max(20000);
const Sel = z.object({ best: OptStr, css: OptStr, xpath: OptStr }).strict();
const InteractiveElement = z.object({
  element_type: z.enum(['form','button','link','input','select','textarea','other']),
  id: OptStr, name: OptStr, text: OptStr, role: OptStr, action: OptStr, method: OptStr, href: OptStr, target: OptStr,
  selectors: Sel.nullish(),
  inputs: z.array(z.object({
    label: OptStr, name: OptStr, id: OptStr, type: OptStr, placeholder: OptStr, selectors: Sel.nullish(), example_value: OptStr,
  }).strict()).default([]),
  submit_button: z.object({ text: OptStr, selectors: Sel.nullish() }).nullish(),
  playwright_script: OptStr,
  result_checks: z.array(z.object({
    kind: z.enum(['url_contains','selector_visible','text_present','network_call']),
    value: NonEmptyStr,
  }).strict()).default([]),
  ai_confidence: z.number().min(0).max(1).nullish(),
}).strict();

const ModelResponse = z.object({
  page_summary: ShortStr,
  interactive_elements: z.array(InteractiveElement),
}).strict();

// ---- Crawling Logic ----
class DomainCrawler {
  constructor(config, projectId) {
    this.config = config;
    this.projectId = projectId;
    this.visitedUrls = new Set();
    this.urlQueue = [];
    this.discoveredUrls = new Set();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.runId = null;
    this.videoFileId = null;
  }

  async initialize() {
    console.log('🚀 Initializing domain crawler...');
    console.log(`📋 Project ID: ${PROJECT_ID}`);
    console.log(`📋 Config ID: ${CONFIG_ID}`);
    console.log(`📋 Max Pages: ${maxPages}`);
    console.log(`📋 Max Depth: ${maxDepth}`);
    console.log(`📋 Job ID: ${JOB_ID}`);
    
    // Set up global timeout for the entire crawler
    this.globalTimeout = setTimeout(() => {
      console.log('⏰ Global timeout reached, shutting down crawler...');
      this.cleanup().catch(() => {});
      process.exit(1);
    }, 10 * 60 * 1000); // 10 minutes global timeout
    
    // Use provided job ID or create new run record
    if (JOB_ID) {
      this.runId = new ObjectId(JOB_ID);
      console.log(`📋 Using existing job ID: ${JOB_ID}`);
    } else {
      // Create run record (fallback for direct execution)
      const runDoc = {
        project_id: this.projectId,
        configuration_id: this.config._id,
        status: 'running',
        start_time: new Date(),
        seed_url: this.config.domain,
        discovered_urls: 0,
        analyzed_pages: 0,
        errors: 0,
        max_pages: maxPages,
        max_depth: maxDepth
      };
      
      const runResult = await Runs.insertOne(runDoc);
      this.runId = runResult.insertedId;
    }
    
    // Launch browser with configuration and timeout
    const browserTimeout = setTimeout(() => {
      throw new Error('Browser launch timeout');
    }, 30000); // 30 second browser launch timeout
    
    try {
      this.browser = await chromium.launch({ 
        headless: true, // Force headless mode in Docker
        timeout: 30000, // 30 second timeout for browser launch
        executablePath: '/usr/bin/chromium-browser', // Use system Chromium
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });
      clearTimeout(browserTimeout);
    } catch (error) {
      clearTimeout(browserTimeout);
      throw error;
    }
    
    this.context = await this.browser.newContext({
      userAgent: this.config.user_agent || undefined,
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: path.join('/tmp', 'aionqa_videos') }
    });
    
    this.page = await this.context.newPage();
    
    // Set comprehensive timeouts
    this.page.setDefaultTimeout(this.config.timeout || 30000);
    this.page.setDefaultNavigationTimeout(60000); // 60 second navigation timeout
    
    console.log(`✅ Browser initialized with config: ${this.config.name}`);
  }

  async login() {
    if (!this.config.login_enabled || !this.config.login_url) {
      console.log('ℹ️ No login required');
      return true;
    }

    console.log('🔐 Attempting login...');
    
    // Set up login timeout
    const loginTimeout = setTimeout(() => {
      console.log('⏰ Login timeout reached');
      throw new Error('Login timeout');
    }, 2 * 60 * 1000); // 2 minutes login timeout
    
    try {
      // Utility helpers for staged login (purely generic; no static IDs)
      const waitForMeaningfulChange = async (prevUrl, prevHtmlHash, timeoutMs = 60_000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const nowUrl = this.page.url();
          if (nowUrl && nowUrl !== prevUrl) return true;
          try {
            const nowHtml = await this.page.content();
            const nowHash = sha1(Buffer.from(String(nowHtml||''), 'utf8'));
            if (nowHash !== prevHtmlHash) return true;
          } catch {}
          await this.page.waitForTimeout(1000).catch(()=>{});
        }
        return false;
      };

      const queryOne = async (producer) => {
        try {
          const loc = producer();
          const first = loc.first();
          if (await first.isVisible({ timeout: 500 }).catch(()=>false)) return first;
        } catch {}
        return null;
      };

      const fillEmailIfPresent = async (username) => {
        const byRole = await queryOne(() => this.page.getByRole('textbox', { name: /email|user|login/i }));
        const byType = (await queryOne(() => this.page.locator('input[type="email"]'))) ||
          (await queryOne(() => this.page.locator('input[type="text"][name*="email" i]')));
        const target = byRole || byType;
        if (target) { try { await target.fill(String(username), { timeout: 5000 }); return true; } catch {} }
        return false;
      };

      const clickPrimaryContinueOrSubmit = async () => {
        const candidates = [
          () => this.page.getByRole('button', { name: /continue|next|sign\s*in|log\s*in|submit|verify/i }),
          () => this.page.locator('button[type="submit"]'),
          () => this.page.locator('input[type="submit"]'),
          () => this.page.locator('button')
        ];
        for (const make of candidates) {
          const loc = await queryOne(make);
          if (loc) { try { await loc.click({ timeout: 5000 }); return true; } catch {} }
        }
        return false;
      };

      const fillPasswordIfPresent = async (password) => {
        const passLoc = (await queryOne(() => this.page.getByRole('textbox', { name: /pass(word)?/i }))) ||
          (await queryOne(() => this.page.locator('input[type="password"]')));
        if (passLoc) { try { await passLoc.fill(String(password), { timeout: 5000 }); return true; } catch {} }
        return false;
      };

      await this.page.goto(this.config.login_url, { waitUntil: 'load', timeout: 60000 }).catch(()=>{});
      try { await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}

      // Capture login page as a Page document so UI can show it
      try {
        const loginHtml = await this.page.content();
        const loginShot = await this.page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
        const pageId = await this.savePage(this.config.login_url, loginHtml, loginShot, deriveShortSummary(loginHtml));
        await Runs.updateOne({ _id: this.runId }, { $set: { login_page_id: pageId } });
      } catch {}

      const beforeUrl = this.page.url();
      const beforeHtml = await this.page.content();
      const beforeHash = sha1(Buffer.from(String(beforeHtml||''), 'utf8'));

      // Ask the coding model for generic Playwright statements (no hardcoded ids/names)
      const loginMsgs = buildLoginMessages({ loginUrl: this.config.login_url });
      // Persist the prompt for UI visibility
      try {
        await Prompts.insertOne({
          project_id: this.projectId,
          name: 'Login coder prompt',
          content: JSON.stringify(loginMsgs, null, 2),
          type: 'action',
          created_at: new Date(),
          updated_at: new Date()
        });
      } catch {}
      const chat = await openai.chat.completions.create({ model: 'gpt-5-mini', messages: loginMsgs });
      const statements = (chat.choices?.[0]?.message?.content || '').trim();
      // Persist the generated code as a custom prompt for auditability
      try {
        if (statements) {
          await Prompts.insertOne({
            project_id: this.projectId,
            name: 'Login AI code',
            content: statements,
            type: 'custom',
            created_at: new Date(),
            updated_at: new Date()
          });
        }
      } catch {}
      const wrapped = codeWrap(statements);
      try {
        const fn = await safeEvalFunction(wrapped, { console, page: this.page, action: null, project: { credentials: { username: this.config.username, password: this.config.password } }, helpers: {} });
        await fn({ page: this.page, action: null, project: { credentials: { username: this.config.username, password: this.config.password } }, helpers: {} });
      } catch {}

      // Heuristic nudges without static selectors to handle staged flows
      const emailFilled = this.config.username ? await fillEmailIfPresent(this.config.username) : false;
      if (emailFilled) await clickPrimaryContinueOrSubmit();
      const passFilled = this.config.password ? await fillPasswordIfPresent(this.config.password) : false;
      if (passFilled) await clickPrimaryContinueOrSubmit();
      const ssoBtn = await queryOne(() => this.page.getByRole('button', { name: /redirect/i }));
      if (ssoBtn) { try { await ssoBtn.click({ timeout: 5000 }); } catch {} }

      // Wait up to 60s for progress; else press Enter and wait briefly again
      const progressed = await waitForMeaningfulChange(beforeUrl, beforeHash, 60_000);
      if (!progressed) { try { await this.page.keyboard.press('Enter'); } catch {} await waitForMeaningfulChange(beforeUrl, beforeHash, 10_000); }

      try { await this.page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}

      const currentUrl = this.page.url();
      const moved = currentUrl && currentUrl !== this.config.login_url;
      if (moved) {
        console.log('✅ Login appears successful');
        // Record an action document representing login success for visibility
        try {
          const loginPageId = (await Pages.findOne({ project_id: this.projectId, url: identityUrl(this.config.login_url) }))?._id || null;
          await Actions.insertOne({
            project_id: this.projectId,
            page_id: loginPageId,
            to_page_id: null,
            kind: 'login',
            text: 'AI-driven login flow executed',
            selector: '',
            created_at: new Date(),
            updated_at: new Date()
          });
        } catch {}
        if (this.config.save_cookies) {
          const cookies = await this.context.cookies();
          await Configurations.updateOne({ _id: this.config._id }, { $set: { cookies, updated_at: new Date() } });
          console.log(`💾 Saved ${cookies.length} cookies`);
        }
        clearTimeout(loginTimeout);
        return true;
      }
      console.log('⚠️ Login may have failed - still on login page');
      clearTimeout(loginTimeout);
      return false;
    } catch (error) {
      console.error('❌ Login failed:', error.message);
      clearTimeout(loginTimeout);
      return false;
    }
  }

  async loadCookies() {
    if (!this.config.save_cookies || !this.config.cookies || this.config.cookies.length === 0) {
      return;
    }
    
    console.log(`🍪 Loading ${this.config.cookies.length} saved cookies`);
    await this.context.addCookies(this.config.cookies);
  }

  async crawlDomain() {
    console.log(`🌐 Starting domain crawl: ${this.config.domain}`);
    
    // Add seed URL to queue
    this.urlQueue.push({ url: this.config.domain, depth: 0 });
    
    let analyzedCount = 0;
    
    while (this.urlQueue.length > 0 && analyzedCount < maxPages) {
      const { url, depth } = this.urlQueue.shift();
      
      if (depth > maxDepth) {
        console.log(`⏭️ Skipping ${url} - max depth exceeded`);
        continue;
      }
      
      if (this.visitedUrls.has(url)) {
        continue;
      }
      
      console.log(`📄 Analyzing page ${analyzedCount + 1}/${maxPages}: ${url} (depth: ${depth})`);
      
      try {
        const success = await this.analyzePage(url, depth);
        if (success) {
          analyzedCount++;
          this.visitedUrls.add(url);
          
          console.log(`✅ Successfully analyzed page ${analyzedCount}: ${url}`);
          
          // Update run progress
          await Runs.updateOne(
            { _id: this.runId },
            { 
              $set: { 
                analyzed_pages: analyzedCount,
                last_analyzed_url: url,
                last_analyzed_at: new Date()
              }
            }
          );
        } else {
          console.log(`⚠️ Failed to analyze page: ${url}`);
        }
      } catch (error) {
        console.error(`❌ Error analyzing ${url}:`, error.message);
        
        // Update run with error
        await Runs.updateOne(
          { _id: this.runId },
          { $inc: { errors: 1 } }
        );
      }
    }
    
    console.log(`✅ Domain crawl complete. Analyzed ${analyzedCount} pages.`);
    
    // Update run status
    await Runs.updateOne(
      { _id: this.runId },
      { 
        $set: { 
          status: 'completed',
          end_time: new Date(),
          discovered_urls: this.discoveredUrls.size,
          analyzed_pages: analyzedCount
        }
      }
    );
  }

  async finalizeRunArtifacts() {
    try {
      if (this.page && this.page.video) {
        const video = this.page.video();
        if (video) {
          const tempPath = path.join('/tmp', `run_${this.runId.toString()}_${Date.now()}.webm`);
          try { await video.saveAs(tempPath); } catch {}
          try {
            const buf = await fs.readFile(tempPath);
            const fileId = await uploadToGridFS({
              filename: path.basename(tempPath),
              buffer: buf,
              contentType: 'video/webm',
              metadata: { project_id: this.projectId, kind: 'run-video', run_id: this.runId.toString() }
            });
            this.videoFileId = fileId;
            await Runs.updateOne({ _id: this.runId }, { $set: { video_file_id: fileId } });
          } catch {}
        }
      }
    } catch {}
  }

  async analyzePage(url, depth) {
    const pageTimeout = setTimeout(() => {
      console.log(`⏰ Page analysis timeout for: ${url}`);
      throw new Error('Page analysis timeout');
    }, 2 * 60 * 1000); // 2 minutes per page timeout
    
    try {
      console.log(`📄 Loading page: ${url}`);
      await this.page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 });
      
      console.log(`📸 Taking screenshot for: ${url}`);
      const html = await this.page.content();
      const screenshotBuf = await this.page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
      const screenshotDataUrl = screenshotBuf ? await toDataUrlPng(screenshotBuf) : null;
      
      console.log(`🤖 Analyzing page with AI: ${url}`);
      // Analyze page with AI with timeout
      const aiTimeout = setTimeout(() => {
        throw new Error('AI analysis timeout');
      }, 180000); // 3 minutes AI analysis timeout
      
      const raw = await analyzePage({
        url: url,
        html,
        screenshotDataUrl,
        response_format: { type: 'json_object' },
      });
      
      clearTimeout(aiTimeout);
      
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      if (!data) {
        console.error('❌ Model did not return valid JSON for:', url);
        return false;
      }
      
      let parsed;
      try { parsed = ModelResponse.parse(data); } catch (e) {
        console.warn('⚠️ Model response failed schema validation for:', url);
        parsed = { 
          page_summary: deriveShortSummary(html), 
          interactive_elements: Array.isArray(data?.interactive_elements) ? data.interactive_elements : [] 
        };
      }
      
      // Save page to database
      const pageId = await this.savePage(url, html, screenshotBuf, parsed.page_summary);
      
      // Extract and save actions
      await this.saveActions(pageId, parsed.interactive_elements);
      
      // Discover new URLs for crawling
      if (depth < maxDepth) {
        await this.discoverUrls(url, depth + 1);
      }
      
      clearTimeout(pageTimeout);
      return true;
      
    } catch (error) {
      console.error(`❌ Error analyzing page ${url}:`, error.message);
      clearTimeout(pageTimeout);
      return false;
    }
  }

  async savePage(url, html, screenshotBuf, summary) {
    const urlId = identityUrl(url);
    
    // Check if page already exists
    let existing = await Pages.findOne({ project_id: this.projectId, url: urlId });
    
    // Upload HTML
    const htmlId = await uploadToGridFS({
      filename: `page_${sha1(Buffer.from(urlId + html)).slice(0,8)}.html`,
      buffer: Buffer.from(html, 'utf8'),
      contentType: 'text/html; charset=utf-8',
      metadata: { project_id: this.projectId, url: urlId, kind: 'page-html' },
    });
    
    // Upload screenshot
    let screenshotId = null;
    if (screenshotBuf) {
      screenshotId = await uploadToGridFS({
        filename: `page_${Date.now()}.png`,
        buffer: screenshotBuf,
        contentType: 'image/png',
        metadata: { project_id: this.projectId, url: urlId, kind: 'page-screenshot' },
      });
    }
    
    if (existing) {
      // Update existing page
      await Pages.updateOne(
        { _id: existing._id },
        {
          $set: {
            page_summary: summary,
            html_file_id: htmlId,
            screenshot_file_id: screenshotId,
            last_analyzed_at: new Date(),
            last_analyzed_run_id: this.runId
          }
        }
      );
      return existing._id;
    } else {
      // Create new page
      const result = await Pages.insertOne({
        project_id: this.projectId,
        url: urlId,
        title: this.extractTitle(html),
        content: html.substring(0, 1000), // Store first 1000 chars
        created_at: new Date(),
        page_summary: summary,
        html_file_id: htmlId,
        screenshot_file_id: screenshotId,
        last_analyzed_at: new Date(),
        last_analyzed_run_id: this.runId,
        // New analysis settings
        analysis_approach: 'ai', // 'ai', 'manual', 'custom_script'
        custom_playwright_script: null,
        is_login_page: this.isLoginPage(urlId, html),
        analysis_priority: this.isLoginPage(urlId, html) ? 1 : 0 // Login pages get priority 1
      });
      return result.insertedId;
    }
  }

  async saveActions(pageId, interactiveElements) {
    const actionDocs = [];
    
    for (const el of interactiveElements || []) {
      if (el.element_type === 'link' && el.href) {
        // Add link to discovered URLs
        this.discoveredUrls.add(el.href);
        
        actionDocs.push({
          project_id: this.projectId,
          page_id: pageId,
          kind: 'link',
          text: el.text || 'Link',
          href: el.href,
          selectors: el.selectors || null,
          created_at: new Date()
        });
      } else if (el.element_type === 'form') {
        actionDocs.push({
          project_id: this.projectId,
          page_id: pageId,
          kind: 'form',
          text: el.text || 'Form',
          action: el.action || null,
          method: el.method || null,
          selectors: el.selectors || null,
          inputs: el.inputs || [],
          submit_button: el.submit_button || null,
          created_at: new Date()
        });
      } else if (el.element_type === 'button') {
        actionDocs.push({
          project_id: this.projectId,
          page_id: pageId,
          kind: 'click',
          text: el.text || 'Button',
          selectors: el.selectors || null,
          created_at: new Date()
        });
      }
    }
    
    if (actionDocs.length > 0) {
      await Actions.insertMany(actionDocs);
      console.log(`💾 Saved ${actionDocs.length} actions for page`);
    }
  }

  async discoverUrls(baseUrl, depth) {
    try {
      console.log(`🔍 Discovering URLs on page: ${baseUrl} (depth: ${depth})`);
      
      // Get all links on the page
      const links = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
      });
      
      console.log(`🔗 Found ${links.length} links on page`);
      
      const baseDomain = new URL(this.config.domain).hostname;
      let newUrls = 0;
      
      for (const link of links) {
        try {
          const linkUrl = new URL(link);
          
          // Only follow links from the same domain
          if (linkUrl.hostname === baseDomain) {
            const normalizedUrl = identityUrl(link);
            
            if (!this.visitedUrls.has(normalizedUrl) && !this.urlQueue.some(q => q.url === normalizedUrl)) {
              this.urlQueue.push({ url: normalizedUrl, depth: depth + 1 });
              this.discoveredUrls.add(normalizedUrl);
              newUrls++;
            }
          }
        } catch (error) {
          // Skip invalid URLs
          continue;
        }
      }
      
      console.log(`✅ Discovered ${newUrls} new URLs (queue size: ${this.urlQueue.length})`);
      
    } catch (error) {
      console.error('❌ Error discovering URLs:', error.message);
    }
  }

  extractTitle(html) {
    try {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
    } catch {
      return '';
    }
  }

  isLoginPage(url, html) {
    // Check URL patterns
    const loginUrlPatterns = [
      /\/login/i,
      /\/signin/i,
      /\/sign-in/i,
      /\/auth/i,
      /\/authenticate/i,
      /\/log-in/i
    ];
    
    if (loginUrlPatterns.some(pattern => pattern.test(url))) {
      return true;
    }
    
    // Check HTML content for login indicators
    const loginIndicators = [
      /<input[^>]*type=["']password["'][^>]*>/i,
      /<form[^>]*>.*?<input[^>]*type=["']password["'][^>]*>.*?<\/form>/is,
      /login/i,
      /sign\s*in/i,
      /username/i,
      /email.*password/i,
      /password.*email/i
    ];
    
    const loginCount = loginIndicators.filter(indicator => indicator.test(html)).length;
    
    // If we find 3 or more login indicators, it's likely a login page
    return loginCount >= 3;
  }

  async cleanup() {
    console.log('🧹 Cleaning up crawler...');
    
    // Clear global timeout
    if (this.globalTimeout) {
      clearTimeout(this.globalTimeout);
    }
    
    // Attempt to persist video before closing context/browser
    await this.finalizeRunArtifacts().catch(()=>{});
    
    // Close browser resources with timeout
    const cleanupTimeout = setTimeout(() => {
      console.log('⚠️ Cleanup timeout, forcing exit');
      process.exit(1);
    }, 30000); // 30 second cleanup timeout
    
    try {
      if (this.page) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
      await client.close();
      clearTimeout(cleanupTimeout);
      console.log('✅ Cleanup completed');
    } catch (error) {
      console.error('❌ Error during cleanup:', error.message);
      clearTimeout(cleanupTimeout);
    }
  }
}

// ---------------- Main Execution ----------------
(async () => {
  try {
    console.log(`📌 Using project _id: ${PROJECT_ID}`);
    console.log(`📌 Using configuration _id: ${CONFIG_ID}`);
    
    // Get configuration
    const config = await Configurations.findOne({ _id: CONFIG_ID });
    if (!config) {
      console.error('❌ Configuration not found');
      process.exit(1);
    }
    
    console.log(`📋 Configuration: ${config.name}`);
    console.log(`🌐 Domain: ${config.domain}`);
    console.log(`🔐 Login enabled: ${config.login_enabled}`);
    console.log(`🍪 Save cookies: ${config.save_cookies}`);
    
    // Create crawler
    const crawler = new DomainCrawler(config, PROJECT_ID);
    
    // Initialize
    await crawler.initialize();
    
    // Load saved cookies if available
    await crawler.loadCookies();
    
    // Login if required
    if (config.login_enabled) {
      const loginSuccess = await crawler.login();
      if (!loginSuccess) {
        console.log('⚠️ Login failed, but continuing with crawl...');
      }
    }
    
    // Start crawling
    await crawler.crawlDomain();
    
    // Cleanup
    await crawler.cleanup();
    
    console.log('✅ Domain crawling complete!');
    
  } catch (error) {
    console.error('❌ Crawling failed:', error);
    process.exit(1);
  }
})();
