class AdaCalendar extends HTMLElement {
  constructor() {
    super();
    this.events = [];
  }

  connectedCallback() {
    this.render();
    this.fetchEvents();
  }

  async fetchEvents() {
    try {
      const res = await fetch('/api/calendar/events');
      if (res.ok) {
        this.events = await res.json();
        this.render();
      }
    } catch (e) {}
  }

  static get observedAttributes() { return ['theme', 'accent']; }
  attributeChangedCallback() { this.render(); }

  render() {
    const theme = this.getAttribute('theme') || 'glass';
    const accent = this.getAttribute('accent') || 'indigo';

    const bgClass = theme === 'transparent' ? 'bg-transparent' : 
                   theme === 'solid' ? 'bg-dark-card border border-dark-border' :
                   theme === 'neon' ? `bg-dark-card border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/20` :
                   theme === 'gradient' ? `bg-gradient-to-br from-${accent}-900/40 to-dark-card border border-${accent}-500/30` :
                   `bg-dark-bg/60 backdrop-blur-xl border border-white/10`; // glass

    let html = `
      <div class="${bgClass} rounded-2xl p-4 flex flex-col h-full overflow-hidden relative group transition-all duration-300">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2 text-${accent}-400">
            <i class="fa-regular fa-calendar text-sm"></i>
            <span class="text-xs font-bold uppercase tracking-wider">Today's Agenda</span>
          </div>
          <span class="text-[10px] text-gray-500 font-semibold">${new Date().toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'})}</span>
        </div>
        <div class="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2">
    `;

    if (this.events.length === 0) {
      html += `
        <div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2 opacity-50 pt-4">
          <i class="fa-regular fa-calendar-check text-2xl"></i>
          <span class="text-xs">No upcoming events</span>
        </div>
      `;
    } else {
      this.events.forEach(e => {
        html += `
          <div class="flex items-start gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors">
            <div class="flex flex-col items-end min-w-[3rem] text-gray-400">
              <span class="text-xs font-bold text-white">${e.time}</span>
              <span class="text-[9px] uppercase tracking-wide">${e.ampm}</span>
            </div>
            <div class="w-0.5 h-full min-h-[2rem] bg-${accent}-500/30 rounded-full mt-0.5 flex-shrink-0"></div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-semibold text-gray-200 truncate">${e.title}</div>
              ${e.location ? `<div class="text-xs text-gray-500 truncate mt-0.5"><i class="fa-solid fa-location-dot mr-1"></i>${e.location}</div>` : ''}
            </div>
          </div>
        `;
      });
    }

    html += `</div></div>`;
    this.innerHTML = html;
  }
}

customElements.define('ada-calendar', AdaCalendar);
