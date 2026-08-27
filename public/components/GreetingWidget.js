class GreetingWidget extends HTMLElement {
  connectedCallback() { this.render(); }
  static get observedAttributes() { return ['name']; }
  attributeChangedCallback() { this.render(); }
  
  render() {
    const theme = this.getAttribute('theme') || 'transparent';
    let bgClass = '';
    if (theme === 'glass') bgClass = 'bg-white/5 dark:bg-black/20 backdrop-blur-md border border-white/10 dark:border-white/5 shadow-lg';
    else if (theme === 'solid') bgClass = 'bg-dark-card border border-dark-border';
    else bgClass = '';

    const name = this.getAttribute('name') || 'Alex';
    const hour = new Date().getHours();
    let greeting = 'Good evening';
    let icon = 'fa-moon';
    let color = 'indigo';
    if (hour < 12) { greeting = 'Good morning'; icon = 'fa-sun'; color = 'amber'; }
    else if (hour < 18) { greeting = 'Good afternoon'; icon = 'fa-cloud-sun'; color = 'sky'; }

    this.innerHTML = `
      <div class="${bgClass} rounded-xl p-4 flex items-center gap-4 h-full">
        <div class="w-12 h-12 rounded-full bg-${color}-500/20 text-${color}-400 flex items-center justify-center text-2xl">
          <i class="fa-solid ${icon}"></i>
        </div>
        <div>
          <div class="text-gray-400 text-xs font-semibold uppercase tracking-wider">${greeting}</div>
          <div class="text-xl font-bold text-white">${name}!</div>
        </div>
      </div>
    `;
  }
}
customElements.define('ada-greeting', GreetingWidget);
