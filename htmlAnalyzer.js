import { JSDOM, VirtualConsole } from 'jsdom';

function isProbablyVisible(el) {
    if (!el || typeof el.closest !== 'function') return false;

    // Walk up the DOM tree to ensure all ancestors are visible
    let current = el;
    while (current && current !== current.ownerDocument.body) {
        const style = current.getAttribute("style") || "";
        const hidden = current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true";
        const displayNone = style.includes("display: none");
        const visibilityHidden = style.includes("visibility: hidden");

        if (hidden || displayNone || visibilityHidden) return false;
        current = current.parentElement;
    }
    return true;
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
    const forms = Array.from(document.querySelectorAll(selectors))
        .map(container => {
            const inputs = Array.from(container.querySelectorAll("input, textarea, select"))
                .filter(isProbablyVisible)
                .map(extractField);

            const buttons = Array.from(container.querySelectorAll("button, input[type='submit'], input[type='button']"))
                .filter(isProbablyVisible)
                .map(extractButton);

            const topY = container.getBoundingClientRect?.()?.top || 0;

            return {
                container,
                inputs,
                buttons,
                score: inputs.length + buttons.length,
                positionTop: topY
            };
        })
        .filter(f => (f.inputs.length + f.buttons.length) > 0);

    // Sort by number of fields/buttons DESC, then vertical position ASC
    forms.sort((a, b) =>
        b.score - a.score || a.positionTop - b.positionTop
    );

    return forms.length ? [forms[0]] : [];
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
