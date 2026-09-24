// Page Builder v2 phase 3 (fb-1790201502171): pricing plans.
import { esc, safeHref, shell, headingStyle, buttonStyle, lines } from './sectionUtils.js';
class PricingSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Pricing' },
    { attr: 'subheading', label: 'Subheading', type: 'textarea', default: '' },
    { attr: 'plans', label: 'Plans — one per line: Name | Price | feature; feature | Button | link   (start the name with * to highlight)', type: 'textarea',
      default: 'Starter | $0 | 1 project; Community support | Start free | #\n*Pro | $12/mo | Unlimited projects; Priority support; Custom domain | Go Pro | #\nTeam | $39/mo | Everything in Pro; 5 seats | Contact us | #' },
  ];
  static get observedAttributes() { return PricingSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const plans = lines(a('plans', PricingSection.configSchema[2].default), 6).map(l => {
      const [name = '', price = '', feats = '', btn = '', href = ''] = l.split('|').map(s => s.trim());
      return { featured: name.startsWith('*'), name: name.replace(/^\*/, '').trim(), price, feats: feats.split(';').map(s => s.trim()).filter(Boolean), btn, href: safeHref(href || '#') };
    });
    const cols = plans.length >= 3 ? 'lg:grid-cols-3' : plans.length === 2 ? 'lg:grid-cols-2' : '';
    const sub = a('subheading');
    this.innerHTML = shell(`<div class="max-w-6xl mx-auto">
      <div class="text-center" style="margin-bottom: 2.5rem;"><h2 data-edit="heading" style="${headingStyle()}">${esc(a('heading', 'Pricing'))}</h2>${sub ? `<p data-edit="subheading" style="color: var(--ada-muted); margin-top: .75rem;">${esc(sub)}</p>` : ''}</div>
      <div data-pricing class="grid grid-cols-1 sm:grid-cols-2 ${cols} gap-5 items-stretch">${plans.map(p => `
        <div class="flex flex-col p-6" style="border-radius: calc(var(--ada-radius) * 0.75); ${p.featured ? 'border: 2px solid var(--ada-brand); background: color-mix(in srgb, var(--ada-brand) 10%, transparent);' : 'border: 1px solid color-mix(in srgb, var(--ada-text) 12%, transparent); background: color-mix(in srgb, var(--ada-text) 4%, transparent);'}">
          ${p.featured ? `<span class="self-start text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 mb-3" style="background: var(--ada-brand); color: var(--ada-on-brand, #fff); border-radius: 999px;">Popular</span>` : ''}
          <h3 style="font-family: var(--ada-font-heading); font-weight: 700; font-size: calc(var(--ada-body) * 1.2);">${esc(p.name)}</h3>
          <div data-price style="font-family: var(--ada-font-heading); font-size: calc(var(--ada-h2) * .95); font-weight: 800; margin: .5rem 0 1rem;">${esc(p.price)}</div>
          <ul class="space-y-2 flex-1" style="font-size: var(--ada-body);">${p.feats.map(f => `<li class="flex gap-2"><i class="fa-solid fa-check mt-1" style="color: var(--ada-brand);"></i><span>${esc(f)}</span></li>`).join('')}</ul>
          ${p.btn ? `<a href="${esc(p.href)}" class="mt-6 text-center px-5 py-2.5 font-semibold" style="${buttonStyle(p.featured ? 'brand' : 'ghost')}">${esc(p.btn)}</a>` : ''}
        </div>`).join('')}</div></div>`);
  }
}
customElements.define('ada-section-pricing', PricingSection);
