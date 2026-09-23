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
