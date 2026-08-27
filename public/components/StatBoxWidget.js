class StatBoxWidget extends HTMLElement {
  connectedCallback() { this.render(); }
  static get observedAttributes() { return ['stat', 'title', 'icon', 'accent']; }
  attributeChangedCallback() { this.render(); }
  
  render() {
    const stat = this.getAttribute('stat') || 'todo';
    const title = this.getAttribute('title') || 'Statistic';
    const icon = this.getAttribute('icon') || 'fa-chart-bar';
    const accent = this.getAttribute('accent') || 'indigo';
    
    this.innerHTML = `
      <div class="bg-dark-card border border-dark-border rounded-xl p-4 flex flex-col justify-between h-full">
        <div class="text-gray-400 text-xs font-semibold mb-2">${title}</div>
        <div class="text-2xl font-bold text-white flex items-end justify-between">
          <span data-home-stat="${stat}">--</span>
          <i class="fa-solid ${icon} text-${accent}-500/50 text-xl"></i>
        </div>
      </div>
    `;
  }
}
customElements.define('ada-stat-box', StatBoxWidget);
