// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class TestimonialsSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'What people say' },
    { attr: 'items', label: 'One per line: Quote | Name | Role', type: 'textarea', default: 'The best croissant in town. | Sam R. | Regular since 2021\nWarm, friendly, always fresh. | Priya K. | Neighbour' },
    { attr: 'columns', label: 'Columns (desktop)', type: 'select', options: [['2', '2'], ['3', '3']], default: '2' },
  ];
  static get observedAttributes() { return TestimonialsSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (TestimonialsSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    const items = lines(a('items', def('items')), 9).map(l => { const [q, n = '', r = ''] = l.split('|').map(s => s.trim()); return { q, n, r }; }).filter(i => i.q);
    const cols = a('columns', '2') === '3' ? 'lg:grid-cols-3' : 'lg:grid-cols-2';
    this.innerHTML = shell(`<div class="max-w-6xl mx-auto">${head}<div data-testimonials class="grid grid-cols-1 md:grid-cols-2 ${cols} gap-5">${items.map(i => `
      <figure class="p-6 flex flex-col" style="background: color-mix(in srgb, var(--ada-text) 5%, transparent); border: 1px solid color-mix(in srgb, var(--ada-text) 10%, transparent); border-radius: calc(var(--ada-radius) * .75);">
        <i class="fa-solid fa-quote-left text-2xl" style="color: var(--ada-brand);"></i>
        <blockquote style="margin: .9rem 0 1.2rem; font-size: calc(var(--ada-body) * 1.1); line-height: 1.6;">${esc(i.q)}</blockquote>
        <figcaption class="mt-auto"><div style="font-weight: 700;">${esc(i.n)}</div>${i.r ? `<div style="color: var(--ada-muted); font-size: calc(var(--ada-body) * .9);">${esc(i.r)}</div>` : ''}</figcaption>
      </figure>`).join('')}</div></div>`);
  }
}
customElements.define('ada-section-testimonials', TestimonialsSection);
