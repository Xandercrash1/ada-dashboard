// safe-md.js — window.safeMd(text): Markdown to HTML that can't run script (review 2026-11-25). Used for everything the
// page renders from text it didn't write itself: ticket bodies, task notes, agent chat replies, chat bubbles, the
// scratchpad preview and Markdown documents.
// An allowlist: marked's output is parsed inertly and rebuilt from fresh elements of plain tags with a few safe
// attributes. Unknown elements (custom widgets, noscript and the like) are unwrapped to their text; script-like ones are
// dropped. Code-block Copy buttons come through as <button data-copy="…"> and work through one click handler below.
(function () {
  var TAGS = { P: 1, BR: 1, HR: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1, DEL: 1, CODE: 1, PRE: 1, KBD: 1, BLOCKQUOTE: 1, UL: 1, OL: 1, LI: 1, A: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, IMG: 1, SPAN: 1, DIV: 1, SUP: 1, SUB: 1, BUTTON: 1, INPUT: 1 };
  var DROP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, SVG: 1, MATH: 1, NOSCRIPT: 1, TEXTAREA: 1, TITLE: 1, XMP: 1, NOEMBED: 1, NOFRAMES: 1, PLAINTEXT: 1, SELECT: 1, FORM: 1 };
  function safeUrl(v, img) { return (img ? /^(https?:\/\/|\/(?!\/))/i : /^(https?:\/\/|mailto:|\/(?!\/)|#)/i).test(String(v || '').trim()); }
  function copy(from, to) {
    for (var i = 0; i < from.childNodes.length; i++) {
      var n = from.childNodes[i];
      if (n.nodeType === 3) { to.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      var tag = n.tagName.toUpperCase();
      if (DROP[tag]) continue;
      if (!TAGS[tag]) { copy(n, to); continue; }
      if (tag === 'INPUT' && (n.getAttribute('type') || '').toLowerCase() !== 'checkbox') continue;   // only GFM task-list boxes
      if (tag === 'BUTTON' && !/^[A-Za-z0-9+/=]{0,200000}$/.test(n.getAttribute('data-copy') || '-')) { copy(n, to); continue; }
      if (tag === 'IMG' && !safeUrl(n.getAttribute('src'), true)) continue;
      var el = document.createElement(tag.toLowerCase());
      var cls = n.getAttribute('class');
      if (cls && /^[\w\s:/.\-\[\]%#()!]{0,400}$/.test(cls)) el.setAttribute('class', cls);   // styling only
      if (tag === 'A' && safeUrl(n.getAttribute('href'))) { el.setAttribute('href', n.getAttribute('href')); el.setAttribute('rel', 'noopener noreferrer'); el.setAttribute('target', '_blank'); }
      if (tag === 'IMG') { el.setAttribute('src', n.getAttribute('src')); el.setAttribute('alt', n.getAttribute('alt') || ''); }
      if ((tag === 'A' || tag === 'IMG') && n.getAttribute('title')) el.setAttribute('title', n.getAttribute('title'));
      if (tag === 'OL' && /^\d+$/.test(n.getAttribute('start') || '')) el.setAttribute('start', n.getAttribute('start'));
      if (tag === 'INPUT') { el.setAttribute('type', 'checkbox'); if (n.hasAttribute('checked')) el.setAttribute('checked', ''); if (n.hasAttribute('disabled')) el.setAttribute('disabled', ''); }
      if (tag === 'BUTTON') { el.setAttribute('type', 'button'); el.setAttribute('data-copy', n.getAttribute('data-copy')); }
      if ((tag === 'TD' || tag === 'TH') && /^(left|right|center)$/.test(n.getAttribute('align') || '')) el.setAttribute('align', n.getAttribute('align'));
      to.appendChild(el); copy(n, el);
    }
  }
  // safeHtml(html): the same filter for HTML that's already rendered (pages with their own Markdown renderer).
  window.safeHtml = function (html) {
    var doc = new DOMParser().parseFromString('<!doctype html><body>' + String(html == null ? '' : html), 'text/html');   // inert: nothing in it runs
    var out = document.createElement('div');
    copy(doc.body, out);
    return out.innerHTML;
  };
  window.safeMd = function (text) {
    var t = String(text == null ? '' : text);
    return window.safeHtml(window.marked ? window.marked.parse(t) : t.replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }));
  };
  // Copy buttons on code blocks (the renderer in index.html adds <button data-copy="base64">).
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('button[data-copy]');
    if (!btn) return;
    try {
      var textv = decodeURIComponent(escape(atob(btn.getAttribute('data-copy'))));
      navigator.clipboard.writeText(textv).then(function () {
        var orig = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i> Copied!';
        setTimeout(function () { btn.innerHTML = orig; }, 2000);
      });
    } catch (err) { /* nothing to copy */ }
  });
})();
