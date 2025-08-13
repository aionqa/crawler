# Single Page Analyzer (No Crawling)

This toolkit analyzes **one page** using **Playwright** (just to load the page, capture raw HTML and a full-height screenshot). 
It then sends both to **gpt-5-mini** to enumerate **forms** (including *div* + button pseudo-forms), **links**, and other **interactive elements**.
Outputs are stored in **MongoDB** collections you requested.

## Collections
- **projects**: project metadata, target link, optional credentials, cookies/timestamps.
- **pages**: per-page info (html path, screenshot path, SPA guess).
- **actions**: one per interactive element with selectors and metadata.
- **prompts**: prompts/responses used for AI analysis.
- **code_tests**: Playwright code per action produced by AI.
- **results**: result of executing a test for an action.
- **runs**: history of analyzer or action runs (params, outcome, logs).

## Requirements
- Node 18+
- MongoDB running locally (no password): `mongodb://127.0.0.1:27017`

## Setup
```bash
npm install
npm run install:pw
cp .env.example .env
# Edit .env with your OPENAI_API_KEY, TARGET_URL, PROJECT_NAME, etc.
```

## Analyze a Single Page
```bash
npm run analyze
```

Artifacts (raw HTML + screenshot) will be saved under `./artifacts/<PROJECT_NAME>/...`.
MongoDB documents will be inserted per the schema above.

## Execute a Single Action Script
1. Find an action `_id` in the `actions` collection produced by the analyzer.
2. Run:
```bash
npm run run:action -- <actionId>
```
This will execute the **AI-generated** Playwright snippet for that action (no crawling) and write a `results` document plus a `runs` entry.

> ⚠️ **Security**: The runner executes model-produced JS using `new Function`. Review/approve code before running in production. Consider sandboxing.

## Notes
- Model name used is **gpt-5-mini**.
- The analyzer **does not crawl**; it only processes the single URL in your `.env` (`TARGET_URL`).
- Cookies captured at analysis time are stored at the `projects` level.
- `results` are created by the **runner**, not the analyzer; analyzer creates everything else.