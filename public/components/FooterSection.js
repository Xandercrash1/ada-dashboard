// Page Builder v2 phase 3 (fb-1790201502171): footer.
import { esc, safeHref, shell, lines } from './sectionUtils.js';
class FooterSection extends HTMLElement {
  static configSchema = [
    { attr: 'brand', label: 'Name / brand', type: 'text', default: '' },
    { attr: 'text', label: 'Small print', type: 'text', default: '' },
    { attr: 'links', label: 'Links — one per line: Label | URL', type: 'textarea', default: '' },
  ];
  static get observedAttributes() { return FooterSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const links = lines(a('links'), 12).map(l => { const [label, url = '#'] = l.split('|').map(s => s.trim()); return { label, href: safeHref(url) }; }).filter(l => l.label);
    const small = a('text') || `© ${new Date().getFullYear()}${a('brand') ? ' ' + a('brand') : ''}`;
    this.innerHTML = shell(`<div data-footer class="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4" style="font-size: calc(var(--ada-body) * .92);">
      <div>${a('brand') ? `<div data-edit="brand" style="font-family: var(--ada-font-heading); font-weight: 700; font-size: calc(var(--ada-body) * 1.15);">${esc(a('brand'))}</div>` : ''}<div style="color: var(--ada-muted);">${esc(small)}</div></div>
      ${links.length ? `<nav class="flex flex-wrap gap-x-5 gap-y-2">${links.map(l => `<a href="${esc(l.href)}" style="color: var(--ada-muted);" class="hover:underline">${esc(l.label)}</a>`).join('')}</nav>` : ''}
    </div>`).replace('padding: var(--ada-space) 1.5rem', 'padding: calc(var(--ada-space) * 0.5) 1.5rem');
  }
}
customElements.define('ada-section-footer', FooterSection);
