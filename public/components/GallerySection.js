// Page Builder v2 phase 3 (fb-1790201502171): image gallery.
import { esc, safeSrc, shell, headingStyle, lines } from './sectionUtils.js';
class GallerySection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: '' },
    { attr: 'images', label: 'Images — one per line: URL | caption', type: 'textarea', default: '', upload: 'append' },
    { attr: 'columns', label: 'Columns (desktop)', type: 'select', options: [['2', '2'], ['3', '3'], ['4', '4']], default: '3' },
    { attr: 'aspect', label: 'Image shape', type: 'select', options: [['square', 'Square'], ['landscape', 'Landscape'], ['portrait', 'Portrait']], default: 'landscape' },
  ];
  static get observedAttributes() { return GallerySection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const imgs = lines(a('images'), 24).map(l => { const [u, ...c] = l.split('|'); return { src: safeSrc(u.trim()), caption: c.join('|').trim() }; }).filter(i => i.src);
    const cols = { '2': 'lg:grid-cols-2', '3': 'lg:grid-cols-3', '4': 'lg:grid-cols-4' }[a('columns', '3')] || 'lg:grid-cols-3';
    const ratio = { square: '1 / 1', landscape: '4 / 3', portrait: '3 / 4' }[a('aspect', 'landscape')] || '4 / 3';
    const h = a('heading');
    const body = imgs.length
      ? `<div data-gallery class="grid grid-cols-1 sm:grid-cols-2 ${cols} gap-4">${imgs.map(i => `
          <figure>
            <img src="${esc(i.src)}" alt="${esc(i.caption)}" loading="lazy" class="w-full object-cover" style="aspect-ratio: ${ratio}; border-radius: calc(var(--ada-radius) * 0.75); background: color-mix(in srgb, var(--ada-text) 8%, transparent);">
            ${i.caption ? `<figcaption style="color: var(--ada-muted); font-size: calc(var(--ada-body) * .9); margin-top: .5rem;">${esc(i.caption)}</figcaption>` : ''}
          </figure>`).join('')}</div>`
      : `<div data-gallery class="text-center py-10" style="color: var(--ada-muted);"><i class="fa-regular fa-images text-3xl"></i><p class="mt-2 text-sm">Add image URLs in the section editor.</p></div>`;
    this.innerHTML = shell(`<div class="max-w-6xl mx-auto">${h ? `<h2 data-edit="heading" class="text-center" style="${headingStyle()} margin-bottom: 2rem;">${esc(h)}</h2>` : ''}${body}</div>`);
  }
}
customElements.define('ada-section-gallery', GallerySection);
