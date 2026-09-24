// Page Builder v2 phase 11b (fb-1790206467753): contact form. On a published
// page it posts to the site's own /api/contact (a Cloudflare Pages Function)
// behind a Turnstile spam check; messages land in the dashboard inbox. In the
// builder it is a preview and does not submit.
import { esc, shell, headingStyle, buttonStyle } from './sectionUtils.js';
class FormSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Send us a message' },
    { attr: 'intro', label: 'Intro text', type: 'textarea', default: '' },
    { attr: 'button', label: 'Button label', type: 'text', default: 'Send' },
  ];
  static get observedAttributes() { return FormSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const field = 'w-full px-3 py-2.5 mt-1';
    const fs = 'background: color-mix(in srgb, var(--ada-text) 6%, transparent); border: 1px solid color-mix(in srgb, var(--ada-text) 18%, transparent); border-radius: calc(var(--ada-radius) * .5); color: var(--ada-text); font: inherit;';
    this.innerHTML = shell(`<div class="max-w-xl mx-auto">
      <h2 data-edit="heading" class="text-center" style="${headingStyle()} margin-bottom: 1rem;">${esc(a('heading', 'Send us a message'))}</h2>
      ${a('intro') ? `<p class="text-center" style="color: var(--ada-muted); margin-bottom: 1.5rem;">${esc(a('intro'))}</p>` : ''}
      <form data-contact-form method="post" action="/api/contact" class="space-y-4 relative">
        <input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute; left:-9999px; width:1px; height:1px;">
        <label class="block text-sm" style="font-weight: 600;">Name<input name="name" required maxlength="100" autocomplete="name" class="${field}" style="${fs}"></label>
        <label class="block text-sm" style="font-weight: 600;">Email<input type="email" name="email" required maxlength="200" autocomplete="email" class="${field}" style="${fs}"></label>
        <label class="block text-sm" style="font-weight: 600;">Message<textarea name="message" required maxlength="4000" rows="5" class="${field}" style="${fs}"></textarea></label>
        <div class="cf-turnstile" data-sitekey="__ADA_TURNSTILE_SITEKEY__"></div>
        <button type="submit" class="w-full px-6 py-3 font-semibold" style="${buttonStyle('brand')}">${esc(a('button', 'Send'))}</button>
      </form></div>`);
    // Builder preview only (published pages carry no scripts).
    const f = this.querySelector('form');
    f.addEventListener('submit', (e) => { e.preventDefault(); if (window.showAppToast) window.showAppToast('This form works on the published page — messages arrive in your dashboard inbox.', 'info'); });
  }
}
customElements.define('ada-section-form', FormSection);
