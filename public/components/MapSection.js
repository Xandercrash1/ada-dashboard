// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class MapSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading (optional)', type: 'text', default: 'Find us' },
    { attr: 'place', label: 'Address or place name', type: 'text', default: '' },
  ];
  static get observedAttributes() { return MapSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (MapSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    const place = a('place').trim().slice(0, 200);
    const src = place ? `https://www.google.com/maps?q=${encodeURIComponent(place)}&output=embed` : '';
    this.innerHTML = shell(`<div class="max-w-5xl mx-auto">${head}${src ? `<div data-map class="w-full overflow-hidden" style="aspect-ratio: 16 / 9; border-radius: calc(var(--ada-radius) * .75);"><iframe src="${esc(src)}" title="Map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" style="width: 100%; height: 100%; border: 0;"></iframe></div>`
      : `<div data-map class="w-full flex items-center justify-center" style="aspect-ratio: 16 / 9; border-radius: calc(var(--ada-radius) * .75); background: color-mix(in srgb, var(--ada-text) 8%, transparent); color: var(--ada-muted);"><span><i class="fa-solid fa-map-location-dot mr-2"></i>Add an address in the section editor</span></div>`}</div>`);
  }
}
customElements.define('ada-section-map', MapSection);
