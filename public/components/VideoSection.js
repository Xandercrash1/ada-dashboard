// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class VideoSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading (optional)', type: 'text', default: '' },
    { attr: 'url', label: 'YouTube or Vimeo link', type: 'text', default: '' },
    { attr: 'caption', label: 'Caption', type: 'text', default: '' },
  ];
  static get observedAttributes() { return VideoSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (VideoSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    // Only an ID parsed from the link is used, never the link itself, and
    // only these two players — so nothing else can be framed.
    const u = a('url');
    const yt = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/.exec(u);
    const vm = /vimeo\.com\/(?:video\/)?(\d{4,12})/.exec(u);
    const src = yt ? `https://www.youtube-nocookie.com/embed/${yt[1]}` : vm ? `https://player.vimeo.com/video/${vm[1]}` : '';
    this.innerHTML = shell(`<div class="max-w-4xl mx-auto">${head}${src ? `<div data-video class="w-full overflow-hidden" style="aspect-ratio: 16 / 9; border-radius: calc(var(--ada-radius) * .75); background: #000;"><iframe src="${src}" title="${esc(a('caption') || 'Video')}" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" style="width: 100%; height: 100%; border: 0;"></iframe></div>`
      : `<div data-video class="w-full flex items-center justify-center" style="aspect-ratio: 16 / 9; border-radius: calc(var(--ada-radius) * .75); background: color-mix(in srgb, var(--ada-text) 8%, transparent); color: var(--ada-muted);"><span><i class="fa-brands fa-youtube mr-2"></i>Paste a YouTube or Vimeo link in the section editor</span></div>`}
      ${a('caption') ? `<p class="text-center" style="margin-top: .8rem; color: var(--ada-muted);">${esc(a('caption'))}</p>` : ''}</div>`);
  }
}
customElements.define('ada-section-video', VideoSection);
