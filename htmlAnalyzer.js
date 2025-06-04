import { JSDOM, VirtualConsole } from 'jsdom';

function isProbablyVisible(el) {
    const style = el.getAttribute("style") || "";
    const hidden = el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true";
    return !style.includes("display: none") && !style.includes("visibility: hidden") && !hidden;
}

function getUniversalFormSignature(form) {
    const inputSig = form.inputs
        .filter(f => f.type !== 'hidden')
        .map(f => `${f.type}:${f.name || f.id || ''}`)
        .sort()
        .join("|");

    const buttonSig = form.buttons
        .map(b => (b.text || b.name || b.id || '').trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join("|");

    return `${inputSig}||${buttonSig}`;
}

const extractField = el => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    name: el.name || "",
    type: el.type || el.tagName.toLowerCase(),
    placeholder: el.placeholder || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    value: el.value || "",
    outerHTML: el.outerHTML
});

const extractButton = el => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    name: el.name || "",
    type: el.type || "button",
    text: el.textContent?.trim() || el.value || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    outerHTML: el.outerHTML
});

function extractForms(document, selectors) {
    return Array.from(document.querySelectorAll(selectors))
        .filter(container => {
            const hasInputs = container.querySelectorAll("input, textarea, select").length > 0;
            const hasButtons = container.querySelectorAll("button, input[type='submit'], input[type='button']").length > 0;
            return hasInputs && hasButtons;
        })
        .map(container => ({
            container,
            inputs: Array.from(container.querySelectorAll("input, textarea, select"))
                .filter(isProbablyVisible)
                .map(extractField),
            buttons: Array.from(container.querySelectorAll("button, input[type='submit'], input[type='button']"))
                .filter(isProbablyVisible)
                .map(extractButton)
        }));
}

export async function analyzeHtmlContent(html, baseUrl = "") {
    const virtualConsole = new VirtualConsole();
    virtualConsole.sendTo(console, { omitJSDOMErrors: true });

    const dom = new JSDOM(html, {
        pretendToBeVisual: true,
        resources: "usable",
        runScripts: "outside-only",
        includeNodeLocations: false,
        virtualConsole
    });

    const { document } = dom.window;

    const allContainers = [
        ...extractForms(document, "form"),
        ...extractForms(document, "div, section, main")
    ];

    const dedupedForms = [];
    const seenSignatures = new Set();

    for (const form of allContainers) {
        const sig = getUniversalFormSignature(form);
        if (!sig || seenSignatures.has(sig)) continue;
        seenSignatures.add(sig);
        dedupedForms.push(form);
        console.log(`✔️ Keeping unique form with signature: ${sig}`);
    }

    const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => new URL(a.href, baseUrl).href)
        .filter((href, idx, arr) => arr.indexOf(href) === idx);

    const interactives = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        .filter(el => !el.closest('form'))
        .map(extractButton);

    const h1 = document.querySelector('h1')?.textContent || '';
    const h2 = document.querySelector('h2')?.textContent || '';
    const ps = Array.from(document.querySelectorAll('p')).map(p => p.textContent).join(' ');
    const text = [h1, h2, ps].join(' ').replace(/\s+/g, ' ').slice(0, 500);

    return {
        links,
        allForms: dedupedForms,
        interactives,
        textSummary: text
    };
}
