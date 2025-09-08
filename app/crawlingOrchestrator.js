import { spawn } from 'child_process';
import { MongoClient, ObjectId } from 'mongodb';
import EventEmitter from 'events';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------- Environment ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const {
  MONGODB_URI = 'mongodb://127.0.0.1:27017',
  DB_NAME = 'spa',
} = process.env;

// ---------------- Database ----------------
const client = new MongoClient(MONGODB_URI);
const db = client.db(DB_NAME);
const Runs = db.collection('runs');
const CrawlLogs = db.collection('crawl_logs');

// ---------------- Crawling Orchestrator ----------------
class CrawlingOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.activeJobs = new Map(); // jobId -> { process, config, startTime }
    this.jobLogs = new Map(); // jobId -> logBuffer
  }

  async initialize() {
    try {
      await client.connect();
      console.log('✅ Crawling Orchestrator initialized');
      
      // Clean up any stuck jobs on startup
      await this.cleanupStuckJobs();
      
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize orchestrator:', error);
      return false;
    }
  }

  async cleanupStuckJobs() {
    try {
      // Mark any running jobs as failed
      await Runs.updateMany(
        { status: 'running' },
        { 
          $set: { 
            status: 'failed',
            end_time: new Date(),
            error: 'Job was stuck and marked as failed on startup'
          }
        }
      );
      console.log('🧹 Cleaned up stuck jobs');
    } catch (error) {
      console.error('❌ Error cleaning up stuck jobs:', error);
    }
  }

  async startCrawl(configId, projectId, options = {}) {
    const jobId = new ObjectId().toString();
    
    try {
      // Get configuration
      const config = await db.collection('configurations').findOne({ 
        _id: new ObjectId(configId) 
      });
      
      if (!config) {
        throw new Error('Configuration not found');
      }

      // Create run record
      const runDoc = {
        _id: new ObjectId(jobId),
        project_id: new ObjectId(projectId),
        configuration_id: new ObjectId(configId),
        status: 'starting',
        start_time: new Date(),
        seed_url: config.domain,
        max_pages: options.max_pages || 100,
        max_depth: options.max_depth || 3,
        discovered_urls: 0,
        analyzed_pages: 0,
        errors: 0,
        logs: []
      };
      
      await Runs.insertOne(runDoc);
      
      // Initialize log buffer for this job
      this.jobLogs.set(jobId, []);
      
      // Start the crawler process
      const crawlerProcess = spawn('node', [
        'app/domainCrawler.js',
        '--project', projectId,
        '--config', configId,
        '--max-pages', (options.max_pages || 100).toString(),
        '--max-depth', (options.max_depth || 3).toString(),
        '--job-id', jobId
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        cwd: path.join(__dirname, '../') // Set working directory to project root
      });
      
      // Store job info
      this.activeJobs.set(jobId, {
        process: crawlerProcess,
        config: config,
        startTime: new Date(),
        projectId: projectId
      });
      
      // Handle process output
      this.handleProcessOutput(jobId, crawlerProcess);
      
      // Handle process exit
      crawlerProcess.on('exit', (code, signal) => {
        this.handleProcessExit(jobId, code, signal);
      });
      
      // Update run status to running
      await Runs.updateOne(
        { _id: new ObjectId(jobId) },
        { $set: { status: 'running' } }
      );
      
      // Emit job started event
      this.emit('jobStarted', { jobId, config });
      
      console.log(`🚀 Started crawl job ${jobId} for ${config.domain}`);
      
      return {
        success: true,
        jobId: jobId,
        message: 'Crawl job started successfully'
      };
      
    } catch (error) {
      console.error(`❌ Failed to start crawl job ${jobId}:`, error);
      
      // Update run status to failed
      if (jobId) {
        await Runs.updateOne(
          { _id: new ObjectId(jobId) },
          { 
            $set: { 
              status: 'failed',
              end_time: new Date(),
              error: error.message
            }
          }
        );
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  async startActionRun(actionId, projectId, pageId, options = {}) {
    const jobId = new ObjectId().toString();
    const headless = options.headless !== undefined ? !!options.headless : false; // default non-headless per request
    try {
      // Basic validation
      if (!ObjectId.isValid(actionId) || !ObjectId.isValid(projectId) || !ObjectId.isValid(pageId)) {
        throw new Error('Invalid ids');
      }

      const runDoc = {
        _id: new ObjectId(jobId),
        kind: 'partial',
        status: 'starting',
        start_time: new Date(),
        project_id: new ObjectId(projectId),
        action_id: new ObjectId(actionId),
        page_id: new ObjectId(pageId),
        headless,
        logs: []
      };
      await Runs.insertOne(runDoc);
      this.jobLogs.set(jobId, []);

      const script = path.join(__dirname, 'actionAiExecutor.js');
      const proc = spawn(process.execPath, [
        script,
        '--project_id', String(projectId),
        '--page_id', String(pageId),
        '--action_id', String(actionId),
        '--headless', String(headless)
      ], { stdio: ['pipe','pipe','pipe'], detached: false, cwd: path.join(__dirname, '../') });

      this.activeJobs.set(jobId, { process: proc, config: { type: 'partial' }, startTime: new Date(), projectId });
      this.handleProcessOutput(jobId, proc);
      proc.on('exit', (code, signal) => this.handleProcessExit(jobId, code, signal));

      await Runs.updateOne({ _id: new ObjectId(jobId) }, { $set: { status: 'running' } });
      this.emit('jobStarted', { jobId, config: { type: 'partial' } });

      return { success: true, jobId, job_id: jobId, message: 'Partial action run started' };
    } catch (error) {
      console.error(`❌ Failed to start action run ${jobId}:`, error);
      if (jobId) {
        await Runs.updateOne(
          { _id: new ObjectId(jobId) },
          { $set: { status: 'failed', end_time: new Date(), error: String(error?.message || error) } }
        );
      }
      return { success: false, error: String(error?.message || error) };
    }
  }

  async stopCrawl(jobId) {
    const job = this.activeJobs.get(jobId);
    
    if (!job) {
      return {
        success: false,
        error: 'Job not found or already stopped'
      };
    }
    
    try {
      console.log(`🛑 Stopping crawl job ${jobId}...`);
      
      // Kill the process
      job.process.kill('SIGTERM');
      
      // Wait a bit for graceful shutdown
      setTimeout(() => {
        if (job.process.killed === false) {
          job.process.kill('SIGKILL');
        }
      }, 5000);
      
      // Update run status
      await Runs.updateOne(
        { _id: new ObjectId(jobId) },
        { 
          $set: { 
            status: 'cancelled',
            end_time: new Date(),
            cancelled_at: new Date()
          }
        }
      );
      
      // Clean up job
      this.activeJobs.delete(jobId);
      this.jobLogs.delete(jobId);
      
      // Emit job stopped event
      this.emit('jobStopped', { jobId });
      
      console.log(`✅ Crawl job ${jobId} stopped successfully`);
      
      return {
        success: true,
        message: 'Crawl job stopped successfully'
      };
      
    } catch (error) {
      console.error(`❌ Error stopping crawl job ${jobId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  handleProcessOutput(jobId, process) {
    const logBuffer = this.jobLogs.get(jobId) || [];
    
    // Handle stdout
    process.stdout.on('data', async (data) => {
      const logEntry = {
        timestamp: new Date(),
        level: 'info',
        message: data.toString().trim(),
        jobId: jobId
      };
      
      logBuffer.push(logEntry);
      
      // Keep only last 1000 log entries
      if (logBuffer.length > 1000) {
        logBuffer.splice(0, logBuffer.length - 1000);
      }
      
      // Save to database
      await this.saveLogEntry(logEntry);
      
      // Emit log event
      this.emit('log', logEntry);
    });
    
    // Handle stderr
    process.stderr.on('data', async (data) => {
      const logEntry = {
        timestamp: new Date(),
        level: 'error',
        message: data.toString().trim(),
        jobId: jobId
      };
      
      logBuffer.push(logEntry);
      
      // Keep only last 1000 log entries
      if (logBuffer.length > 1000) {
        logBuffer.splice(0, logBuffer.length - 1000);
      }
      
      // Save to database
      await this.saveLogEntry(logEntry);
      
      // Emit log event
      this.emit('log', logEntry);
    });
  }

  async handleProcessExit(jobId, code, signal) {
    console.log(`📋 Crawl job ${jobId} exited with code ${code}, signal ${signal}`);
    
    const job = this.activeJobs.get(jobId);
    if (!job) return;
    
    // Determine final status
    let status = 'completed';
    let error = null;
    
    if (code !== 0) {
      status = 'failed';
      error = `Process exited with code ${code}`;
    } else if (signal) {
      status = 'cancelled';
      error = `Process killed with signal ${signal}`;
    }
    
    // Update run status
    await Runs.updateOne(
      { _id: new ObjectId(jobId) },
      { 
        $set: { 
          status: status,
          end_time: new Date(),
          exit_code: code,
          exit_signal: signal,
          error: error
        }
      }
    );
    
    // Clean up job
    this.activeJobs.delete(jobId);
    
    // Emit job completed event
    this.emit('jobCompleted', { jobId, status, code, signal });
  }

  async saveLogEntry(logEntry) {
    try {
      await CrawlLogs.insertOne(logEntry);
    } catch (error) {
      console.error('❌ Error saving log entry:', error);
    }
  }

  async getJobStatus(jobId) {
    try {
      const run = await Runs.findOne({ _id: new ObjectId(jobId) });
      if (!run) return null;
      
      const isActive = this.activeJobs.has(jobId);
      const logs = this.jobLogs.get(jobId) || [];
      
      return {
        ...run,
        isActive,
        recentLogs: logs.slice(-50), // Last 50 log entries
        logCount: logs.length
      };
    } catch (error) {
      console.error('❌ Error getting job status:', error);
      return null;
    }
  }

  async getAllJobs() {
    try {
      const runs = await Runs.find({}).sort({ start_time: -1 }).limit(100).toArray();
      
      return runs.map(run => ({
        ...run,
        isActive: this.activeJobs.has(run._id.toString())
      }));
    } catch (error) {
      console.error('❌ Error getting all jobs:', error);
      return [];
    }
  }

  async getActiveJobs() {
    const activeJobs = [];
    
    for (const [jobId, job] of this.activeJobs) {
      const status = await this.getJobStatus(jobId);
      if (status) {
        activeJobs.push(status);
      }
    }
    
    return activeJobs;
  }

  async getJobLogs(jobId, limit = 100) {
    try {
      const logs = await CrawlLogs.find({ jobId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      
      return logs.reverse(); // Return in chronological order
    } catch (error) {
      console.error('❌ Error getting job logs:', error);
      return [];
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up orchestrator...');
    
    // Stop all active jobs
    for (const [jobId] of this.activeJobs) {
      await this.stopCrawl(jobId);
    }
    
    // Close database connection
    await client.close();
    
    console.log('✅ Orchestrator cleanup complete');
  }

  getStats() {
    return {
      activeJobs: this.activeJobs.size,
      totalLogEntries: Array.from(this.jobLogs.values()).reduce((sum, logs) => sum + logs.length, 0),
      uptime: process.uptime()
    };
  }
}

// Create singleton instance
const orchestrator = new CrawlingOrchestrator();

// Handle process termination
process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down...');
  await orchestrator.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down...');
  await orchestrator.cleanup();
  process.exit(0);
});

export default orchestrator;
