// Page Builder v2 phase 11b (fb-1790206467753): contact form. On a published
// page it posts to the site's own /api/contact (a Cloudflare Pages Function)
// behind a Turnstile spam check; messages land in the dashboard inbox. In the
// builder it is a preview and does not submit.
import { esc, shell, headingStyle, buttonStyle, lines } from './sectionUtils.js';
// Custom questions (fb-1790220062389): one per line, "Question | type | options".
// Types: short (default), long, email, choice (options separated by commas).
// A trailing * on the question makes it required.
export function parseFormFields(text) {
  return lines(text || '', 12).map(l => {
    const [q = '', t = '', opts = ''] = l.split('|').map(x => x.trim());
    let label = q; let req = false;
    if (label.endsWith('*')) { req = true; label = label.slice(0, -1).trim(); }
    const options = opts.split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
    let type = ['short', 'long', 'email', 'choice'].includes(t.toLowerCase()) ? t.toLowerCase() : 'short';
    if (type === 'choice' && !options.length) type = 'short';
    return { label: label.slice(0, 80), type, req, options };
  }).filter(x => x.label);
}
class FormSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Send us a message' },
    { attr: 'intro', label: 'Intro text', type: 'textarea', default: '' },
    { attr: 'fields', label: 'Your questions, one per line: Question | short, long, email or choice | options (comma-separated). End a question with * to require it.', type: 'textarea', default: '' },
    { attr: 'ask', label: 'Also ask for', type: 'select', options: [['all', 'Name, email and a message'], ['name', 'Just their name'], ['none', 'Nothing else (only my questions)']], default: 'all' },
    { attr: 'button', label: 'Button label', type: 'text', default: 'Send' },
  ];
  static get observedAttributes() { return FormSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const qs = parseFormFields(a('fields'));
    // Without questions of its own the form is the classic contact form.
    const ask = qs.length && ['name', 'none'].includes(a('ask')) ? a('ask') : 'all';
    const field = 'w-full px-3 py-2.5 mt-1';
    const fs = 'background: color-mix(in srgb, var(--ada-text) 6%, transparent); border: 1px solid color-mix(in srgb, var(--ada-text) 18%, transparent); border-radius: calc(var(--ada-radius) * .5); color: var(--ada-text); font: inherit;';
    this.innerHTML = shell(`<div class="max-w-xl mx-auto">
      <h2 data-edit="heading" class="text-center" style="${headingStyle()} margin-bottom: 1rem;">${esc(a('heading', 'Send us a message'))}</h2>
      ${a('intro') ? `<p class="text-center" style="color: var(--ada-muted); margin-bottom: 1.5rem;">${esc(a('intro'))}</p>` : ''}
      <form data-contact-form method="post" action="/api/contact" class="space-y-4 relative">
        <input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute; left:-9999px; width:1px; height:1px;">
        ${ask !== 'none' ? `<label class="block text-sm" style="font-weight: 600;">Name<input name="name" required maxlength="100" autocomplete="name" class="${field}" style="${fs}"></label>` : ''}
        ${ask === 'all' ? `<label class="block text-sm" style="font-weight: 600;">Email<input type="email" name="email" required maxlength="200" autocomplete="email" class="${field}" style="${fs}"></label>` : ''}
        ${qs.map(q => q.type === 'choice'
          ? `<fieldset class="text-sm"><legend style="font-weight: 600;">${esc(q.label)}</legend><div class="mt-1 space-y-1.5">${q.options.map(o => `<label class="flex items-center gap-2 cursor-pointer"><input type="radio" name="q:${esc(q.label)}" value="${esc(o)}"${q.req ? ' required' : ''} style="accent-color: var(--ada-brand);"> <span>${esc(o)}</span></label>`).join('')}</div></fieldset>`
          : `<label class="block text-sm" style="font-weight: 600;">${esc(q.label)}${q.type === 'long'
            ? `<textarea name="q:${esc(q.label)}"${q.req ? ' required' : ''} maxlength="2000" rows="4" class="${field}" style="${fs}"></textarea>`
            : `<input${q.type === 'email' ? ' type="email"' : ''} name="q:${esc(q.label)}"${q.req ? ' required' : ''} maxlength="2000" class="${field}" style="${fs}">`}</label>`).join('')}
        ${ask === 'all' ? `<label class="block text-sm" style="font-weight: 600;">Message${qs.length ? ' <span style="font-weight: 400; color: var(--ada-muted);">(optional)</span>' : ''}<textarea name="message"${qs.length ? '' : ' required'} maxlength="4000" rows="5" class="${field}" style="${fs}"></textarea></label>` : ''}
        <div class="cf-turnstile" data-sitekey="__ADA_TURNSTILE_SITEKEY__"></div>
        <button type="submit" class="w-full px-6 py-3 font-semibold" style="${buttonStyle('brand')}">${esc(a('button', 'Send'))}</button>
      </form></div>`);
    // Builder preview only (published pages carry no scripts).
    const f = this.querySelector('form');
    f.addEventListener('submit', (e) => { e.preventDefault(); if (window.showAppToast) window.showAppToast('This form works on the published page — messages arrive in your dashboard inbox.', 'info'); });
  }
}
customElements.define('ada-section-form', FormSection);
