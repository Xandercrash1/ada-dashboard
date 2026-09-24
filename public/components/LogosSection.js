// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class LogosSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading (optional)', type: 'text', default: 'As featured in' },
    { attr: 'logos', label: 'One per line: logo image URL | name', type: 'textarea', default: '', upload: 'append' },
  ];
  static get observedAttributes() { return LogosSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (LogosSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading'));
    const logos = lines(a('logos'), 12).map(l => { const [u, ...n] = l.split('|'); return { src: safeSrc(u.trim()), name: n.join('|').trim() }; }).filter(x => x.src || x.name);
    this.innerHTML = shell(`<div class="max-w-6xl mx-auto text-center">${h ? `<div style="color: var(--ada-muted); text-transform: uppercase; letter-spacing: .12em; font-size: calc(var(--ada-body) * .8); font-weight: 700; margin-bottom: 1.5rem;">${esc(h)}</div>` : ''}
      <div data-logos class="flex flex-wrap items-center justify-center gap-x-10 gap-y-6">${logos.map(x => x.src ? `<img src="${esc(x.src)}" alt="${esc(x.name)}" loading="lazy" class="h-10 w-auto" style="max-width: 160px; object-fit: contain; filter: grayscale(1); opacity: .75;">` : `<span style="font-family: var(--ada-font-heading); font-weight: 800; font-size: calc(var(--ada-body) * 1.3); opacity: .7;">${esc(x.name)}</span>`).join('') || `<span style="color: var(--ada-muted);">Add logos in the section editor.</span>`}</div></div>`).replace('padding: var(--ada-space) 1.5rem', 'padding: calc(var(--ada-space) * .6) 1.5rem');
  }
}
customElements.define('ada-section-logos', LogosSection);
