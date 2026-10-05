// Page Builder v3 (GrapesJS) — storage, cleaning and routes.
// Plan: vault Projects/AI Server/Plan — Page Builder GrapesJS Build.md, phases 1–2.
//
// A page doc may carry `builder: { draft: {html, css, updatedAt, updatedBy},
// live: {html, css, at, by} }`. Home keeps its builder content in its own
// file (data/homepage-builder.json, same shape), because the Home save path
// (sanitizeHomepage) rebuilds homepage.json from a fixed field list. Only an
// admin edits Home; everyone may view it. The editor autosaves the draft; "Go live"
// copies it to `live`, which is what viewers see. Only the routes below write
// `builder` — POST /api/pages/:id/content keeps whatever is on disk.
//
// SECURITY: GrapesJS produces raw HTML and CSS, and Alex opens pages owned by
// `pages` users in his admin session. So every builder save is cleaned through
// an allow-list (sanitize-html), and cleaned AGAIN on every read (the
// Designer's Claude engine can write page files directly). The rules follow
// the page OWNER's role on read, and the saver's role on write.
const fs = require('fs');
const path = require('path');
const sanitizeHtml = require('sanitize-html');

const MAX_HTML = 500 * 1024;
const MAX_CSS = 200 * 1024;

// Attribute values on widget elements: widgets copy some of them into their
// own innerHTML, so values are restricted to characters that cannot form
// markup or script, for every role (same rule as restrictWidgetHtml).
const SAFE_ATTR_VALUE = /^[^;(){}<>"'`\\]{0,200}$/;
// Attributes a component reads but doesn't list in observedAttributes/configSchema.
// <ada-widget> (ChatWidget.js) is the agent's generative-UI element; its
// `payload` (JSON) is deliberately NOT allowed — it can't pass SAFE_ATTR_VALUE.
const EXTRA_ATTRS = {
  'ada-widget': ['type', 'label', 'icon', 'confirm', 'script-id', 'endpoint', 'method', 'src', 'caption', 'alt',
    'target', 'value', 'max', 'unit', 'path', 'refresh', 'start-hidden', 'show-after', 'show-until'],
};
const ATTR_NAME = /^[a-z][a-z0-9-]{0,40}$/;

const STRUCTURE_TAGS = ['section', 'header', 'footer', 'main', 'article', 'aside', 'nav', 'div', 'span',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'u', 's',
  'small', 'sub', 'sup', 'br', 'hr', 'blockquote', 'figure', 'figcaption', 'code', 'pre', 'mark',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'label'];
const ADMIN_ONLY_TAGS = ['iframe', 'video', 'source'];
const IFRAME_HOSTS = ['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com',
  'www.google.com', 'maps.google.com'];
// Inline styles: only layout/size properties with plain values. Real styling
// lives in the page CSS (cleaned separately).
const LEN = /^-?\d{1,5}(\.\d{1,3})?(px|%|rem|em|vh|vw)?$/;
const ALLOWED_STYLES = { '*': {
  height: [LEN], 'min-height': [LEN], 'max-height': [LEN], width: [LEN], 'min-width': [LEN], 'max-width': [LEN],
  'text-align': [/^(left|right|center|justify)$/], display: [/^(block|inline-block|flex|grid|none)$/],
} };

// Widget elements a `pages` user may place (mirrors SAFE_WIDGET_TAGS in
// server.js, plus the Todo widget's attribute settings).
const PAGES_ROLE_WIDGETS = {
  'ada-clock': ['format', 'font'], 'ada-analog-clock': [], 'ada-countdown': ['target', 'title'],
  'ada-timer': ['minutes', 'title'], 'ada-stopwatch': ['title'], 'ada-greeting': ['name'],
  'ada-weather': [], 'ada-photo-frame': ['library', 'interval'],
  'ada-todo': ['show-past-due', 'show-today', 'show-upcoming'],
};

// --- Component catalog (all widgets and sections, with their settings) ---
let catalogCache = { key: '', value: [] };
function readCatalog(componentsDir) {
  let files = [];
  try { files = fs.readdirSync(componentsDir).filter(f => f.endsWith('.js')); } catch (e) { return []; }
  const key = files.map(f => { try { return f + fs.statSync(path.join(componentsDir, f)).mtimeMs; } catch (e) { return f; } }).join('|');
  if (key === catalogCache.key) return catalogCache.value;
  const out = [];
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(componentsDir, f), 'utf8'); } catch (e) { continue; }
    const def = /customElements\.define\(\s*['"](ada-[a-z0-9-]+)['"]/.exec(src);
    if (!def) continue;
    const obs = /observedAttributes\(\)\s*\{\s*return\s*\[([^\]]*)\]/.exec(src);
    const observed = obs ? [...obs[1].matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)].map(m => m[1]) : [];
    // configSchema attrs (names only — the editor reads the full schema from
    // the component class itself inside the canvas).
    const at = src.indexOf('static configSchema');
    const schemaAttrs = at === -1 ? [] : [...src.slice(at, at + 4000).split('];')[0].matchAll(/attr:\s*['"]([a-z][a-z0-9-]*)['"]/g)].map(m => m[1]);
    const tag = def[1];
    // data-widget-id: the stable id Kanban, Document and To-do keep their data under.
    out.push({ tag, file: f, kind: tag.startsWith('ada-section-') ? 'section' : 'widget', attrs: [...new Set([...observed, ...schemaAttrs, ...(EXTRA_ATTRS[tag] || []), 'theme', 'accent', 'data-widget-id'])] });
  }
  catalogCache = { key, value: out };
  return out;
}

// --- Cleaning ---
function widgetAttrFilter(allowedAttrs) {
  return (tagName, attribs) => {
    const out = {};
    for (const [k, v] of Object.entries(attribs)) {
      if (k === 'id' || k === 'class') { out[k] = v; continue; }
      if (k === 'style') { out[k] = v; continue; }       // narrowed later by allowedStyles
      if (ATTR_NAME.test(k) && allowedAttrs.includes(k) && SAFE_ATTR_VALUE.test(v)) out[k] = v;
    }
    return { tagName, attribs: out };
  };
}

function cleanHtml(html, { role, catalog }) {
  const widgets = role === 'admin'
    ? Object.fromEntries(catalog.map(c => [c.tag, c.attrs]))
    : Object.fromEntries(Object.entries(PAGES_ROLE_WIDGETS).map(([t, a]) => [t, [...a, 'theme', 'accent', 'data-widget-id']]));
  const tags = [...STRUCTURE_TAGS, ...(role === 'admin' ? ADMIN_ONLY_TAGS : []), ...Object.keys(widgets)];
  const allowedAttributes = {
    '*': ['id', 'class', 'title', 'style', 'role', 'aria-label', 'aria-hidden'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    iframe: ['src', 'width', 'height', 'allowfullscreen', 'frameborder', 'allow', 'loading'],
    video: ['src', 'controls', 'autoplay', 'muted', 'loop', 'playsinline', 'poster', 'width', 'height'],
    source: ['src', 'type'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
  };
  for (const [tag, attrs] of Object.entries(widgets)) allowedAttributes[tag] = attrs;
  const transformTags = {
    a: (tagName, attribs) => {
      if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer';
      else delete attribs.target;
      return { tagName, attribs };
    },
  };
  for (const [tag, attrs] of Object.entries(widgets)) transformTags[tag] = widgetAttrFilter(attrs);
  const report = [];
  const clean = sanitizeHtml(String(html || '').slice(0, MAX_HTML), {
    allowedTags: tags,
    allowedAttributes,
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'], iframe: ['https'], video: ['https'], source: ['https'] },
    allowProtocolRelative: false,
    allowedIframeHostnames: role === 'admin' ? IFRAME_HOSTS : [],
    allowIframeRelativeUrls: false,
    disallowedTagsMode: 'discard',
    transformTags,
    // An iframe whose src was refused (not an allowed host) is dropped whole.
    exclusiveFilter: frame => frame.tag === 'iframe' && !frame.attribs.src,
  });
  if (String(html || '').length > MAX_HTML) report.push(`page HTML cut to ${MAX_HTML / 1024} KB`);
  return { html: clean, report };
}

// CSS goes into a <style> element: no "<" at all (cannot close the element),
// no imports or legacy script hooks, and url() only to https or the server's
// own /media files.
function cleanCss(css) {
  let s = String(css || '').slice(0, MAX_CSS);
  const before = s;
  s = s.replace(/</g, '')
       .replace(/@import[^;]*;?/gi, '')
       .replace(/expression\s*\(/gi, 'x(')
       .replace(/(behavior|-moz-binding)\s*:[^;}]*/gi, '')
       .replace(/javascript\s*:/gi, '')
       .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) =>
         (/^https:\/\/[^\s'"()\\]+$/.test(u) || /^\/media\/[^\s'"()\\]+$/.test(u)) ? `url("${u}")` : 'none');
  return { css: s, report: s === before ? [] : ['some page CSS was removed for safety'] };
}

function cleanVersion(v, opts) {
  if (!v || typeof v !== 'object') return null;
  const h = cleanHtml(v.html, opts), c = cleanCss(v.css);
  const out = { html: h.html, css: c.css };
  for (const k of ['updatedAt', 'updatedBy', 'at', 'by']) if (typeof v[k] === 'string') out[k] = v[k].slice(0, 80);
  return { version: out, report: [...h.report, ...c.report] };
}

// --- Starting point for pages built with the old grid editor ---
// Turns the legacy widget grid into builder HTML: one responsive grid, each
// widget at its old width (cols of 6), sized by its content like the old grid. Title/link cards
// become simple cards. The result is a STARTER only: it is cleaned like any
// other content and changes nothing until the user presses Go live.
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function legacyToHtml(doc) {
  const widgets = (doc && Array.isArray(doc.widgets) ? doc.widgets : []).filter(w => w && !w.hidden);
  if (!widgets.length) return '';
  const cells = widgets.map(w => {
    const cols = Math.max(1, Math.min(6, Number(w.cols) || (w.size === 'full' ? 6 : w.size && w.size[0] === '2' ? 2 : 1)));
    const span = cols >= 6 ? 'md:col-span-6' : `md:col-span-${cols}`;
    // Keep the old widget id so Kanban boards, documents and To-do settings keep their data.
    let html = String(w.html || '').trim();
    if (/^<ada-[a-z-]+/.test(html) && !/data-widget-id=/.test(html.split('>')[0]) && /^[A-Za-z0-9_-]{1,64}$/.test(w.id || '')) {
      html = html.replace(/^<(ada-[a-z-]+)/, `<$1 data-widget-id="${w.id}"`);
    }
    const body = html
      ? html
      : `<div class="h-full p-5 rounded-2xl bg-white/5 border border-white/10"><h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">${esc(w.title)}</h3>` +
        (w.link && w.link.href ? `<a href="${esc(w.link.href)}" class="text-indigo-500">${esc(w.link.label || 'Open')}</a>` : '') + `</div>`;
    return `<div class="${span}">${body}</div>`;   // sized by its content, like the old grid
  }).join('');
  return `<section class="py-2"><div class="grid grid-cols-1 md:grid-cols-6 gap-4">${cells}</div></section>`;   // no side padding: matches the old grid
}

// --- Routes ---
function registerPageBuilder(app, d) {
  const componentsDir = path.join(__dirname, '../public/components');
  const catalog = () => readCatalog(componentsDir);
  const HOME = { id: 'home', title: 'Home', owner: 'alex', isHome: true };
  const pageOf = (id) => id === 'home' ? HOME : (d.readPagesRegistry().find(p => p.id === id) || null);
  const fileOf = (id) => id === 'home' ? d.homeBuilderFile : d.getPageDocPath(id);
  const ownerRole = (pg) => d.isAdminUserName(pg.owner || 'alex') ? 'admin' : 'pages';
  const readDoc = (id) => { const f = fileOf(id); return fs.existsSync(f) ? d.readJsonStoreOrThrow(f) : (id === 'home' ? {} : { widgets: [] }); };
  const writeDoc = (id, doc) => d.writeFileAtomic(fileOf(id), JSON.stringify(doc, null, 2));
  const canEditPage = (req, pg) => d.isAdminReq(req) || (!pg.isHome && (pg.owner || 'alex') === d.ownerName(req));
  const unpublished = (b) => !!(b && b.draft && (!b.live || b.draft.html !== b.live.html || b.draft.css !== b.live.css));

  app.get('/api/builder/catalog', (req, res) => {
    const all = catalog();
    res.json(d.isAdminReq(req) ? all : all.filter(c => PAGES_ROLE_WIDGETS[c.tag]));
  });

  app.get('/api/pages/:id/builder', (req, res) => {
    const pg = pageOf(req.params.id);
    if (!pg) return res.status(404).json({ error: 'Page not found' });
    const doc = readDoc(pg.id), b = doc.builder || {};
    const opts = { role: ownerRole(pg), catalog: catalog() };
    const canEdit = canEditPage(req, pg);
    const live = cleanVersion(b.live, opts);
    const draft = canEdit ? cleanVersion(b.draft, opts) : null;
    // First time in the builder: start from the page's current (grid) layout.
    let starter = null;
    if (canEdit && !b.live && !b.draft) {
      const legacy = pg.isHome ? d.readHomepage() : readDoc(pg.id);
      const html = legacyToHtml(legacy);
      if (html) starter = cleanVersion({ html, css: '' }, opts).version;
    }
    res.json({ page: { id: pg.id, title: pg.title }, live: live && live.version, draft: draft && draft.version, starter, unpublished: canEdit && unpublished(b), canEdit });
  });

  app.put('/api/pages/:id/builder/draft', (req, res) => {
    const pg = pageOf(req.params.id);
    if (!pg) return res.status(404).json({ error: 'Page not found' });
    if (!canEditPage(req, pg)) return res.status(403).json({ error: 'Not available for your account.' });
    const body = req.body || {};
    const doc = readDoc(pg.id), b = doc.builder || {};
    if (body.expectedUpdatedAt && b.draft && b.draft.updatedAt && b.draft.updatedAt !== body.expectedUpdatedAt) {
      return res.status(409).json({ error: 'stale', message: 'This page was changed elsewhere since you opened it.', updatedAt: b.draft.updatedAt, updatedBy: b.draft.updatedBy });
    }
    const role = d.isAdminReq(req) ? 'admin' : 'pages';
    const { version, report } = cleanVersion({ html: body.html, css: body.css }, { role, catalog: catalog() });
    version.updatedAt = new Date().toISOString();
    version.updatedBy = d.ownerName(req);
    doc.builder = { ...b, draft: version };
    writeDoc(pg.id, doc);
    res.json({ ok: true, updatedAt: version.updatedAt, unpublished: unpublished(doc.builder), report });
  });

  app.post('/api/pages/:id/builder/go-live', (req, res) => {
    const pg = pageOf(req.params.id);
    if (!pg) return res.status(404).json({ error: 'Page not found' });
    if (!canEditPage(req, pg)) return res.status(403).json({ error: 'Not available for your account.' });
    const doc = readDoc(pg.id), b = doc.builder || {};
    if (!b.draft) return res.status(409).json({ error: 'Nothing to go live with yet.' });
    // Re-clean with the saver's rules, then keep the previous version in history.
    const role = d.isAdminReq(req) ? 'admin' : 'pages';
    const { version } = cleanVersion(b.draft, { role, catalog: catalog() });
    // Pages: the whole doc goes to page history. Home: its history covers
    // homepage.json only, so the previous live version is kept here instead.
    if (pg.isHome) b.previous = b.live || null;
    else d.snapshotBeforeWrite(pg.id, fileOf(pg.id), d.ownerName(req));
    doc.builder = { ...b, live: { html: version.html, css: version.css, at: new Date().toISOString(), by: d.ownerName(req) } };
    writeDoc(pg.id, doc);
    res.json({ ok: true, at: doc.builder.live.at, unpublished: false });
  });
}

// Route rules for `pages` users (called from authorizeRole). Returns true
// (allow), false (deny) or null (not a builder route).
function builderRouteAllowed(req, pageVisibleTo, pageOwnedBy) {
  const m = req.method, p = req.path, u = req.user;
  let mm;
  if (p === '/api/builder/catalog') return m === 'GET';
  if ((mm = /^\/api\/pages\/([^/]+)\/builder$/.exec(p))) return m === 'GET' && pageVisibleTo(u, mm[1]);
  if ((mm = /^\/api\/pages\/([^/]+)\/builder\/draft$/.exec(p))) return m === 'PUT' && pageOwnedBy(u, mm[1]);
  if ((mm = /^\/api\/pages\/([^/]+)\/builder\/go-live$/.exec(p))) return m === 'POST' && pageOwnedBy(u, mm[1]);
  return null;
}

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

// Whether Home has a live builder version (for /api/homepage's builderLive flag).
function homeBuilderLive(file) {
  try { const doc = JSON.parse(fs.readFileSync(file, 'utf8')); return !!(doc.builder && doc.builder.live); } catch (e) { return false; }
}

module.exports = { registerPageBuilder, builderRouteAllowed, homeBuilderLive, legacyToHtml, cleanHtml, cleanCss, readCatalog, cleanDocHtml, DOC_ID_RE };
