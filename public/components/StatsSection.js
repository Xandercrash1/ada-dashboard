// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class StatsSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading (optional)', type: 'text', default: '' },
    { attr: 'items', label: 'One per line: Number | Label', type: 'textarea', default: '12 | Years baking\n40k | Loaves a year\n4.9★ | Average review' },
  ];
  static get observedAttributes() { return StatsSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (StatsSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 data-edit="heading" class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    const items = lines(a('items', def('items')), 6).map(l => { const [n, ...rest] = l.split('|'); return { n: n.trim(), l: rest.join('|').trim() }; }).filter(i => i.n);
    this.innerHTML = shell(`<div class="max-w-6xl mx-auto">${head}<div data-stats class="grid grid-cols-2 md:grid-cols-${Math.min(4, Math.max(2, items.length))} gap-8 text-center">${items.map(i => `
      <div><div style="font-family: var(--ada-font-heading); font-weight: 800; font-size: clamp(2rem, 6vw, calc(var(--ada-h1) * .9)); color: var(--ada-brand); line-height: 1.05;">${esc(i.n)}</div><div style="margin-top: .4rem; color: var(--ada-muted);">${esc(i.l)}</div></div>`).join('')}</div></div>`);
  }
}
customElements.define('ada-section-stats', StatsSection);
