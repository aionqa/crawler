# AI Crawler System

A comprehensive web crawling and analysis system with AI-powered page analysis, backend API, and frontend interface.

## Project Structure

- `ai/` - AI analysis modules and prompts
- `app/` - Main application logic and orchestrators
- `back/` - Backend API server (from aionqa-back repo)
- `ui/` - Frontend Vue.js interface (from aionqa-ui repo)
- `runtime/` - Runtime utilities and sandbox

## Quick Start

### Option 1: Run All Services (Recommended)
```bash
# Make sure all dependencies are installed
npm run install:all

# Start all services with one command
./start-all.sh
```

### Option 2: Run Services Individually

#### 1. Start Backend API
```bash
npm run dev:back
# Backend will run on http://localhost:4000
```

#### 2. Start Frontend UI
```bash
npm run dev:ui
# Frontend will run on http://localhost:5173
```

#### 3. Run AI Analysis
```bash
npm run analyze
# This runs the main page analyzer
```

## Available Scripts

### Main Project
- `npm run install:all` - Install dependencies for all projects
- `npm run analyze` - Run the main page analyzer
- `npm run run:action` - Execute actions on analyzed pages
- `npm run install:pw` - Install Playwright browser

### Backend
- `npm run dev:back` - Start backend in development mode
- `npm run start:back` - Start backend in production mode

### Frontend
- `npm run dev:ui` - Start frontend development server
- `npm run build:ui` - Build frontend for production
- `npm run start:ui` - Preview built frontend

## Services

### Backend API (Port 4000)
- REST API endpoints
- Socket.IO for real-time updates
- MongoDB integration
- Swagger documentation at `/api-docs`

### Frontend UI (Port 5173)
- Vue.js 3 application
- Real-time updates via Socket.IO
- Interactive graph visualization with Cytoscape

### AI Analyzer
- Playwright-based web crawling
- GPT-5-mini integration for element analysis
- MongoDB storage for results

## Environment Setup

Make sure you have:
1. Node.js installed
2. MongoDB running (for backend)
3. Environment variables configured (check `.env` files in each project)

## Development

Each project can be developed independently:
- Backend: `cd back && npm run dev`
- Frontend: `cd ui && npm run dev`
- Main analyzer: `npm run analyze`

## API Documentation

Once the backend is running, visit:
- Swagger UI: http://localhost:4000/api-docs
- OpenAPI spec: http://localhost:4000/openapi.json

