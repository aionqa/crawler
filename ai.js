import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { chromium } from "playwright";
import { analyzeHtmlContent } from './htmlAnalyzer.js';
import crypto from 'crypto';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OUTPUT = process.env.OUTPUT_FOLDER || "./outcome";
const storagePath = path.join(OUTPUT, "storage.json"); // ADDED: Consistent path with main.js

function loadAIVars() {
    try {
        return JSON.parse(process.env.AI_VARS || "{}");
    } catch {
        return {};
    }
}

function shortText(txt, maxLen = 500) {
    if (!txt) return "";
    let t = txt.replace(/\s+/g, " ").trim();
    return t.length > maxLen ? t.slice(0, maxLen) + "..." : t;
}

async function waitForHtmlStability(page, maxWait = 10000, stableThreshold = 2000) {
    console.log("🔍 Waiting for HTML stability...");
    let lastHtml = "";
    try {
        lastHtml = await page.content();
    } catch {
        console.warn("⚠️ Initial page.content() failed, retrying...");
        await page.waitForTimeout(10000);
        try {
            lastHtml = await page.content();
        } catch {
            console.warn("⚠️ Still unable to get initial HTML; proceeding with empty snapshot.");
        }
    }

    let stableStart = Date.now();
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
        await page.waitForTimeout(20000);
        let currentHtml = "";

        try {
            currentHtml = await page.content();
        } catch {
            console.warn("⚠️ Skipping unstable HTML snapshot (still navigating?)");
            continue;
        }

        if (currentHtml === lastHtml) {
            if (Date.now() - stableStart >= stableThreshold) {
                console.log("✅ HTML has stabilized");
                return;
            }
        } else {
            lastHtml = currentHtml;
            stableStart = Date.now();
        }
    }

    console.warn("⏱️ Timed out waiting for HTML stability");
}

export async function aiInteract(info, folder) {
    const aiVars = loadAIVars();
    fs.mkdirSync(folder, { recursive: true });

    // Compose the AI prompt
    const prompt = `
You are an intelligent automation agent using Playwright.

Your task is to analyze a webpage and return only executable JavaScript code for Playwright that performs actions like filling in forms, clicking buttons, following links, or waiting for results.

⚠️ You must:
- Do not use require(), import statements, or external modules.
- DO NOT include require(), browser launch, or context creation code.
- strictly do not use networkidle to define if interaction completed
- Assume you have access to 'page' and 'vars'.
- Use selectors to interact with interactive elements as appropriate.
- Use provided variable keys if appropriate for field inputs.
- You must use the values in the 'vars' object to fill in any relevant form fields.
- After submitting the form or clicking, you must wait and observe what happens — the outcome is unknown.
- You must detect or infer the result by analyzing page behavior, DOM changes, or network responses.
- You must **collect the result** after submission (e.g. visible message, status text, navigation result) and store or log it clearly.
- Handle multiple possible outcomes (e.g. success, error, redirect).
- Do not use eval, unnecessary browser logs, or hardcoded content.
- Output only valid, executable JavaScript code — no markdown, no explanations.
- do not set up any checks after submit, just let them finish whatever they do and stop on their finish, probably by dom loaded event
- do not wait for neither successes nor failures - assume all done when update or redirection is completed
- do not add logic for finding an outcome

After each \`
    page.fill()\` or \`
    page.click()\`, add a small delay using:
    await new Promise(res => setTimeout(res, 500));

You receive a snapshot of a web page with the following info:
- URL: ${info.url}
- Main visible text: ${shortText(info.textSummary)}
- Form details:
${JSON.stringify(info.form, null, 2)}
Other page links:
${JSON.stringify(info.links, null, 2)}
Vars: ${Object.keys(aiVars).join(', ')}

A screenshot is attached.

Before every action (such as filling in a field, clicking a button, submitting a form, navigating, etc.), insert a line of code like:
console.log("🔸 [Describe what is happening, with an emoji]");

At the end, output a summary in this format:
// SUMMARY: <one-line plain English description of what happened>
`;

    let screenshotContent = "";
    if (info.screenshotPath && fs.existsSync(info.screenshotPath)) {
        const imgBuffer = fs.readFileSync(info.screenshotPath);
        const extension = path.extname(info.screenshotPath).replace('.', '') || 'png';
        screenshotContent = `data:image/${extension};base64,${imgBuffer.toString("base64")}`;
    }

    const messages = [{
        role: "user",
        content: [
            { type: "text", text: prompt },
            ...(screenshotContent ? [{ type: "image_url", image_url: { url: screenshotContent } }] : [])
        ],
    }];

    let code = "";
    let aiSummary = "";
    let error = "";

    try {
        console.log(`🤖 Sending prompt to OpenAI for: ${info.url}`);
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages,
            temperature: 0.2,
            max_tokens: 4096
        });

        let message = completion.choices[0].message.content.trim();
        const summaryMatch = message.match(/\/\/ SUMMARY:(.*)$/im);
        if (summaryMatch) aiSummary = summaryMatch[1].trim();

        code = message
            .replace(/```(js|javascript)?/gi, "")
            .replace(/^javascript\s*/i, "")
            .replace(/\/\/ SUMMARY:.*$/im, "")
            .trim();

        if (!code) throw new Error("AI returned empty or invalid JS code.");

        fs.writeFileSync(path.join(folder, "ai_code.js"), code, "utf8");
        fs.writeFileSync(path.join(folder, "ai_prompt.txt"), prompt, "utf8");
        console.log(`📥 AI code received and saved for: ${info.url}`);

    } catch (err) {
        error = "OpenAI API error: " + err.message;
        fs.writeFileSync(path.join(folder, "ai_error.txt"), error, "utf8");
        console.log(`❌ OpenAI API error for ${info.url}: ${err.message}`);
        return { summary: "", resultHtml: "", aiCode: "", outcome: "", error };
    }

    let resultHtml = "";
    let outcome = "";
    let browser, context, page;
    let afterActionUrl = "";

    try {
        console.log(`🕹️ Running AI-generated code in browser for: ${info.url}`);

        // ----------- LOAD STORAGE/COOKIES IF EXISTS -----------
        let contextOptions = {
            recordVideo: { dir: folder, size: { width: 1280, height: 720 } }
        };
        if (fs.existsSync(storagePath)) {
            contextOptions.storageState = storagePath;
        }

        browser = await chromium.launch({ headless: true });
        context = await browser.newContext(contextOptions);
        page = await context.newPage();

        await page.goto(info.url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(10000);
        await page.waitForLoadState('domcontentloaded');

        let hasWebSocket = false;
        page.on("websocket", () => {
            hasWebSocket = true;
            console.log("🔌 WebSocket detected");
        });

        try {
            const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);

            const fn = new Function('page', 'vars', `"use strict"; return (async () => { ${code} })()`);
            await fn(page, aiVars);

            await navigationPromise;
        } catch (e) {
            if (!e.message.includes("Execution context was destroyed")) throw e;
            console.warn("⚠️ Ignoring transient evaluation error due to navigation");
        }

        if (hasWebSocket) {
            await waitForHtmlStability(page);
        } else {
            await page.waitForTimeout(20000);
        }

        afterActionUrl = await page.evaluate(() => window.location.href);
        fs.writeFileSync(path.join(folder, "after_action_url.txt"), afterActionUrl, "utf8");
        console.log(`🌍 Actual visible URL after action: ${afterActionUrl}`);

        resultHtml = await page.content();
        fs.writeFileSync(path.join(folder, "result.html"), resultHtml, "utf8");
        console.log(`📄 Saved result.html after AI interaction for: ${info.url}`);

        await page.screenshot({ path: path.join(folder, "after.png"), type: "png", fullPage: true });
        console.log(`📸 Saved after-interaction screenshot for: ${info.url}`);

        const cookies = await context.cookies();

        fs.writeFileSync(path.join(folder, "after_cookies.json"), JSON.stringify(cookies, null, 2));
        console.log(`🍪 Saved after-interaction cookies for: ${info.url}`);

        const video = await page.video();
        if (video) {
            try {
                await Promise.race([
                    video.saveAs(path.join(folder, "ai_video.webm")),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Video save timeout")), 5000))
                ]);
                console.log(`🎥 Saved interaction video for: ${info.url}`);
            } catch (err) {
                console.warn(`⚠️ Video save failed or timed out: ${err.message}`);
            }
        }

        outcome = aiSummary || "Interaction complete.";
        fs.writeFileSync(path.join(folder, "summary.txt"), outcome, "utf8");
        console.log(`📝 Saved summary for: ${info.url}`);

        // ----------- SAVE STORAGE/COOKIES BACK -----------
        const currentState = await context.storageState();
        let previousState = { cookies: [], origins: [] };

        if (fs.existsSync(storagePath)) {
            try {
                previousState = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
            } catch (err) {
                console.warn("⚠️ Could not parse previous storage.json:", err.message);
            }
        }

// Merge cookies
        const cookieMap = new Map();
        for (const c of [...previousState.cookies, ...currentState.cookies]) {
            const key = `${c.name}|${c.domain}|${c.path}`;
            cookieMap.set(key, c);
        }
        const mergedCookies = Array.from(cookieMap.values());

// Merge origins (localStorage / sessionStorage)
        const originMap = new Map();
        for (const o of [...previousState.origins, ...currentState.origins]) {
            const originKey = o.origin;
            const existing = originMap.get(originKey) || { origin: originKey, localStorage: [] };
            const storageMap = new Map();

            for (const item of existing.localStorage) {
                storageMap.set(item.name, item);
            }

            for (const item of o.localStorage) {
                storageMap.set(item.name, item); // overwrite or add
            }

            existing.localStorage = Array.from(storageMap.values());
            originMap.set(originKey, existing);
        }
        const mergedOrigins = Array.from(originMap.values());

        const mergedState = {
            cookies: mergedCookies,
            origins: mergedOrigins
        };

        fs.writeFileSync(storagePath, JSON.stringify(mergedState, null, 2));
        console.log("💾 Upserted storage.json with merged cookies + localStorage.");


    } catch (err) {
        error = "Execution error: " + err.message;
        fs.writeFileSync(path.join(folder, "ai_run_error.txt"), error, "utf8");
        console.log(`❌ AI code execution error for ${info.url}: ${err.message}`);
    } finally {
        if (page && !await page.isClosed()) await page.close();
        if (context) await context.close();
        if (browser) await browser.close();
    }

    return {
        summary: aiSummary,
        resultHtml,
        aiCode: code,
        outcome,
        error,
        afterActionUrl
    };
}


export async function aiInteractRecursive(info, folder, depth = 0, maxDepth = 10, seenForms = new Set()) {
    if (depth > maxDepth) {
        console.log(`🛑 Max recursion depth ${maxDepth} reached.`);
        return { outcome: "Max depth reached", steps: depth };
    }

    const stepFolder = path.join(folder, `step_${depth}`);
    const result = await aiInteract(info, stepFolder);

    if (result.error) {
        console.log(`❌ Error during AI interaction at depth ${depth}: ${result.error}`);
        return { ...result, steps: depth };
    }

    const { resultHtml, summary, afterActionUrl } = result;

    if (!resultHtml) {
        console.log(`⚠️ No HTML returned after step ${depth}`);
        return { ...result, steps: depth };
    }

    // Prevent infinite loops on similar HTML
    const htmlFingerprint = crypto.createHash("md5").update(resultHtml).digest("hex");
    const stateKey = afterActionUrl + "#" + htmlFingerprint;
    if (seenForms.has(stateKey)) {
        console.log(`🛑 Detected repeating state at depth ${depth}, stopping recursion.`);
        return { ...result, outcome: "Repeated state", steps: depth };
    }
    seenForms.add(stateKey);

    console.log(`🔁 Step ${depth} completed. Summary: ${summary}`);

    const nextInfo = await analyzeHtmlContent(resultHtml, afterActionUrl);
    const nextForm = (nextInfo.allForms || [])[0];

    // Save info snapshot
    fs.writeFileSync(path.join(stepFolder, `info_step_${depth}.json`), JSON.stringify(nextInfo, null, 2));

    // Stop if no meaningful next form OR success detected
    const terminal = summary?.toLowerCase().includes("success") || summary?.toLowerCase().includes("completed");
    const nextFormValid = nextForm && nextForm.inputs?.length > 0;

    if (terminal || !nextFormValid) {
        console.log(`✅ Ending recursion at step ${depth} — ${summary || "No more forms"}`);
        return { ...result, steps: depth + 1 };
    }

    console.log(`🔄 Continuing to step ${depth + 1}...`);
    return await aiInteractRecursive({
        ...nextInfo,
        form: nextForm,
        url: afterActionUrl,
        screenshotPath: path.join(stepFolder, "after.png")
    }, folder, depth + 1, maxDepth, seenForms);
}

export async function aiDescribePage(info, folder) {
    const aiVars = loadAIVars();
    fs.mkdirSync(folder, { recursive: true });

    const prompt = `
You are a web intelligence agent.

Your job is to read and describe a web page, NOT to interact with it.

You will receive:
- A page snapshot (DOM, text, and basic structure)
- A screenshot
- Some variable context

You must:
- Summarize what the page appears to do or offer
- Identify interactive elements (buttons, forms, inputs)
- Suggest what actions a user might perform on this page
- Output a short, structured JSON with the following fields:
  {
    "summary": "<one sentence>",
    "interactions": ["<brief list of things a user might do>"],
    "suggestedActions": ["<suggested AI next steps>"]
  }

HTML context (text summary):
${shortText(info.textSummary)}

Form and element info:
${JSON.stringify(info.form || info.allForms || [], null, 2)}

Other links:
${JSON.stringify(info.links || [], null, 2)}

Vars: ${Object.keys(aiVars).join(', ')}
    `.trim();

    let screenshotContent = "";
    if (info.screenshotPath && fs.existsSync(info.screenshotPath)) {
        const imgBuffer = fs.readFileSync(info.screenshotPath);
        const extension = path.extname(info.screenshotPath).replace('.', '') || 'png';
        screenshotContent = `data:image/${extension};base64,${imgBuffer.toString("base64")}`;
    }

    const messages = [{
        role: "user",
        content: [
            { type: "text", text: prompt },
            ...(screenshotContent ? [{ type: "image_url", image_url: { url: screenshotContent } }] : [])
        ],
    }];

    try {
        console.log(`🧠 Asking OpenAI to describe: ${info.url}`);
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages,
            temperature: 0.3,
            max_tokens: 2048
        });

        const outputText = completion.choices[0].message.content.trim();
        fs.writeFileSync(path.join(folder, "ai_description.json"), outputText, "utf8");
        return outputText;
    } catch (err) {
        const error = "OpenAI API error: " + err.message;
        fs.writeFileSync(path.join(folder, "ai_error.txt"), error, "utf8");
        return null;
    }
}
