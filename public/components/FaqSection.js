// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class FaqSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Questions' },
    { attr: 'items', label: 'One per line: Question | Answer', type: 'textarea', default: 'Do you deliver? | Yes, within 5 miles, every morning.\nCan I pre-order? | Order by 6pm for the next day.' },
  ];
  static get observedAttributes() { return FaqSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (FaqSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 data-edit="heading" class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    const items = lines(a('items', def('items')), 20).map(l => { const [q, ...rest] = l.split('|'); return { q: q.trim(), ans: rest.join('|').trim() }; }).filter(i => i.q);
    // <details> = an accordion that needs no JavaScript (published pages have none).
    this.innerHTML = shell(`<div class="max-w-3xl mx-auto">${head}<div data-faq class="space-y-3">${items.map(i => `
      <details class="group p-5" style="background: color-mix(in srgb, var(--ada-text) 5%, transparent); border: 1px solid color-mix(in srgb, var(--ada-text) 10%, transparent); border-radius: calc(var(--ada-radius) * .6);">
        <summary class="list-none cursor-pointer flex items-center justify-between gap-4" style="font-weight: 700; font-size: calc(var(--ada-body) * 1.05);">${esc(i.q)}<i class="fa-solid fa-plus text-sm transition-transform group-open:rotate-45" style="color: var(--ada-brand);"></i></summary>
        <div style="margin-top: .75rem; color: var(--ada-muted); line-height: 1.65;">${miniMarkdown(i.ans)}</div>
      </details>`).join('')}</div></div>`);
  }
}
customElements.define('ada-section-faq', FaqSection);
