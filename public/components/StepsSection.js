// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class StepsSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'How it works' },
    { attr: 'items', label: 'One per line: Title | Text', type: 'textarea', default: 'Choose | Pick your box online.\nWe bake | Fresh the same morning.\nEnjoy | Collect or get it delivered.' },
  ];
  static get observedAttributes() { return StepsSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (StepsSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 data-edit="heading" class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    const items = lines(a('items', def('items')), 8).map(l => { const [t, ...rest] = l.split('|'); return { t: t.trim(), x: rest.join('|').trim() }; }).filter(i => i.t);
    this.innerHTML = shell(`<div class="max-w-6xl mx-auto">${head}<ol data-steps class="grid grid-cols-1 md:grid-cols-${Math.min(4, Math.max(2, items.length))} gap-8">${items.map((i, n) => `
      <li><div class="w-11 h-11 flex items-center justify-center font-bold" style="border-radius: 999px; background: var(--ada-brand); color: var(--ada-on-brand, #fff); font-family: var(--ada-font-heading);">${n + 1}</div>
        <div style="margin-top: .9rem; font-weight: 700; font-size: calc(var(--ada-body) * 1.1);">${esc(i.t)}</div><div style="margin-top: .3rem; color: var(--ada-muted); line-height: 1.6;">${esc(i.x)}</div></li>`).join('')}</ol></div>`);
  }
}
customElements.define('ada-section-steps', StepsSection);
