import express from 'express';
import cors from 'cors';
import workflowRoutes from './workflow-routes.js';

/**
 * Workflow API Server
 * Serves workflow step endpoints for backend-controlled execution
 */
class WorkflowServer {
  constructor(port = 4001) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Enable CORS for backend communication
    this.app.use(cors({
      origin: process.env.BACKEND_URL || 'http://back:4000',
      credentials: true
    }));

    // Parse JSON bodies
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`[WORKFLOW-SERVER] ${req.method} ${req.path} - ${new Date().toISOString()}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        service: 'unified-crawler-workflow-api',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    // Workflow API routes
    this.app.use('/api/workflow', workflowRoutes);

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Route ${req.method} ${req.originalUrl} not found`
        }
      });
    });

    // Error handler
    this.app.use((error, req, res, next) => {
      console.error(`[WORKFLOW-SERVER] Error:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: error.message,
          details: { stack: error.stack }
        }
      });
    });
  }

  start() {
    this.server = this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`🚀 [WORKFLOW-SERVER] Workflow API server started on port ${this.port}`);
      console.log(`🔗 [WORKFLOW-SERVER] Health check: http://localhost:${this.port}/health`);
      console.log(`📋 [WORKFLOW-SERVER] Workflow API: http://localhost:${this.port}/api/workflow`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log(`⏹️ [WORKFLOW-SERVER] Received SIGTERM, shutting down gracefully...`);
      this.server.close(() => {
        console.log(`✅ [WORKFLOW-SERVER] Server closed`);
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      console.log(`⏹️ [WORKFLOW-SERVER] Received SIGINT, shutting down gracefully...`);
      this.server.close(() => {
        console.log(`✅ [WORKFLOW-SERVER] Server closed`);
        process.exit(0);
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

export default WorkflowServer;
