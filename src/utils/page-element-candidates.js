/**
 * DOM surface inventory for grounding / workflows.
 * Does not classify elements as clickable — only visibility, selectors, tags, attrs, hints.
 * Call sites (prompts / separate AI passes) decide what is actionable.
 */

/**
 * Serialized into the page for evaluation. Lists visible elements in document order up to cap;
 * skips non-rendered tags only (no clickable/probe heuristics).
 */
export function collectPageElementCandidatesInBrowser(perFrameCap) {
  const cap = Math.min(Math.max(Number(perFrameCap) || 320, 40), 2000);

  const trim = (value, max = 280) =>
    String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

  const cssEscape = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(raw);
    }
    return raw.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  };

  const isVisible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
      return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const buildSelector = (el) => {
    if (!el || !(el instanceof Element)) return '';
    if (el.id) return `#${cssEscape(el.id)}`;
    const classes = String(el.className || '')
      .split(/\s+/)
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((c) => cssEscape(c));
    const tag = el.tagName.toLowerCase();
    if (classes.length > 0) return `${tag}.${classes.join('.')}`;
    const role = trim(el.getAttribute('role'), 40);
    if (role) return `${tag}[role="${cssEscape(role)}"]`;
    const name = trim(el.getAttribute('name'), 80);
    if (name) return `${tag}[name="${cssEscape(name)}"]`;
    return tag;
  };

  const SKIP_TAGS = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'meta',
    'link',
    'base',
    'head',
    'title',
    'br',
    'hr',
    'col',
    'colgroup',
    'iframe',
    'frame',
    'frameset',
  ]);

  const collectRoots = () => {
    const roots = [document];
    const visited = new Set([document]);
    const queue = [document];
    while (queue.length > 0 && roots.length < 40) {
      const root = queue.shift();
      if (!root || typeof root.querySelectorAll !== 'function') continue;
      const hosts = root.querySelectorAll('*');
      for (const host of hosts) {
        if (!host || !host.shadowRoot || visited.has(host.shadowRoot)) continue;
        visited.add(host.shadowRoot);
        roots.push(host.shadowRoot);
        queue.push(host.shadowRoot);
        if (roots.length >= 40) break;
      }
    }
    return roots;
  };

  const normalizeRouteCandidate = (raw) => {
    let candidate = String(raw || '').trim();
    if (!candidate) return '';
    if (
      (candidate.startsWith('"') && candidate.endsWith('"')) ||
      (candidate.startsWith('\'') && candidate.endsWith('\'')) ||
      (candidate.startsWith('`') && candidate.endsWith('`'))
    ) {
      candidate = candidate.slice(1, -1).trim();
    }
    return candidate &&
      candidate !== '#' &&
      !/^(javascript:|mailto:|tel:|blob:|data:)/i.test(candidate)
      ? candidate
      : '';
  };

  const rows = [];

  const roots = collectRoots();
  for (const root of roots) {
    if (!root || typeof root.querySelectorAll !== 'function') continue;
    const nodes = root.querySelectorAll('*');
    for (let i = 0; i < nodes.length && rows.length < cap; i++) {
      const el = nodes[i];
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (!isVisible(el)) continue;

      const role = trim(el.getAttribute('role'), 80) || null;
      let href = '';
      try {
        if (typeof el.href === 'string' && el.href) {
          href = trim(new URL(el.href, window.location.href).href, 400);
        } else {
          const h = normalizeRouteCandidate(el.getAttribute('href'));
          if (h) href = trim(new URL(h, window.location.href).href, 400);
        }
      } catch {
        href = '';
      }

      const tab = el.getAttribute('tabindex');
      const tabindex = tab !== null && tab !== '' ? String(tab).trim() : null;
      const text = trim(
        el.textContent ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('alt') ||
          (el instanceof HTMLInputElement ? el.value : '') ||
          '',
        260,
      );

      rows.push({
        type: tag,
        text,
        role,
        tabindex,
        placeholder: trim(el.getAttribute('placeholder'), 160) || null,
        name: trim(el.getAttribute('name'), 120) || null,
        id: trim(el.getAttribute('id'), 120) || null,
        href: href || null,
        has_onclick: el.hasAttribute('onclick'),
        selector: buildSelector(el),
        click_targets_undetermined: true,
      });
    }
    if (rows.length >= cap) break;
  }

  return {
    candidates: rows,
    open_shadow_roots_scanned: Math.max(0, roots.length - 1),
  };
}

/** Collect merged candidate rows from every frame — no click labeling. */
export async function gatherDomCandidatesAcrossFrames(
  page,
  { perFrameCap = 400, maxTotal = 1200 } = {},
) {
  const frames =
    typeof page.frames === 'function'
      ? page.frames()
      : [typeof page.mainFrame === 'function' ? page.mainFrame() : null].filter(Boolean);
  const out = [];
  const seen = new Set();
  const normalizeKeyPart = (value) => String(value || '').trim().toLowerCase();

  for (const frame of frames) {
    if (!frame || out.length >= maxTotal) break;
    let frameUrl = '';
    try {
      frameUrl = frame.url() || '';
    } catch {
      frameUrl = '';
    }

    if (typeof frame.waitForLoadState === 'function') {
      await frame.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }

    const inFrame = page.mainFrame ? frame !== page.mainFrame() : false;
    const framePayload = await frame.evaluate(collectPageElementCandidatesInBrowser, perFrameCap);
    const batch = Array.isArray(framePayload?.candidates) ? framePayload.candidates : [];

    for (const row of batch) {
      if (out.length >= maxTotal) break;
      const key = [
        inFrame,
        normalizeKeyPart(frameUrl),
        normalizeKeyPart(row.selector),
        normalizeKeyPart(row.text),
      ].join('|');
      if (!row.selector || seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...row,
        in_frame: inFrame,
        frame_url: frameUrl || null,
      });
    }
  }

  return out;
}
