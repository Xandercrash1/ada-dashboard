// Page Builder v2 (fb-1790201502141): hero section. Reads the page's design
// tokens as CSS custom properties (--ada-*) set on the page root, so a token
// change restyles it without touching the markup. All text is escaped; links
// and images are limited to http(s), site-relative and mailto/# targets.
import { esc, safeHref, safeSrc } from './sectionUtils.js';

class HeroSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Your headline here' },
    { attr: 'subheading', label: 'Subheading', type: 'textarea', default: '' },
    { attr: 'cta-label', label: 'Button label', type: 'text', default: '' },
    { attr: 'cta-href', label: 'Button link', type: 'text', default: '#' },
    { attr: 'align', label: 'Alignment', type: 'select', options: [['center', 'Centered'], ['left', 'Left']], default: 'center' },
    { attr: 'image', label: 'Background image URL', type: 'text', default: '' },
  ];
  static get observedAttributes() { return HeroSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const heading = a('heading', 'Your headline here');
    const sub = a('subheading');
    const label = a('cta-label');
    const align = a('align', 'center') === 'left' ? 'left' : 'center';
    const img = safeSrc(a('image'));
    const bg = img
      ? `background-image: linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url('${esc(img)}'); background-size: cover; background-position: center;`
      : 'background: var(--ada-surface);';
    this.innerHTML = `
      <section class="w-full overflow-hidden" style="${bg} color: var(--ada-text); border-radius: var(--ada-radius); padding: var(--ada-space) 1.5rem; font-family: var(--ada-font-body);">
        <div class="max-w-4xl ${align === 'center' ? 'mx-auto text-center' : 'text-left'}">
          <h1 data-hero-heading style="font-family: var(--ada-font-heading); font-size: clamp(1.75rem, 6vw, var(--ada-h1)); line-height: 1.1; font-weight: 800; letter-spacing: -0.02em;">${esc(heading)}</h1>
          ${sub ? `<p style="color: var(--ada-muted); font-size: calc(var(--ada-body) * 1.15); line-height: 1.6; margin-top: 1rem;">${esc(sub)}</p>` : ''}
          ${label ? `<a href="${esc(safeHref(a('cta-href', '#')))}" class="inline-block px-6 py-3 font-semibold" style="margin-top: 1.75rem; background: var(--ada-brand); color: var(--ada-on-brand, #ffffff); border-radius: calc(var(--ada-radius) * 0.6);">${esc(label)}</a>` : ''}
        </div>
      </section>`;
  }
}
customElements.define('ada-section-hero', HeroSection);
