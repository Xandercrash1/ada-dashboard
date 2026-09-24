// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class ContactSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Get in touch' },
    { attr: 'text', label: 'Intro text', type: 'textarea', default: '' },
    { attr: 'email', label: 'Email', type: 'text', default: '' },
    { attr: 'phone', label: 'Phone', type: 'text', default: '' },
    { attr: 'address', label: 'Address', type: 'textarea', default: '' },
    { attr: 'hours', label: 'Opening hours — one per line', type: 'textarea', default: '' },
  ];
  static get observedAttributes() { return ContactSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (ContactSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    const email = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}$/.test(a('email').trim()) ? a('email').trim() : '';
    const phone = a('phone').trim().replace(/[^0-9+()\-. ]/g, '').slice(0, 30);
    const card = (icon, title, body) => `<div class="p-6" style="background: color-mix(in srgb, var(--ada-text) 5%, transparent); border: 1px solid color-mix(in srgb, var(--ada-text) 10%, transparent); border-radius: calc(var(--ada-radius) * .75);"><i class="fa-solid ${icon} text-xl" style="color: var(--ada-brand);"></i><div style="margin-top: .7rem; font-weight: 700;">${title}</div><div style="margin-top: .3rem; color: var(--ada-muted); line-height: 1.6;">${body}</div></div>`;
    const cards = [
      email && card('fa-envelope', 'Email', `<a href="mailto:${esc(email)}" style="color: var(--ada-brand);">${esc(email)}</a>`),
      phone && card('fa-phone', 'Phone', `<a href="tel:${esc(phone.replace(/[^0-9+]/g, ''))}" style="color: var(--ada-brand);">${esc(phone)}</a>`),
      a('address').trim() && card('fa-location-dot', 'Address', esc(a('address').trim()).replace(/\n/g, '<br>')),
      a('hours').trim() && card('fa-clock', 'Hours', lines(a('hours'), 10).map(esc).join('<br>'))
    ].filter(Boolean);
    this.innerHTML = shell(`<div class="max-w-5xl mx-auto">${head}${a('text') ? `<p class="text-center" style="margin: -1rem auto 2rem; max-width: 40rem; color: var(--ada-muted);">${esc(a('text'))}</p>` : ''}<div data-contact class="grid grid-cols-1 sm:grid-cols-2 gap-5">${cards.join('') || `<p style="color: var(--ada-muted);">Add your details in the section editor.</p>`}</div></div>`);
  }
}
customElements.define('ada-section-contact', ContactSection);
