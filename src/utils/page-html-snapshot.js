/**
 * Normalize full-document HTML from Playwright for backend storage.
 * Keeps payloads under MongoDB's 16MB document budget and records truncation metadata.
 */

const DEFAULT_MAX_CHARS = 1_800_000;

/**
 * @param {string} rawHtml
 * @param {{ maxChars?: number }} [options]
 * @returns {{ content: string, page_html_meta: { captured_at: string, original_length: number, stored_length: number, truncated: boolean } }}
 */
export function snapshotPageHtml(rawHtml, options = {}) {
  const maxChars =
    typeof options.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : DEFAULT_MAX_CHARS;
  const captured_at = new Date().toISOString();
  const original_length = typeof rawHtml === 'string' ? rawHtml.length : 0;

  if (typeof rawHtml !== 'string' || !rawHtml) {
    return {
      content: '',
      page_html_meta: {
        captured_at,
        original_length,
        stored_length: 0,
        truncated: false,
      },
    };
  }

  let truncated = false;
  let content = rawHtml;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    truncated = true;
  }

  return {
    content,
    page_html_meta: {
      captured_at,
      original_length,
      stored_length: content.length,
      truncated,
    },
  };
}
