/**
 * Human-like Playwright action primitives.
 *
 * Adds visible, recordable mouse movement, click hesitation, per-key typing
 * delays, and post-action pauses to standard Playwright interactions. These
 * primitives are intended to be used everywhere the runner clicks, types,
 * presses, or hovers — both from generated leg scripts (via `createPageWrapper`)
 * and from deterministic code paths (login form fill, static-node steps,
 * captcha solving).
 *
 * All functions accept either a Playwright Locator or a `(page, selector)`
 * pair and degrade gracefully if `boundingBox()` is unavailable.
 *
 * The behaviour is on by default and can be disabled with
 * `HUMAN_LIKE_ACTIONS=false`.
 */

const HUMANIZE_ENABLED = String(process.env.HUMAN_LIKE_ACTIONS ?? 'true').toLowerCase() !== 'false';

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function jitter(value, amount = 4) {
  return value + (Math.random() * amount * 2 - amount);
}

async function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve `target` (Locator or { page, selector }) to a usable Locator.
 */
function resolveLocator(target, opts = {}) {
  if (!target) throw new Error('humanActions: target required');
  // Locator already.
  if (typeof target.click === 'function' && typeof target.boundingBox === 'function') {
    return target;
  }
  // { page, selector }
  if (target.page && typeof target.page.locator === 'function' && opts.selector) {
    return target.page.locator(opts.selector);
  }
  // bare page + selector via opts
  if (typeof target.locator === 'function' && opts.selector) {
    return target.locator(opts.selector);
  }
  // ElementHandle (deprecated style); some calls still use it.
  if (typeof target.click === 'function') {
    return target;
  }
  throw new Error('humanActions: could not resolve target to a locator');
}

async function getPageFromLocator(locator) {
  try { if (typeof locator.page === 'function') return locator.page(); } catch (_) { /* ignore */ }
  return null;
}

async function moveMouseToBox(page, box, { steps } = {}) {
  if (!page || !box || typeof page.mouse?.move !== 'function') return;
  const x = jitter(box.x + box.width / 2, Math.min(8, box.width / 4));
  const y = jitter(box.y + box.height / 2, Math.min(6, box.height / 4));
  const stepCount = steps || rand(8, 18);
  try { await page.mouse.move(x, y, { steps: stepCount }); } catch (_) { /* ignore */ }
}

async function preActionPause() {
  if (!HUMANIZE_ENABLED) return;
  await sleep(rand(120, 320));
}

async function postActionPause() {
  if (!HUMANIZE_ENABLED) return;
  await sleep(rand(80, 220));
}

/**
 * Human-like click: optional pre-hover with mouse movement, small hesitation,
 * actual click with random hold-time, and a short post-click pause so the
 * recording shows the result.
 */
export async function humanClick(target, options = {}) {
  const opts = { ...options };
  const locator = resolveLocator(target, opts);
  const page = await getPageFromLocator(locator);

  if (HUMANIZE_ENABLED && page) {
    try {
      const box = await locator.boundingBox({ timeout: opts.timeout || 5000 });
      if (box) {
        await moveMouseToBox(page, box, { steps: rand(10, 22) });
        await sleep(rand(80, 200));
      }
    } catch (_) { /* falls through to direct click */ }
  }

  await preActionPause();
  // Use the locator's own click so Playwright re-resolves at click time.
  await locator.click({
    delay: HUMANIZE_ENABLED ? rand(40, 110) : 0,
    timeout: opts.timeout,
    force: opts.force,
    button: opts.button,
    clickCount: opts.clickCount,
    modifiers: opts.modifiers,
    position: opts.position,
    trial: opts.trial
  });
  await postActionPause();
}

/**
 * Human-like fill: clears the field, optionally moves the mouse to the field,
 * then types one character at a time with per-key delay so typing is visible
 * in the recording. Falls back to a plain `fill` for very long values to keep
 * runs from blowing past the leg timeout.
 */
export async function humanType(target, value, options = {}) {
  const opts = { ...options };
  const locator = resolveLocator(target, opts);
  const page = await getPageFromLocator(locator);
  const text = value == null ? '' : String(value);

  if (HUMANIZE_ENABLED && page) {
    try {
      const box = await locator.boundingBox({ timeout: opts.timeout || 5000 });
      if (box) {
        await moveMouseToBox(page, box, { steps: rand(8, 16) });
        await sleep(rand(80, 200));
      }
    } catch (_) { /* ignore */ }
  }

  // Focus + clear via the locator (fast, deterministic).
  try { await locator.fill('', { timeout: opts.timeout, force: opts.force }); } catch (_) { /* ignore */ }
  await preActionPause();

  if (!HUMANIZE_ENABLED || text.length === 0 || text.length > 200) {
    await locator.fill(text, { timeout: opts.timeout, force: opts.force });
    await postActionPause();
    return;
  }

  // pressSequentially is the modern equivalent of `type` on a Locator.
  const perKeyDelay = () => {
    const base = rand(60, 160);
    // Occasional longer pause to mimic thinking.
    if (Math.random() < 0.07) return base + rand(200, 600);
    return base;
  };

  for (const ch of text) {
    try {
      if (typeof locator.pressSequentially === 'function') {
        await locator.pressSequentially(ch, { delay: perKeyDelay(), timeout: opts.timeout });
      } else if (typeof locator.type === 'function') {
        await locator.type(ch, { delay: perKeyDelay(), timeout: opts.timeout });
      } else if (page) {
        await page.keyboard.type(ch, { delay: perKeyDelay() });
      }
    } catch (err) {
      // If per-key typing fails mid-stream, finish synchronously.
      try { await locator.fill(text); } catch (_) { /* ignore */ }
      break;
    }
  }
  await postActionPause();
}

/**
 * Human-like hover: moves the mouse along a small arc to the target.
 */
export async function humanHover(target, options = {}) {
  const opts = { ...options };
  const locator = resolveLocator(target, opts);
  const page = await getPageFromLocator(locator);
  if (HUMANIZE_ENABLED && page) {
    try {
      const box = await locator.boundingBox({ timeout: opts.timeout || 5000 });
      if (box) {
        await moveMouseToBox(page, box, { steps: rand(10, 18) });
        await sleep(rand(80, 200));
      }
    } catch (_) { /* ignore */ }
  }
  await locator.hover({
    timeout: opts.timeout,
    force: opts.force,
    modifiers: opts.modifiers,
    position: opts.position,
    trial: opts.trial
  });
  await postActionPause();
}

/**
 * Human-like keyboard press (page-level). Adds a short pause around the
 * keystroke and, when humanizing, lengthens the natural press duration via
 * the `delay` option.
 */
export async function humanPress(page, key, options = {}) {
  if (!page || !page.keyboard) return;
  await preActionPause();
  await page.keyboard.press(key, {
    delay: HUMANIZE_ENABLED ? rand(40, 120) : 0,
    ...(options || {})
  });
  await postActionPause();
}

/**
 * Human-like select: small mouse movement to the dropdown, then `selectOption`.
 * Note: Playwright's `selectOption` can't natively be "humanized" because the
 * OS picker is synthetic; this still gives the recording a visible mouse
 * cue and a small pause.
 */
export async function humanSelect(target, value, options = {}) {
  const opts = { ...options };
  const locator = resolveLocator(target, opts);
  const page = await getPageFromLocator(locator);
  if (HUMANIZE_ENABLED && page) {
    try {
      const box = await locator.boundingBox({ timeout: opts.timeout || 5000 });
      if (box) {
        await moveMouseToBox(page, box, { steps: rand(8, 16) });
        await sleep(rand(80, 200));
      }
    } catch (_) { /* ignore */ }
  }
  await preActionPause();
  await locator.selectOption(value, {
    timeout: opts.timeout,
    force: opts.force
  });
  await postActionPause();
}

/**
 * Sleep for a small random "scrolling / reading" interval. Use sparingly —
 * pre/post pauses are already added around every action.
 */
export async function humanIdle(min = 200, max = 600) {
  if (!HUMANIZE_ENABLED) return;
  await sleep(rand(min, max));
}

export function isHumanizeEnabled() {
  return HUMANIZE_ENABLED;
}
