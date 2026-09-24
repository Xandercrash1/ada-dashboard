// Page Builder v2 phase 9 (fb-1790206467703).
import { esc, safeHref, safeSrc, shell, headingStyle, buttonStyle, lines, miniMarkdown } from './sectionUtils.js';
class TeamSection extends HTMLElement {
  static configSchema = [
    { attr: 'heading', label: 'Heading', type: 'text', default: 'The team' },
    { attr: 'members', label: 'One per line: photo URL (optional) | Name | Role', type: 'textarea', default: ' | Alex | Founder\n | Jordan | Head baker', upload: 'append' },
  ];
  static get observedAttributes() { return TeamSection.configSchema.map(f => f.attr); }
  connectedCallback() { this.classList.add('block', 'w-full'); this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const a = (k, d = '') => this.getAttribute(k) ?? d;
    const def = (k) => (TeamSection.configSchema.find(f => f.attr === k) || {}).default || '';
    const h = a('heading', def('heading')); const head = h ? `<h2 data-edit="heading" class="text-center" style="${headingStyle()} margin-bottom: 2.25rem;">${esc(h)}</h2>` : '';
    const people = lines(a('members', def('members')), 16).map(l => { const p = l.split('|').map(s => s.trim()); return { img: safeSrc(p[0]), name: p[1] || '', role: p[2] || '' }; }).filter(x => x.name || x.img);
    this.innerHTML = shell(`<div class="max-w-6xl mx-auto">${head}<div data-team class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">${people.map(x => `
      <div class="text-center">
        ${x.img ? `<img src="${esc(x.img)}" alt="${esc(x.name)}" loading="lazy" class="w-28 h-28 mx-auto object-cover" style="border-radius: 999px;">` : `<div class="w-28 h-28 mx-auto flex items-center justify-center text-3xl font-bold" style="border-radius: 999px; background: color-mix(in srgb, var(--ada-brand) 20%, transparent); color: var(--ada-brand); font-family: var(--ada-font-heading);">${esc((x.name || '?').trim().charAt(0).toUpperCase())}</div>`}
        <div style="margin-top: .9rem; font-weight: 700;">${esc(x.name)}</div><div style="color: var(--ada-muted); font-size: calc(var(--ada-body) * .9);">${esc(x.role)}</div>
      </div>`).join('')}</div></div>`);
  }
}
customElements.define('ada-section-team', TeamSection);
