// Page Builder v2 phase 3 (fb-1790201502171): call to action band.
import { esc, safeHref, shell, headingStyle, buttonStyle } from './sectionUtils.js';
class CtaSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Ready to get started?' },
    { attr: 'text', label: 'Text', type: 'textarea', default: '' },
    { attr: 'cta-label', label: 'Button label', type: 'text', default: 'Get started' },
    { attr: 'cta-href', label: 'Button link', type: 'text', default: '#' },
    { attr: 'secondary-label', label: 'Second button label', type: 'text', default: '' },
    { attr: 'secondary-href', label: 'Second button link', type: 'text', default: '#' },
    { attr: 'tone', label: 'Background', type: 'select', options: [['brand', 'Brand colour'], ['surface', 'Page surface']], default: 'brand' },
  ];
  static get observedAttributes() { return CtaSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const tone = a('tone', 'brand') === 'surface' ? 'surface' : 'brand';
    const text = a('text'), l1 = a('cta-label', 'Get started'), l2 = a('secondary-label');
    this.innerHTML = shell(`<div class="max-w-3xl mx-auto text-center">
      <h2 data-edit="heading" style="${headingStyle()}">${esc(a('heading', 'Ready to get started?'))}</h2>
      ${text ? `<p data-edit="text" style="opacity: .85; margin-top: .75rem; font-size: calc(var(--ada-body) * 1.1);">${esc(text)}</p>` : ''}
      <div class="flex flex-wrap justify-center gap-3" style="margin-top: 1.75rem;">
        ${l1 ? `<a href="${esc(safeHref(a('cta-href', '#')))}" class="px-6 py-3 font-semibold" style="${buttonStyle(tone === 'brand' ? 'light' : 'brand')}">${esc(l1)}</a>` : ''}
        ${l2 ? `<a href="${esc(safeHref(a('secondary-href', '#')))}" class="px-6 py-3 font-semibold" style="${buttonStyle('ghost')}">${esc(l2)}</a>` : ''}
      </div></div>`, tone);
  }
}
customElements.define('ada-section-cta', CtaSection);
