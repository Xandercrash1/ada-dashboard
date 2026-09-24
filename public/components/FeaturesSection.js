// Page Builder v2 (fb-1790201502141): features section — a heading and a grid
// of cards. `items` is one card per line: "fa-icon | Title | Text" (icon
// optional: "Title | Text"). Escaped throughout; styled by the page tokens.
import { esc } from './sectionUtils.js';

class FeaturesSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'Features' },
    { attr: 'subheading', label: 'Subheading', type: 'textarea', default: '' },
    { attr: 'items', label: 'Cards — one per line: fa-icon | Title | Text', type: 'textarea', default: 'fa-bolt | Fast | Loads in a blink.\nfa-shield-halved | Safe | Private by default.\nfa-heart | Friendly | Made for people.' },
    { attr: 'columns', label: 'Columns (desktop)', type: 'select', options: [['2', '2'], ['3', '3'], ['4', '4']], default: '3' },
  ];
  static get observedAttributes() { return FeaturesSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  static parseItems(text) {
    return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12).map(line => {
      const parts = line.split('|').map(p => p.trim());
      const icon = /^fa-[a-z0-9-]+$/.test(parts[0]) ? parts.shift() : '';
      return { icon, title: parts[0] || '', text: parts.slice(1).join(' | ') };
    });
  }

  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const items = FeaturesSection.parseItems(a('items', FeaturesSection.configSchema[2].default));
    const cols = { '2': 'lg:grid-cols-2', '3': 'lg:grid-cols-3', '4': 'lg:grid-cols-4' }[a('columns', '3')] || 'lg:grid-cols-3';
    const sub = a('subheading');
    this.innerHTML = `
      <section class="w-full" style="background: var(--ada-surface); color: var(--ada-text); border-radius: var(--ada-sec-radius, var(--ada-radius)); padding: var(--ada-space) 1.5rem; font-family: var(--ada-font-body);">
        <div class="max-w-6xl mx-auto">
          <div class="text-center" style="margin-bottom: 2.5rem;">
            <h2 data-edit="heading" style="font-family: var(--ada-font-heading); font-size: clamp(1.5rem, 4.5vw, var(--ada-h2)); line-height: 1.15; font-weight: 750;">${esc(a('heading', 'Features'))}</h2>
            ${sub ? `<p data-edit="subheading" style="color: var(--ada-muted); margin-top: .75rem; font-size: var(--ada-body);">${esc(sub)}</p>` : ''}
          </div>
          <div data-feature-grid class="grid grid-cols-1 sm:grid-cols-2 ${cols} gap-5">
            ${items.map(it => `
              <div class="p-6" style="background: color-mix(in srgb, var(--ada-text) 5%, transparent); border: 1px solid color-mix(in srgb, var(--ada-text) 10%, transparent); border-radius: calc(var(--ada-radius) * 0.75);">
                ${it.icon ? `<i class="fa-solid ${esc(it.icon)} text-xl" style="color: var(--ada-brand);"></i>` : ''}
                <h3 style="font-family: var(--ada-font-heading); font-weight: 700; font-size: calc(var(--ada-body) * 1.15); margin-top: ${it.icon ? '.9rem' : '0'};">${esc(it.title)}</h3>
                ${it.text ? `<p style="color: var(--ada-muted); margin-top: .4rem; font-size: var(--ada-body); line-height: 1.55;">${esc(it.text)}</p>` : ''}
              </div>`).join('')}
          </div>
        </div>
      </section>`;
  }
}
customElements.define('ada-section-features', FeaturesSection);
