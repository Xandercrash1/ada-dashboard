// DocBodyWidget.js — <ada-doc-body>: a rich-text document (2026-10-04, Alex).
//
// Locked by default: the document shows as finished text. "Edit" opens a full
// toolbar (Quill: fonts, sizes, headings, bold/italic/underline/strike, text
// colour + highlight, lists and checklists, alignment, indent, quote, code,
// links, images, clear formatting, undo/redo); "Done" saves and locks it again.
// Changes autosave while editing.
//
// Storage is unchanged: /api/docs/<id> { text, format?, updatedAt }, with the
// optimistic updatedAt check. Rich documents are saved as format 'html' and
// cleaned on the server (save AND read); older Markdown documents still show,
// and become rich text the first time they're edited.
//
// The id comes from the widget-id attribute, or the nearest data-widget-id
// (the element itself on page-builder pages, the grid card on old pages).
//
// The old "/" insert-a-widget menu is a planned feature (backlog), not here.

class DocBodyWidget extends HTMLElement {
  // Libraries are bundled in /vendor (no CDN) and loaded once per page.
  static loadAssets() {
    if (DocBodyWidget._assets) return DocBodyWidget._assets;
    const css = (href) => new Promise(res => {
      if (document.querySelector(`link[href="${href}"]`)) return res();
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l);
    });
    const js = (src, ready) => new Promise((res, rej) => {
      if (ready()) return res();
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s);
    });
    DocBodyWidget.ensureStyles();
    DocBodyWidget._assets = Promise.all([
      css('/vendor/quill/quill.snow.css'),
      js('/vendor/dompurify/purify.min.js', () => !!window.DOMPurify),
      js('/vendor/marked/marked.min.js', () => !!window.marked),
    ]).then(() => js('/vendor/quill/quill.js', () => !!window.Quill));
    return DocBodyWidget._assets;
  }

  // Theme-aware look for Quill's toolbar and the read view (light + dark).
  static ensureStyles() {
    if (document.getElementById('ada-doc-styles')) return;
    const st = document.createElement('style');
    st.id = 'ada-doc-styles';
    st.textContent = `
      /* While editing, the toolbar stays put and only the text scrolls. */
      ada-doc-body [data-role=body].editing { display:flex; flex-direction:column; overflow:hidden; }
      ada-doc-body [data-role=body].editing .ql-toolbar { flex:none; }
      ada-doc-body [data-role=body].editing .ql-container { flex:1; min-height:0; overflow:auto; }
      ada-doc-body .ql-toolbar.ql-snow { border:0; border-bottom:1px solid rgba(100,116,139,.25); padding:6px 4px; display:flex; flex-wrap:wrap; gap:2px; }
      ada-doc-body .ql-container.ql-snow { border:0; font-size:15px; }
      ada-doc-body .ql-editor { padding:16px 4px; line-height:1.6; min-height:220px; }
      ada-doc-body .doc-view .ql-editor { min-height:0; padding:4px; }
      ada-doc-body .ql-editor.ql-blank::before { color:#94a3b8; font-style:normal; left:4px; }
      ada-doc-body .ql-editor h1 { font-size:1.9em; font-weight:700; } ada-doc-body .ql-editor h2 { font-size:1.5em; font-weight:700; } ada-doc-body .ql-editor h3 { font-size:1.2em; font-weight:600; }
      ada-doc-body .ql-editor a { color:#6366f1; text-decoration:underline; }
      ada-doc-body .ql-editor blockquote { border-left:4px solid #6366f1; padding-left:12px; opacity:.85; }
      .dark ada-doc-body .ql-snow .ql-stroke { stroke:#cbd5e1; }
      .dark ada-doc-body .ql-snow .ql-fill, .dark ada-doc-body .ql-snow .ql-stroke.ql-fill { fill:#cbd5e1; }
      .dark ada-doc-body .ql-snow .ql-picker { color:#cbd5e1; }
      .dark ada-doc-body .ql-snow .ql-picker-options { background:#1f1f26; border-color:#2c2c36; }
      .dark ada-doc-body .ql-snow.ql-toolbar button:hover .ql-stroke, .dark ada-doc-body .ql-snow.ql-toolbar button.ql-active .ql-stroke { stroke:#818cf8; }
      .dark ada-doc-body .ql-snow.ql-toolbar button.ql-active .ql-fill { fill:#818cf8; }
      .dark ada-doc-body .ql-snow .ql-tooltip { background:#1f1f26; color:#e2e8f0; border-color:#2c2c36; box-shadow:none; }
      .dark ada-doc-body .ql-snow .ql-tooltip input[type=text] { background:#121212; color:#e2e8f0; border-color:#2c2c36; }
      .dark ada-doc-body .ql-editor pre.ql-syntax, .dark ada-doc-body .ql-editor pre { background:#0d0d10; color:#e2e8f0; }
      ada-doc-body .doc-view .embedded-widget { white-space:normal; }
    `;
    document.head.appendChild(st);
  }

  connectedCallback() {
    this.classList.add('block', 'w-full', 'h-full', 'min-h-[300px]');
    this.widgetId = this.getAttribute('widget-id');
    if (!this.widgetId) {
      const wrapper = this.closest('[data-widget-id]');
      this.widgetId = wrapper ? wrapper.getAttribute('data-widget-id') : 'default-body';
    }
    this.editing = false;
    this.html = '';
    this.updatedAt = null;
    this.render();
    DocBodyWidget.loadAssets().then(() => this.load()).catch(e => this.showError(e.message));
  }

  disconnectedCallback() { if (this.editing) this.save(); }

  render() {
    this.innerHTML = `
      <div class="relative w-full h-full flex flex-col rounded-2xl">
        <div class="flex items-center justify-end gap-2 mb-1">
          <span data-role="status" class="text-[11px] text-gray-500 dark:text-gray-400 mr-auto"></span>
          <button data-role="toggle" type="button" class="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 flex items-center gap-1.5">
            <i class="fa-solid fa-pen"></i> <span>Edit</span>
          </button>
        </div>
        <div data-role="body" class="flex-1 min-h-0 overflow-auto text-gray-800 dark:text-gray-200"></div>
      </div>`;
    this.querySelector('[data-role="toggle"]').addEventListener('click', () => this.editing ? this.finishEditing() : this.startEditing());
  }

  setStatus(t) { const s = this.querySelector('[data-role="status"]'); if (s) s.textContent = t || ''; }
  showError(msg) { this.setStatus(msg); }
  clean(html) { return window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['data-list', 'target'] }) : ''; }

  async load() {
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(this.widgetId)}`);
      if (!res.ok) { this.showError(res.status === 403 ? 'Not available for your account.' : `Could not load (HTTP ${res.status}).`); return; }
      const doc = await res.json();
      this.updatedAt = doc.updatedAt || null;
      // Older documents are Markdown: shown as HTML, saved as rich text after the first edit.
      this.html = doc.format === 'html' ? (doc.text || '') : (doc.text ? window.marked.parse(String(doc.text)) : '');
      this.showView();
    } catch (e) { this.showError('Could not load the document.'); }
  }

  // [widget: id] shortcodes (old grid pages, e.g. Home): in the read view the
  // widget with that id is shown inside the document and its own card is hidden
  // from the grid, as the old widget did. Widget html comes from the page's own
  // layout (same trust level as the grid itself). Stays as text while editing.
  embedWidgets(html) {
    document.querySelectorAll('.widget-container').forEach(c => { if (c.dataset.embeddedInDoc === this.widgetId) { c.style.display = ''; delete c.dataset.embeddedInDoc; } });
    const widgets = (window.homepageDoc && window.homepageDoc.widgets) || [];
    if (!widgets.length) return html;
    const embed = (match, id) => {
      const w = widgets.find(x => x.id === id);
      if (!w || !w.html) return match;
      const card = document.getElementById(w.id + '-container');
      if (card) { card.style.display = 'none'; card.dataset.embeddedInDoc = this.widgetId; }
      return `<div class="embedded-widget my-6 relative min-h-[150px]">${w.html}</div>`;
    };
    return html
      .replace(/<p>\s*\[widget:\s*([a-zA-Z0-9_-]+)\]\s*<\/p>/g, embed)
      .replace(/\[widget:\s*([a-zA-Z0-9_-]+)\]/g, embed);
  }

  showView() {
    const body = this.querySelector('[data-role="body"]');
    body.classList.remove('editing');
    const html = this.embedWidgets(this.clean(this.html));
    body.innerHTML = html.replace(/<p><br><\/p>/g, '').trim()
      ? `<div class="doc-view ql-snow"><div class="ql-editor">${html}</div></div>`
      : `<div class="text-gray-400 dark:text-gray-500 text-sm py-6">Empty document — press <b>Edit</b> to start writing.</div>`;
    const t = this.querySelector('[data-role="toggle"]');
    t.innerHTML = '<i class="fa-solid fa-pen"></i> <span>Edit</span>';
    t.classList.remove('bg-indigo-600', 'text-white', 'border-indigo-600');
  }

  startEditing() {
    if (!window.Quill) return;
    this.editing = true;
    // Embedded widgets go back to their grid cards while the shortcodes are plain text.
    document.querySelectorAll('.widget-container').forEach(c => { if (c.dataset.embeddedInDoc === this.widgetId) { c.style.display = ''; delete c.dataset.embeddedInDoc; } });
    const body = this.querySelector('[data-role="body"]');
    body.classList.add('editing');
    body.innerHTML = '<div data-role="editor"></div>';
    const icons = window.Quill.import('ui/icons');
    icons.undo = '<svg viewBox="0 0 18 18"><polygon class="ql-fill ql-stroke" points="6 10 4 12 2 10 6 10"></polygon><path class="ql-stroke" d="M8.09,13.91A4.6,4.6,0,0,0,9,14,5,5,0,1,0,4,9"></path></svg>';
    icons.redo = '<svg viewBox="0 0 18 18"><polygon class="ql-fill ql-stroke" points="12 10 14 12 16 10 12 10"></polygon><path class="ql-stroke" d="M9.91,13.91A4.6,4.6,0,0,1,9,14a5,5,0,1,1,5-5"></path></svg>';
    this.quill = new window.Quill(body.querySelector('[data-role="editor"]'), {
      theme: 'snow',
      placeholder: 'Start writing your document here...',
      modules: {
        history: { delay: 800, maxStack: 200, userOnly: true },
        toolbar: {
          container: [
            ['undo', 'redo'],
            [{ font: [] }, { size: ['small', false, 'large', 'huge'] }],
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ color: [] }, { background: [] }],
            [{ script: 'sub' }, { script: 'super' }],
            [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
            [{ indent: '-1' }, { indent: '+1' }, { align: [] }],
            ['blockquote', 'code-block', 'link', 'image'],
            ['clean'],
          ],
          handlers: {
            undo: () => this.quill.history.undo(),
            redo: () => this.quill.history.redo(),
            // Images by address (a pasted/uploaded file would be a huge data: URL the server drops).
            image: () => {
              const url = window.prompt('Image address (https://… or /media/…)');
              if (!url) return;
              const range = this.quill.getSelection(true);
              this.quill.insertEmbed(range ? range.index : this.quill.getLength(), 'image', url.trim(), 'user');
            },
          },
        },
      },
    });
    if (this.html) this.quill.clipboard.dangerouslyPasteHTML(this.clean(this.html), 'silent');
    this.quill.history.clear();
    this.quill.on('text-change', (d, o, source) => {
      if (source !== 'user') return;
      this.dirty = true; this.setStatus('Editing…');
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 1000);
    });
    const t = this.querySelector('[data-role="toggle"]');
    t.innerHTML = '<i class="fa-solid fa-check"></i> <span>Done</span>';
    t.classList.add('bg-indigo-600', 'text-white', 'border-indigo-600');
    this.quill.focus();
  }

  async finishEditing() {
    clearTimeout(this.saveTimer);
    if (this.dirty) await this.save();
    this.editing = false;
    this.quill = null;
    this.showView();
    this.setStatus('');
  }

  async save() {
    if (!this.quill) return;
    const html = this.quill.root.innerHTML;
    this.dirty = false;
    this.setStatus('Saving…');
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(this.widgetId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: html, format: 'html', expectedUpdatedAt: this.updatedAt }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.status === 409) {
        this.setStatus('Changed elsewhere — reload to see the latest version (your last edit was not saved).');
        if (window.showToast) window.showToast('This document was changed elsewhere. Reload before editing.', 'warn');
        return;
      }
      if (!res.ok) { this.dirty = true; this.setStatus('Save failed — will retry'); this.saveTimer = setTimeout(() => this.save(), 4000); return; }
      this.updatedAt = out.updatedAt;
      this.html = html;
      this.setStatus('Saved');
    } catch (e) { this.dirty = true; this.setStatus('Save failed — will retry'); this.saveTimer = setTimeout(() => this.save(), 4000); }
  }
}
customElements.define('ada-doc-body', DocBodyWidget);
