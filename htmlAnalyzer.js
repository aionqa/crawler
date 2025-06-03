import { JSDOM, VirtualConsole } from 'jsdom';

export async function analyzeHtmlContent(html, baseUrl = "") {
    const virtualConsole = new VirtualConsole();
    virtualConsole.sendTo(console).on("jsdomError", () => {}); // Suppress jsdom CSS parse errors

    const dom = new JSDOM(html, {
        pretendToBeVisual: true,
        resources: "usable",
        runScripts: "outside-only",
        includeNodeLocations: false,
        virtualConsole
    });

    const { document } = dom.window;

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
        text: el.innerText || el.value || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        outerHTML: el.outerHTML
    });

    const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => new URL(a.href, baseUrl).href)
        .filter((href, idx, arr) => arr.indexOf(href) === idx);

    const forms = Array.from(document.querySelectorAll("form")).map(form => ({
        type: "form",
        id: form.id || "",
        name: form.name || "",
        outerHTML: form.outerHTML,
        inputs: Array.from(form.querySelectorAll("input, textarea, select")).map(extractField),
        buttons: Array.from(form.querySelectorAll("button, input[type='submit'], input[type='button']")).map(extractButton)
    }));

    const pseudoForms = Array.from(document.querySelectorAll("div, section"))
        .filter(container => {
            const hasFields = container.querySelectorAll("input, textarea, select").length > 0;
            const hasButton = container.querySelectorAll("button, input[type='submit'], input[type='button']").length > 0;
            return hasFields && hasButton;
        }).map(container => ({
            type: "pseudo-form",
            id: container.id || "",
            name: container.getAttribute("name") || "",
            outerHTML: container.outerHTML,
            inputs: Array.from(container.querySelectorAll("input, textarea, select")).map(extractField),
            buttons: Array.from(container.querySelectorAll("button, input[type='submit'], input[type='button']")).map(extractButton)
        }));

    const interactives = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        .filter(el => !el.closest('form'))
        .map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            name: el.name || null,
            type: el.type || 'button',
            text: el.innerText || el.value || null,
        }));

    const h1 = document.querySelector('h1')?.textContent || '';
    const h2 = document.querySelector('h2')?.textContent || '';
    const ps = Array.from(document.querySelectorAll('p')).map(p => p.textContent).join(' ');
    const text = [h1, h2, ps].join(' ').replace(/\s+/g, ' ').slice(0, 500);

    return {
        links,
        allForms: [...forms, ...pseudoForms],
        interactives,
        textSummary: text
    };
}
