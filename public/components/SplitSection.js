// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class SplitSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Made by hand, every morning' },
    { attr: 'body', label: 'Text — blank line = new paragraph; **bold**, *italic*, [link](https://…)', type: 'textarea', default: 'Tell your story here.' },
    { attr: 'image', label: 'Image', type: 'image', default: '' },
    { attr: 'image-alt', label: 'Image description (for screen readers)', type: 'text', default: '' },
    { attr: 'side', label: 'Image side', type: 'select', options: [['left', 'Left'], ['right', 'Right']], default: 'left' },
    { attr: 'cta-label', label: 'Button label', type: 'text', default: '' },
    { attr: 'cta-href', label: 'Button link', type: 'text', default: '#' },
  ];
  static get observedAttributes() { return SplitSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (SplitSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const img = safeSrc(a('image'));
    const paras = String(a('body', def('body'))).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).slice(0, 12);
    const media = img ? `<img src="${esc(img)}" alt="${esc(a('image-alt'))}" loading="lazy" class="w-full object-cover" style="aspect-ratio: 4 / 3; border-radius: calc(var(--ada-radius) * .75);">`
      : `<div class="w-full flex items-center justify-center" style="aspect-ratio: 4 / 3; border-radius: calc(var(--ada-radius) * .75); background: color-mix(in srgb, var(--ada-text) 8%, transparent); color: var(--ada-muted);"><i class="fa-regular fa-image text-3xl"></i></div>`;
    const text = `<div><h2 style="${headingStyle()}">${esc(a('heading', def('heading')))}</h2>${paras.map(p => `<p style="margin-top: 1rem; line-height: 1.7; font-size: calc(var(--ada-body) * 1.05);">${miniMarkdown(p)}</p>`).join('')}
      ${a('cta-label') ? `<a href="${esc(safeHref(a('cta-href', '#')))}" class="inline-block px-6 py-3 font-semibold" style="margin-top: 1.5rem; ${buttonStyle('brand')}">${esc(a('cta-label'))}</a>` : ''}</div>`;
    const right = a('side', 'left') === 'right';
    this.innerHTML = shell(`<div data-split class="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-10 items-center">${right ? text + media : media + text}</div>`);
  }
}
customElements.define('ada-section-split', SplitSection);
