// Page Builder v2 phase 8 (fb-1790206467677): site header / navigation.
// The phone menu is a <details> element — it opens without JavaScript, so it
// keeps working in published pages (which carry no scripts).
import { esc, safeHref, safeSrc, lines, buttonStyle } from './sectionUtils.js';
class HeaderSection extends HTMLElement {
  static configSchema = [
    { attr: 'brand', label: 'Name / brand', type: 'text', default: 'Your name' },
    { attr: 'logo', label: 'Logo image', type: 'image', default: '' },
    { attr: 'links', label: 'Menu — one per line: Label | #section-anchor or URL', type: 'textarea', default: 'About | #about\nServices | #services\nContact | #contact' },
    { attr: 'cta-label', label: 'Button label', type: 'text', default: '' },
    { attr: 'cta-href', label: 'Button link', type: 'text', default: '#contact' },
    { attr: 'sticky', label: 'Stay at the top when scrolling', type: 'select', options: [['no', 'No'], ['yes', 'Yes']], default: 'no' },
  ];
  static get observedAttributes() { return HeaderSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const links = lines(a('links', HeaderSection.configSchema[2].default), 8).map(l => { const [label, url = '#'] = l.split('|').map(x => x.trim()); return { label, href: safeHref(url) }; }).filter(l => l.label);
    const logo = safeSrc(a('logo'));
    const cta = a('cta-label');
    const sticky = a('sticky', 'no') === 'yes';
    this.style.cssText = sticky ? 'position: sticky; top: 0; z-index: 40;' : '';
    const linkHtml = (cls) => links.map(l => `<a href="${esc(l.href)}" class="${cls}" style="color: var(--ada-text);">${esc(l.label)}</a>`).join('');
    this.innerHTML = `
      <header data-header class="w-full" style="background: var(--ada-surface); color: var(--ada-text); border-radius: var(--ada-sec-radius, var(--ada-radius)); padding: .9rem 1.5rem; font-family: var(--ada-font-body);">
        <div class="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <a href="#" class="flex items-center gap-3 min-w-0" style="color: var(--ada-text);">
            ${logo ? `<img src="${esc(logo)}" alt="${esc(a('brand', ''))}" class="h-9 w-auto" style="max-width: 140px; object-fit: contain;">` : ''}
            <span class="truncate" style="font-family: var(--ada-font-heading); font-weight: 800; font-size: calc(var(--ada-body) * 1.2);">${esc(a('brand', 'Your name'))}</span>
          </a>
          <nav class="hidden md:flex items-center gap-7" style="font-size: calc(var(--ada-body) * .95);">
            ${linkHtml('hover:opacity-70')}
            ${cta ? `<a href="${esc(safeHref(a('cta-href', '#contact')))}" class="px-4 py-2 font-semibold" style="${buttonStyle('brand')}">${esc(cta)}</a>` : ''}
          </nav>
          <details class="md:hidden relative">
            <summary class="list-none cursor-pointer p-2" aria-label="Menu" style="color: var(--ada-text);"><i class="fa-solid fa-bars text-lg"></i></summary>
            <div class="absolute right-0 mt-2 w-56 p-2 flex flex-col shadow-xl" style="background: var(--ada-surface); border: 1px solid color-mix(in srgb, var(--ada-text) 12%, transparent); border-radius: calc(var(--ada-radius) * .75); z-index: 50;">
              ${linkHtml('px-3 py-2 rounded-lg')}
              ${cta ? `<a href="${esc(safeHref(a('cta-href', '#contact')))}" class="mt-1 px-3 py-2 text-center font-semibold" style="${buttonStyle('brand')}">${esc(cta)}</a>` : ''}
            </div>
          </details>
        </div>
      </header>`;
  }
}
customElements.define('ada-section-header', HeaderSection);
