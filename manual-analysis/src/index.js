import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { chromium } from 'playwright';
import { MongoClient } from 'mongodb';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3200;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017';
const DB_NAME = process.env.DB_NAME || 'aionqa';

// MongoDB connection
const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Pages = db.collection('pages');
const ManualAnalysisResults = db.collection('manual_analysis_results');

class ManualAnalyzer {
  constructor() {
    this.browser = null;
  }

  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  async analyzePage(pageId, customScript) {
    try {
      await this.initialize();
      
      // Get page data from database
      const page = await Pages.findOne({ _id: pageId });
      if (!page) {
        throw new Error('Page not found');
      }

      const context = await this.browser.newContext();
      const pageInstance = await context.newPage();

      // Set up the analysis environment
      const analysisContext = {
        page: pageInstance,
        url: page.url,
        title: page.title,
        content: page.content,
        pageData: page
      };

      // Execute the custom script
      let result;
      try {
        // Create a safe execution environment
        const scriptFunction = new Function('context', `
          const { page, url, title, content, pageData } = context;
          ${customScript}
        `);
        
        result = await scriptFunction(analysisContext);
      } catch (scriptError) {
        result = {
          success: false,
          error: scriptError.message,
          type: 'script_execution_error'
        };
      }

      // Save the analysis result
      const analysisResult = {
        page_id: pageId,
        script: customScript,
        result: result,
        executed_at: new Date(),
        success: result && !result.error
      };

      await ManualAnalysisResults.insertOne(analysisResult);

      // Update the page with analysis result
      await Pages.updateOne(
        { _id: pageId },
        { 
          $set: { 
            last_manual_analysis: analysisResult,
            last_analyzed_at: new Date()
          }
        }
      );

      await context.close();
      return analysisResult;

    } catch (error) {
      console.error('Manual analysis error:', error);
      throw error;
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

const analyzer = new ManualAnalyzer();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'manual-analysis' });
});

// Analyze page with custom script
app.post('/analyze/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const { script } = req.body;

    if (!script) {
      return res.status(400).json({ error: 'Custom script is required' });
    }

    const result = await analyzer.analyzePage(pageId, script);
    res.json(result);

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get analysis results for a page
app.get('/results/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const results = await ManualAnalysisResults
      .find({ page_id: pageId })
      .sort({ executed_at: -1 })
      .toArray();
    
    res.json(results);
  } catch (error) {
    console.error('Get results error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all analysis results
app.get('/results', async (req, res) => {
  try {
    const { project_id, limit = 100 } = req.query;
    const query = {};
    
    if (project_id) {
      // Get page IDs for the project first
      const pages = await Pages.find({ project_id }, { projection: { _id: 1 } }).toArray();
      const pageIds = pages.map(p => p._id);
      query.page_id = { $in: pageIds };
    }

    const results = await ManualAnalysisResults
      .find(query)
      .sort({ executed_at: -1 })
      .limit(parseInt(limit))
      .toArray();
    
    res.json(results);
  } catch (error) {
    console.error('Get all results error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test script endpoint
app.post('/test-script', async (req, res) => {
  try {
    const { script, testUrl = 'https://example.com' } = req.body;

    if (!script) {
      return res.status(400).json({ error: 'Script is required' });
    }

    await analyzer.initialize();
    const context = await analyzer.browser.newContext();
    const page = await context.newPage();

    // Execute the test script
    const testContext = {
      page,
      url: testUrl,
      title: 'Test Page',
      content: 'Test content',
      pageData: { url: testUrl }
    };

    let result;
    try {
      const scriptFunction = new Function('context', `
        const { page, url, title, content, pageData } = context;
        ${script}
      `);
      
      result = await scriptFunction(testContext);
    } catch (scriptError) {
      result = {
        success: false,
        error: scriptError.message,
        type: 'script_execution_error'
      };
    }

    await context.close();
    res.json({ result, testUrl });

  } catch (error) {
    console.error('Test script error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down manual analyzer...');
  await analyzer.cleanup();
  await client.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down manual analyzer...');
  await analyzer.cleanup();
  await client.close();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[manual-analysis] Server running on port ${PORT}`);
  console.log(`[manual-analysis] Health check: http://localhost:${PORT}/health`);
});
