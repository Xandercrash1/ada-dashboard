const sanitizeHtml = require('sanitize-html');

// --- Document widget (<ada-doc-body>) rich text ---
// Documents are Quill HTML. Cleaned on save and on read: exactly what Quill
// produces (its ql-* classes, list types, text/highlight colours), nothing else.
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
function cleanDocHtml(html) {
  return sanitizeHtml(String(html || '').slice(0, 2 * 1024 * 1024), {
    allowedTags: ['p', 'div', 'br', 'span', 'strong', 'em', 'u', 's', 'sub', 'sup', 'a', 'img', 'h1', 'h2', 'h3', 'h4',
      'ol', 'ul', 'li', 'blockquote', 'pre', 'code', 'hr'],
    allowedAttributes: { '*': ['class', 'style'], a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], li: ['data-list'], pre: ['data-language', 'spellcheck'] },
    allowedClasses: { '*': ['ql-*'] },
    allowedStyles: { '*': { color: [COLOR], 'background-color': [COLOR] } },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: { a: (tagName, attribs) => { if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer'; else delete attribs.target; return { tagName, attribs }; } },
  });
}
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // ids become file names: no paths

module.exports = { cleanDocHtml, DOC_ID_RE };
