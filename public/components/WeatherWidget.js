class WeatherWidget extends HTMLElement {
  constructor() {
    super();
    this.weather = null;
    this.loading = true;
    this.error = null;
  }

  connectedCallback() {
    this.classList.add("block", "w-full", "h-full");
    this.render();
    this.fetchWeather();
    this._poll = setInterval(() => this.fetchWeather(), 15 * 60 * 1000);
  }
  
  disconnectedCallback() { clearInterval(this._poll); }
  static get observedAttributes() { return ['theme', 'accent']; }
  attributeChangedCallback() { this.render(); }

  async fetchWeather() {
    this.loading = true;
    this.render();
    try {
      const res = await fetch('/api/weather');
      if (res.ok) {
        this.weather = await res.json();
        this.error = null;
      } else {
        this.error = "Failed to load";
      }
    } catch(e) {
      this.error = "Offline";
    }
    this.loading = false;
    this.render();
  }

  getWeatherIcon(condition) {
    const c = condition.toLowerCase();
    if (c.includes('rain') || c.includes('drizzle')) return 'fa-cloud-rain';
    if (c.includes('snow') || c.includes('ice') || c.includes('blizzard')) return 'fa-snowflake';
    if (c.includes('storm') || c.includes('thunder')) return 'fa-cloud-bolt';
    if (c.includes('fog') || c.includes('mist')) return 'fa-smog';
    if (c.includes('clear') || c.includes('sun')) return 'fa-sun';
    if (c.includes('partly')) return 'fa-cloud-sun';
    if (c.includes('cloud') || c.includes('overcast')) return 'fa-cloud';
    return 'fa-temperature-half';
  }

  render() {
    const theme = this.getAttribute('theme') || 'glass';
    const accent = this.getAttribute('accent') || 'indigo';

    const bgClass = theme === 'transparent' ? 'bg-transparent' : 
                   theme === 'solid' ? 'bg-white dark:bg-dark-card border border-gray-200 dark:border-dark-border' :
                   theme === 'neon' ? `bg-white dark:bg-dark-card border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/20` :
                   theme === 'gradient' ? `bg-gradient-to-br from-${accent}-50/90 to-white dark:from-${accent}-900/40 dark:to-dark-card border border-${accent}-200 dark:border-${accent}-500/30` :
                   `bg-gray-50/80 dark:bg-dark-bg/60 backdrop-blur-xl border border-gray-200 dark:border-dark-border shadow-sm`; 

    let content = '';
    
    if (this.loading && !this.weather) {
       content = `<div class="flex-1 flex items-center justify-center text-gray-500 opacity-60"><i class="fa-solid fa-circle-notch fa-spin text-xl"></i></div>`;
    } else if (this.error) {
       content = `<div class="flex-1 flex flex-col items-center justify-center text-rose-500 opacity-70 text-xs"><i class="fa-solid fa-triangle-exclamation text-xl mb-1"></i>${this.error}</div>`;
    } else if (this.weather) {
       const iconClass = this.getWeatherIcon(this.weather.condition);
       content = `
         <div class="flex-1 flex flex-col items-center justify-center relative">
            <div class="flex items-center justify-center gap-5">
              <i class="fa-solid ${iconClass} text-5xl text-${accent}-500 dark:text-${accent}-400 filter drop-shadow-md"></i>
              <div class="flex flex-col items-start">
                 <span class="text-5xl font-extrabold text-gray-900 dark:text-white tracking-tighter">${this.weather.temp_f}°</span>
              </div>
            </div>
            <div class="mt-4 text-sm font-semibold text-gray-700 dark:text-gray-300 capitalize text-center">
              ${this.weather.condition}
            </div>
            <div class="mt-1 text-[10px] text-gray-400 uppercase tracking-widest font-bold"><i class="fa-solid fa-location-dot mr-1"></i> Windham, ME</div>
         </div>
       `;
    }

    this.innerHTML = `
      <div class="${bgClass} rounded-2xl p-4 flex flex-col h-full transition-all duration-300">
        <!-- Header -->
        <div class="flex items-center justify-between mb-2 flex-shrink-0">
          <div class="flex items-center gap-2 text-${accent}-500 dark:text-${accent}-400">
            <i class="fa-solid fa-cloud-sun text-sm"></i>
            <span class="text-xs font-bold uppercase tracking-wider">Weather</span>
          </div>
          <button onclick="this.closest('ada-weather').fetchWeather()" class="text-gray-400 hover:text-${accent}-500 transition-colors cursor-pointer" title="Refresh">
             <i class="fa-solid fa-rotate-right text-[10px] ${this.loading ? 'fa-spin' : ''}"></i>
          </button>
        </div>
        ${content}
      </div>
    `;
  }
}
customElements.define('ada-weather', WeatherWidget);
