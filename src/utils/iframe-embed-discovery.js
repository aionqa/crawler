/**
 * Discover navigation targets from <iframe>/<frame>/<object>/<embed> attributes.
 * Parent documents can read embed URLs even when the embedded document is cross-origin,
 * so this complements per-frame link harvesting (which needs automation access to the child document).
 */

function normalizeHost(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^www\./, '');
}

function hostMatchesDomain(host, domain, allowSubs) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  if (!h || !d) return false;
  if (h === d) return true;
  if (allowSubs && h.endsWith(`.${d}`)) return true;
  return false;
}

function isProjectHost(host, baseHost, allowSubdomains, projectDomains) {
  if (host === baseHost) return true;
  if (projectDomains.length === 0) {
    return allowSubdomains && host.endsWith(`.${baseHost}`);
  }
  return projectDomains.some((domain) => hostMatchesDomain(host, domain, allowSubdomains));
}

function isApiHost(host, projectDomains, apiDomains, allowSubdomains) {
  if (projectDomains.length > 0 && projectDomains.some((d) => hostMatchesDomain(host, d, true))) {
    return false;
  }
  return apiDomains.some((apiDomain) => hostMatchesDomain(host, apiDomain, true));
}

/**
 * Classify a resolved http(s) URL like _browserCollectLinksFromAnchorElements.
 * @returns {{ fullUrl: string, urlWithoutHash: string, hashFragment: string | null, isInternal: boolean, isApi: boolean }}
 */
export function classifyResolvedUrlForCrawl(fullUrl, baseUrl, allowSubdomains, projectDomains, apiDomains) {
  let isInternal = false;
  let isApi = false;
  let href = fullUrl;
  try {
    const linkUrl = new URL(href);
    const baseUrlObj = new URL(baseUrl);
    const linkHost = normalizeHost(linkUrl.hostname);
    const baseHost = normalizeHost(baseUrlObj.hostname);
    isApi = isApiHost(linkHost, projectDomains, apiDomains, allowSubdomains);
    isInternal = !isApi && isProjectHost(linkHost, baseHost, allowSubdomains, projectDomains);
    href = linkUrl.href;
  } catch {
    // keep defaults
  }
  const urlWithoutHash = href.split('#')[0];
  const hashFragment = href.includes('#') ? href.split('#').slice(1).join('#') : null;
  return {
    fullUrl: href,
    urlWithoutHash,
    hashFragment,
    isInternal,
    isApi,
  };
}

function shouldSkipRawUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  if (lower.startsWith('javascript:')) return true;
  if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return true;
  if (lower.startsWith('blob:') || lower.startsWith('data:')) return true;
  if (lower === 'about:blank') return true;
  return false;
}

/**
 * Collect iframe/frame/object/embed navigation URLs from every frame Playwright can script.
 * @param {import('playwright').Page} page
 * @param {object} ctx
 * @param {string} ctx.baseUrl
 * @param {boolean} ctx.allowSubdomains
 * @param {{ projectDomains?: string[], apiDomains?: string[] }} ctx.domainScope
 * @param {(level: string, msg: string) => void} [ctx.log]
 * @returns {Promise<Array<object>>} Link-shaped rows compatible with extractAllLinks merge
 */
export async function collectIframeEmbedLinkRows(page, ctx) {
  const baseUrl = ctx.baseUrl || '';
  const allowSubdomains = Boolean(ctx.allowSubdomains);
  const projectDomains = Array.isArray(ctx.domainScope?.projectDomains) ? ctx.domainScope.projectDomains : [];
  const apiDomains = Array.isArray(ctx.domainScope?.apiDomains) ? ctx.domainScope.apiDomains : [];
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};

  const rows = [];
  const frames = typeof page.frames === 'function' ? page.frames() : [];

  for (const frame of frames) {
    if (!frame) continue;
    let frameBase = baseUrl;
    try {
      const fu = frame.url();
      if (fu && typeof fu === 'string' && !fu.startsWith('about:') && !fu.startsWith('chrome-error://')) {
        frameBase = fu.split('#')[0];
      }
    } catch {
      frameBase = baseUrl;
    }

    let rawList = [];
    try {
      rawList = await frame.evaluate(() => {
        const out = [];
        const sel =
          'iframe[src], iframe[data-src], frame[src], frame[data-src], object[data], object[data-src], embed[src]';
        for (const el of document.querySelectorAll(sel)) {
          const raw =
            el.getAttribute('src') ||
            el.getAttribute('data-src') ||
            el.getAttribute('data') ||
            '';
          const tag = el.tagName.toLowerCase();
          out.push({
            raw: raw.trim(),
            title: el.getAttribute('title') || el.getAttribute('aria-label') || '',
            name: el.getAttribute('name') || '',
            tag,
          });
        }
        return out;
      });
    } catch (e) {
      log('info', `🔗 Iframe embed scan skipped a frame (${String(e?.message || e).slice(0, 140)})`);
      continue;
    }

    for (const item of rawList || []) {
      if (!item || shouldSkipRawUrl(item.raw)) continue;
      let fullUrl = item.raw;
      try {
        fullUrl = new URL(item.raw, frameBase).href;
      } catch {
        continue;
      }
      if (shouldSkipRawUrl(fullUrl)) continue;
      const cls = classifyResolvedUrlForCrawl(fullUrl, frameBase, allowSubdomains, projectDomains, apiDomains);
      rows.push({
        text: (item.title || item.name || `embed:${item.tag}`).substring(0, 200),
        href: cls.fullUrl,
        urlWithoutHash: cls.urlWithoutHash,
        hashFragment: cls.hashFragment,
        title: item.title || '',
        isInternal: cls.isInternal,
        isApi: cls.isApi,
        target: '',
        rel: 'iframe-embed',
        discovered_via: 'iframe_embed_src',
        embed_tag: item.tag || 'iframe',
        parent_frame_url: frameBase,
      });
    }
  }

  return rows;
}
