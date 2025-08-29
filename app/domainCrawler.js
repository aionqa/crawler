import { analyzePage } from '../ai/pageAnalysis.js';
import 'dotenv/config';
import { chromium } from 'playwright';
import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
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
  }

  async initialize() {
    console.log('🚀 Initializing domain crawler...');
    console.log(`📋 Project ID: ${PROJECT_ID}`);
    console.log(`📋 Config ID: ${CONFIG_ID}`);
    console.log(`📋 Max Pages: ${maxPages}`);
    console.log(`📋 Max Depth: ${maxDepth}`);
    console.log(`📋 Job ID: ${JOB_ID}`);
    
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
    
    // Launch browser with configuration
    this.browser = await chromium.launch({ 
      headless: this.config.headless 
    });
    
    this.context = await this.browser.newContext({
      userAgent: this.config.user_agent || undefined,
      viewport: { width: 1280, height: 720 }
    });
    
    this.page = await this.context.newPage();
    
    // Set timeout
    this.page.setDefaultTimeout(this.config.timeout || 30000);
    
    console.log(`✅ Browser initialized with config: ${this.config.name}`);
  }

  async login() {
    if (!this.config.login_enabled || !this.config.login_url) {
      console.log('ℹ️ No login required');
      return true;
    }

    console.log('🔐 Attempting login...');
    
    try {
      await this.page.goto(this.config.login_url, { waitUntil: 'load' });
      
      // Wait for login form to be ready
      await this.page.waitForLoadState('networkidle', { timeout: 10000 });
      
      // Fill username
      if (this.config.username) {
        const usernameSelectors = [
          'input[name="username"]',
          'input[name="email"]',
          'input[type="email"]',
          'input[id*="username"]',
          'input[id*="email"]',
          'input[placeholder*="username" i]',
          'input[placeholder*="email" i]'
        ];
        
        for (const selector of usernameSelectors) {
          try {
            await this.page.fill(selector, this.config.username);
            break;
          } catch {}
        }
      }
      
      // Fill password
      if (this.config.password) {
        const passwordSelectors = [
          'input[name="password"]',
          'input[type="password"]',
          'input[id*="password"]',
          'input[placeholder*="password" i]'
        ];
        
        for (const selector of passwordSelectors) {
          try {
            await this.page.fill(selector, this.config.password);
            break;
          } catch {}
        }
      }
      
      // Submit form
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Login")',
        'button:has-text("Sign In")',
        'button:has-text("Log In")'
      ];
      
      for (const selector of submitSelectors) {
        try {
          await this.page.click(selector);
          break;
        } catch {}
      }
      
      // Wait for login to complete
      await this.page.waitForLoadState('networkidle', { timeout: 15000 });
      
      // Check if login was successful (basic check)
      const currentUrl = this.page.url();
      if (currentUrl !== this.config.login_url) {
        console.log('✅ Login appears successful');
        
        // Save cookies if enabled
        if (this.config.save_cookies) {
          const cookies = await this.context.cookies();
          await Configurations.updateOne(
            { _id: this.config._id },
            { $set: { cookies: cookies, updated_at: new Date() } }
          );
          console.log(`💾 Saved ${cookies.length} cookies`);
        }
        
        return true;
      } else {
        console.log('⚠️ Login may have failed - still on login page');
        return false;
      }
      
    } catch (error) {
      console.error('❌ Login failed:', error.message);
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

  async analyzePage(url, depth) {
    try {
      await this.page.goto(url, { waitUntil: 'load' });
      await this.page.waitForLoadState('networkidle', { timeout: 10000 });
      
      const html = await this.page.content();
      const screenshotBuf = await this.page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
      const screenshotDataUrl = screenshotBuf ? await toDataUrlPng(screenshotBuf) : null;
      
      // Analyze page with AI
      const raw = await analyzePage({
        url: url,
        html,
        screenshotDataUrl,
        response_format: { type: 'json_object' },
      });
      
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
      
      return true;
      
    } catch (error) {
      console.error(`❌ Error analyzing page ${url}:`, error.message);
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
        last_analyzed_run_id: this.runId
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

  async cleanup() {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    await client.close();
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
