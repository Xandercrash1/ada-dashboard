// Page Builder v2 phase 3 (fb-1790201502171): rich-ish text block.
import { esc, shell, headingStyle, miniMarkdown } from './sectionUtils.js';
class TextSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: '' },
    { attr: 'body', label: 'Text — blank line = new paragraph; **bold**, *italic*, [link](https://…)', type: 'textarea', default: 'Write something here.' },
    { attr: 'align', label: 'Alignment', type: 'select', options: [['left', 'Left'], ['center', 'Centered']], default: 'left' },
    { attr: 'width', label: 'Width', type: 'select', options: [['narrow', 'Narrow (reading)'], ['wide', 'Wide']], default: 'narrow' },
  ];
  static get observedAttributes() { return TextSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const paras = String(a('body', 'Write something here.')).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).slice(0, 40);
    const h = a('heading');
    this.innerHTML = shell(`<div data-text class="${a('width', 'narrow') === 'wide' ? 'max-w-5xl' : 'max-w-2xl'} mx-auto ${a('align', 'left') === 'center' ? 'text-center' : ''}">
      ${h ? `<h2 style="${headingStyle()} margin-bottom: 1.25rem;">${esc(h)}</h2>` : ''}
      ${paras.map(p => `<p style="font-size: calc(var(--ada-body) * 1.05); line-height: 1.75; margin-top: .9rem; color: var(--ada-text);">${miniMarkdown(p).replace(/\n/g, '<br>')}</p>`).join('')}
    </div>`);
  }
}
customElements.define('ada-section-text', TextSection);
