# CRUD Operations for AI Crawler System

This document describes the comprehensive CRUD (Create, Read, Update, Delete) operations implemented for the AI Crawler system.

## Overview

The system now includes full CRUD functionality for four main entities:
- **Projects** - Container for organizing crawling sessions
- **Pages** - Individual web pages that have been analyzed
- **Prompts** - AI prompts used for analysis and actions
- **Actions** - Interactive elements and user actions on pages

## Backend API Endpoints

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/projects` | List all projects |
| `POST` | `/projects` | Create a new project |
| `GET` | `/projects/:id` | Get a specific project |
| `PUT` | `/projects/:id` | Update a project |
| `DELETE` | `/projects/:id` | Delete a project and all related data |

**Project Schema:**
```json
{
  "_id": "ObjectId",
  "name": "string (required)",
  "description": "string (optional)",
  "created_at": "date",
  "updated_at": "date"
}
```

### Pages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/pages` | List pages (filter by project_id) |
| `POST` | `/pages` | Create a new page |
| `GET` | `/pages/:id` | Get a specific page |
| `PUT` | `/pages/:id` | Update a page |
| `DELETE` | `/pages/:id` | Delete a page and related actions |

**Page Schema:**
```json
{
  "_id": "ObjectId",
  "project_id": "ObjectId (required)",
  "title": "string (required)",
  "url": "string (required)",
  "content": "string (optional)",
  "created_at": "date",
  "updated_at": "date"
}
```

### Prompts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/prompts` | List prompts (filter by project_id, type) |
| `POST` | `/prompts` | Create a new prompt |
| `GET` | `/prompts/:id` | Get a specific prompt |
| `PUT` | `/prompts/:id` | Update a prompt |
| `DELETE` | `/prompts/:id` | Delete a prompt |

**Prompt Schema:**
```json
{
  "_id": "ObjectId",
  "project_id": "ObjectId (required)",
  "name": "string (required)",
  "content": "string (required)",
  "type": "string (analysis|action|custom) (required)",
  "created_at": "date",
  "updated_at": "date"
}
```

### Actions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/actions` | List actions (filter by project_id, page_id) |
| `POST` | `/actions` | Create a new action |
| `GET` | `/actions/:id` | Get a specific action |
| `PUT` | `/actions/:id` | Update an action |
| `DELETE` | `/actions/:id` | Delete an action |

**Action Schema:**
```json
{
  "_id": "ObjectId",
  "project_id": "ObjectId (required)",
  "page_id": "ObjectId (required)",
  "to_page_id": "ObjectId (optional)",
  "kind": "string (click|type|scroll|hover|navigate) (required)",
  "text": "string (required)",
  "selector": "string (optional)",
  "created_at": "date",
  "updated_at": "date"
}
```

## Frontend Components

### CRUDDashboard.vue
Main dashboard component that provides tabbed navigation between all CRUD managers.

**Features:**
- Tab navigation between Projects, Pages, Prompts, and Actions
- Responsive design with consistent styling
- Integration with all individual manager components

### ProjectManager.vue
Complete project management with full CRUD operations.

**Features:**
- List all projects with creation dates
- Create new projects with name and description
- Edit existing project details
- Delete projects (with cascade deletion of related data)
- Modal-based forms for create/edit operations

### PageManager.vue
Page management with project-scoped operations.

**Features:**
- Filter pages by selected project
- Create pages with title, URL, and content
- Edit page details
- Delete pages (with cascade deletion of related actions)
- URL validation and content preview

### PromptManager.vue
Prompt management with type filtering and categorization.

**Features:**
- Filter prompts by type (analysis, action, custom)
- Create prompts with name, content, and type
- Edit prompt details
- Color-coded badges for different prompt types
- Large text area for prompt content

### ActionManager.vue
Action management with page relationships and filtering.

**Features:**
- Filter actions by source page
- Create actions with type, text, and optional target page
- Edit action details
- Support for various action types (click, type, scroll, hover, navigate)
- CSS selector support for precise element targeting

## Usage Examples

### Creating a New Project
```javascript
// Backend API call
const response = await axios.post('/projects', {
  name: 'E-commerce Analysis',
  description: 'Analyzing user interactions on e-commerce site'
})

// Frontend component usage
<ProjectManager 
  :projects="projects" 
  @refresh="loadData"
/>
```

### Adding Pages to a Project
```javascript
// Backend API call
const response = await axios.post('/pages', {
  project_id: '64e9f3bd2ba5d9d82f4a1d10',
  title: 'Home Page',
  url: 'https://example.com/',
  content: 'Page content...'
})

// Frontend component usage
<PageManager 
  :pages="pages" 
  :selected-project-id="projectId"
  @refresh="loadData"
/>
```

### Creating Analysis Prompts
```javascript
// Backend API call
const response = await axios.post('/prompts', {
  project_id: '64e9f3bd2ba5d9d82f4a1d10',
  name: 'Element Analysis',
  content: 'Analyze the following interactive elements...',
  type: 'analysis'
})

// Frontend component usage
<PromptManager 
  :prompts="prompts" 
  :selected-project-id="projectId"
  @refresh="loadData"
/>
```

### Recording User Actions
```javascript
// Backend API call
const response = await axios.post('/actions', {
  project_id: '64e9f3bd2ba5d9d82f4a1d10',
  page_id: '64e9f3bd2ba5d9d82f4a1d11',
  kind: 'click',
  text: 'Click on "Add to Cart" button',
  selector: 'button.add-to-cart'
})

// Frontend component usage
<ActionManager 
  :actions="actions" 
  :pages="pages"
  :selected-project-id="projectId"
  @refresh="loadData"
/>
```

## Data Relationships

### Cascade Deletions
- **Project deletion** → Deletes all related pages, prompts, and actions
- **Page deletion** → Deletes all related actions (both source and target)

### Foreign Key Relationships
- Pages belong to Projects (`project_id`)
- Prompts belong to Projects (`project_id`)
- Actions belong to Projects (`project_id`) and Pages (`page_id`)
- Actions can optionally target other Pages (`to_page_id`)

## Error Handling

All endpoints include comprehensive error handling:
- **400 Bad Request** - Invalid input data
- **404 Not Found** - Resource doesn't exist
- **500 Internal Server Error** - Server-side errors

Error responses include descriptive messages:
```json
{
  "error": "Name is required"
}
```

## Validation Rules

### Projects
- `name` is required
- `description` is optional

### Pages
- `project_id`, `title`, and `url` are required
- `url` should be a valid URL format
- `content` is optional

### Prompts
- `project_id`, `name`, `content`, and `type` are required
- `type` must be one of: `analysis`, `action`, `custom`

### Actions
- `project_id`, `page_id`, `kind`, and `text` are required
- `kind` must be one of: `click`, `type`, `scroll`, `hover`, `navigate`
- `to_page_id` and `selector` are optional

## Getting Started

1. **Start the backend server:**
   ```bash
   npm run dev:back
   ```

2. **Start the frontend:**
   ```bash
   npm run dev:ui
   ```

3. **Access the CRUD dashboard:**
   - Navigate to the frontend application
   - Scroll down to see the "Data Management" section
   - Use the tabs to switch between different entity managers

4. **API Documentation:**
   - Visit `http://localhost:4000/api-docs` for interactive Swagger documentation
   - All endpoints are documented with examples and schemas

## Future Enhancements

- **Bulk Operations** - Import/export functionality for projects
- **Advanced Filtering** - Date ranges, status filters, search functionality
- **Audit Trail** - Track changes to entities over time
- **Permissions** - Role-based access control for different operations
- **Real-time Updates** - WebSocket integration for live data updates




