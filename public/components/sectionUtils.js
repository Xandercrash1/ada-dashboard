// Shared helpers for Page Builder v2 section components (fb-1790201502141).
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Links: http(s), site-relative, in-page anchors and mailto only — never
// javascript:, data: or anything else a pasted value could smuggle in.
export function safeHref(v) {
  const s = String(v || '').trim();
  if (/^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(s)) return s;
  return '#';
}
// Images: http(s) or site-relative only.
export function safeSrc(v) {
  const s = String(v || '').trim();
  return /^(https?:\/\/|\/(?!\/))[^'"()\s]*$/i.test(s) ? s : '';
}

// Standard section shell styled by the page tokens (fb-1790201502171).
// `tone` 'brand' fills with the brand colour instead of the surface.
export function shell(inner, tone) {
  const bg = tone === 'brand' ? 'var(--ada-brand)' : 'var(--ada-surface)';
  const fg = tone === 'brand' ? '#ffffff' : 'var(--ada-text)';
  return `<section class="w-full overflow-hidden" style="background: ${bg}; color: ${fg}; border-radius: var(--ada-radius); padding: var(--ada-space) 1.5rem; font-family: var(--ada-font-body);">${inner}</section>`;
}
export const headingStyle = (size) => `font-family: var(--ada-font-heading); font-size: clamp(1.5rem, 4.5vw, var(${size || '--ada-h2'})); line-height: 1.15; font-weight: 750;`;
export const buttonStyle = (tone) => tone === 'ghost'
  ? 'border: 1.5px solid currentColor; border-radius: calc(var(--ada-radius) * 0.6);'
  : tone === 'light'
    ? 'background: #ffffff; color: var(--ada-brand); border-radius: calc(var(--ada-radius) * 0.6);'
    : 'background: var(--ada-brand); color: #ffffff; border-radius: calc(var(--ada-radius) * 0.6);';
// Escaped text with **bold**, *italic* and [label](url) — links go through
// safeHref. Input is escaped FIRST, so no markup can come through.
export function miniMarkdown(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => `<a href="${safeHref(url.replace(/&amp;/g, '&')).replace(/"/g, '&quot;')}" style="color: var(--ada-brand); text-decoration: underline;">${label}</a>`);
}
export function lines(text, max) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, max || 24);
}
