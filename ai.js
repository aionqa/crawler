import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { chromium } from "playwright";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

/**
 * @param {Object} info - Page info from gatherPageInfo
 * @param {string} folder - Output folder for this interaction
 * @returns {Promise<{ summary: string, resultHtml: string, aiCode: string, outcome: string, error?: string }>}
 */
export async function aiInteract(info, folder) {
    const aiVars = loadAIVars();
    fs.mkdirSync(folder, { recursive: true });

    // Prepare prompt for the AI model
    const prompt = `
You are an intelligent automation agent using Playwright.

Your task is to analyze a webpage and return only executable JavaScript code for Playwright that performs actions like filling in forms, clicking buttons, and waiting for results.

⚠️ You must:
- Do not use require(), import statements, or external modules.
- DO NOT include require(), browser launch, or context creation code.
- strictly do not use networkidle to define if interaction completed
- Assume you have access to 'page' and 'vars'.
- Use selectors to interact with form elements and buttons.
- Use provided variable keys if appropriate for field inputs.
- You must use the values in the 'vars' object to fill in any relevant form fields.
- After submitting the form, you must wait and observe what happens — the outcome is unknown.
- You must detect or infer the result by analyzing page behavior, DOM changes, or network responses.
- You must **collect the result** after submission (e.g. visible message, status text, navigation result) and store or log it clearly.
- Handle multiple possible outcomes (e.g. success, error, redirect).
- Do not use eval, unnecessary browser logs, or hardcoded content.
- Output only valid, executable JavaScript code — no markdown, no explanations.
- do not set up any checks after submit, just let them finish whatever they do and stop on their finish, probably by dom loaded event
- do not wait for neither successes not failures - assume all done when update or redirection is completed
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

    // Load screenshot as base64 for OpenAI vision
    let screenshotContent = "";
    if (info.screenshotPath && fs.existsSync(info.screenshotPath)) {
        const imgBuffer = fs.readFileSync(info.screenshotPath);
        const extension = path.extname(info.screenshotPath).replace('.', '') || 'png';
        screenshotContent = `data:image/${extension};base64,${imgBuffer.toString("base64")}`;
    }

    // Compose OpenAI messages (Vision)
    const messages = [
        {
            role: "user",
            content: [
                { type: "text", text: prompt },
                ...(screenshotContent
                    ? [{ type: "image_url", image_url: { url: screenshotContent } }]
                    : [])
            ],
        },
    ];

    // Call OpenAI
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

        // Extract summary line
        const summaryMatch = message.match(/\/\/ SUMMARY:(.*)$/im);
        if (summaryMatch) aiSummary = summaryMatch[1].trim();

        // Remove summary line from code output
        code = message.replace(/```(js|javascript)?/gi, "")
            .replace(/^javascript\s*/i, "")
            .replace(/\/\/ SUMMARY:.*$/im, "")
            .trim();

        // Save AI code to file
        fs.writeFileSync(path.join(folder, "ai_code.js"), code, "utf8");
        fs.writeFileSync(path.join(folder, "ai_prompt.txt"), prompt, "utf8");
        console.log(`📥 AI code received and saved for: ${info.url}`);

    } catch (err) {
        error = "OpenAI API error: " + err.message;
        fs.writeFileSync(path.join(folder, "ai_error.txt"), error, "utf8");
        console.log(`❌ OpenAI API error for ${info.url}: ${err.message}`);
        return { summary: "", resultHtml: "", aiCode: "", outcome: "", error };
    }

    // Run the AI-generated JS code in Playwright
    let resultHtml = "";
    let outcome = "";
    try {
        console.log(`🕹️ Running AI-generated code in browser for: ${info.url}`);
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            recordVideo: { dir: folder, size: { width: 1280, height: 720 } }
        });
        const page = await context.newPage();
        await page.goto(info.url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1000); // let async UI settle
        await page.waitForLoadState('domcontentloaded');
        await page.waitForFunction(() => document.readyState === 'complete');

        await new Promise(res => setTimeout(res, 1000));

        // Inject vars and run code
        await page.exposeFunction("getVars", () => aiVars);

        // Make vars available in this scope
        const vars = aiVars;

        // Run the AI code in Node's scope with 'page' and 'vars'
        try {
            // Hook navigation promise first
            const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);

            // Execute AI-generated interaction code
            await eval(`(async () => { ${code} })()`);

            // Wait for potential navigation to complete
            await navigationPromise;
        } catch (e) {
            error = "Execution error: " + e.message;
            fs.writeFileSync(path.join(folder, "ai_run_error.txt"), error, "utf8");
            console.log(`❌ AI code execution error for ${info.url}: ${e.message}`);
            throw e;
        }

        // Get the HTML after AI interaction
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1000);
        await page.waitForFunction(() => document.readyState === 'complete');

        resultHtml = await page.content();

        fs.writeFileSync(path.join(folder, "result.html"), resultHtml, "utf8");
        console.log(`📄 Saved result.html after AI interaction for: ${info.url}`);

        // Take another screenshot after interaction
        await page.screenshot({ path: path.join(folder, "after.png"), type: "png", fullPage: true });
        console.log(`📸 Saved after-interaction screenshot for: ${info.url}`);

        // Save cookies
        const cookies = await context.cookies();
        fs.writeFileSync(path.join(folder, "after_cookies.json"), JSON.stringify(cookies, null, 2));
        console.log(`🍪 Saved after-interaction cookies for: ${info.url}`);

        await page.close();

        // Save video
        const video = await page.video();
        if (video) {
            await video.saveAs(path.join(folder, "ai_video.webm"));
            console.log(`🎥 Saved interaction video for: ${info.url}`);
        }

        await context.close();
        await browser.close();

        outcome = aiSummary || "Interaction complete.";
        fs.writeFileSync(path.join(folder, "summary.txt"), outcome, "utf8");
        console.log(`📝 Saved summary for: ${info.url}`);
    } catch (err) {
        error = "Execution error: " + err.message;
        fs.writeFileSync(path.join(folder, "ai_run_error.txt"), error, "utf8");
        console.log(`❌ AI code execution error for ${info.url}: ${err.message}`);
    }

    // Save summary and return outcome
    return {
        summary: aiSummary,
        resultHtml,
        aiCode: code,
        outcome,
        error
    };
}
