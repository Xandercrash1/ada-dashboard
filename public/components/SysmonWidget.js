class SysmonWidget extends HTMLElement {
  constructor() {
    super();
    this.stats = null;
    this.pollInterval = null;
  }

  connectedCallback() {
    this.render();
    this.fetchStats();
    this.pollInterval = setInterval(() => this.fetchStats(), 5000);
  }

  disconnectedCallback() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  static get observedAttributes() { return ['theme', 'accent']; }
  attributeChangedCallback() { this.render(); }

  async fetchStats() {
    try {
      const res = await fetch('/api/system/stats');
      if (res.ok) {
        this.stats = await res.json();
        this.renderData();
      }
    } catch (e) {}
  }

  render() {
    const theme = this.getAttribute('theme') || 'glass';
    const accent = this.getAttribute('accent') || 'emerald';

    const bgClass = theme === 'transparent' ? 'bg-transparent' : 
                   theme === 'solid' ? 'bg-dark-card border border-dark-border' :
                   theme === 'neon' ? `bg-dark-card border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/20` :
                   theme === 'gradient' ? `bg-gradient-to-br from-${accent}-900/40 to-dark-card border border-${accent}-500/30` :
                   `bg-dark-bg/60 backdrop-blur-xl border border-white/10`; 

    this.innerHTML = `
      <div class="${bgClass} rounded-2xl p-4 flex flex-col h-full overflow-hidden transition-all duration-300">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2 text-${accent}-400">
            <i class="fa-solid fa-server text-sm"></i>
            <span class="text-xs font-bold uppercase tracking-wider">VPS Health</span>
          </div>
          <i class="fa-solid fa-circle-nodes text-gray-500 text-[10px]"></i>
        </div>
        
        <div class="flex flex-col gap-3 flex-1 justify-center" id="sysmon-content">
          <div class="animate-pulse flex flex-col gap-3">
             <div class="h-2 bg-white/10 rounded w-full"></div>
             <div class="h-2 bg-white/10 rounded w-4/5"></div>
             <div class="h-2 bg-white/10 rounded w-full"></div>
          </div>
        </div>
      </div>
    `;
  }

  renderData() {
    if (!this.stats) return;
    const accent = this.getAttribute('accent') || 'emerald';
    const content = this.querySelector('#sysmon-content');
    if (!content) return;

    // Determine Load Percent (heuristic)
    const loadPercent = Math.min(100, Math.round((this.stats.cpu.load[0] / this.stats.cpu.cores) * 100));
    const diskPercent = parseInt(this.stats.disk.percent) || 0;
    
    content.innerHTML = `
      <!-- CPU -->
      <div>
        <div class="flex justify-between text-[10px] text-gray-400 font-semibold mb-1 uppercase tracking-wide">
          <span>CPU (${this.stats.cpu.cores} Cores)</span>
          <span>${loadPercent}%</span>
        </div>
        <div class="w-full bg-black/40 rounded-full h-1.5 overflow-hidden">
          <div class="bg-${accent}-500 h-1.5 rounded-full" style="width: ${loadPercent}%"></div>
        </div>
      </div>

      <!-- RAM -->
      <div>
        <div class="flex justify-between text-[10px] text-gray-400 font-semibold mb-1 uppercase tracking-wide">
          <span>RAM</span>
          <span>${this.stats.memory.used} / ${this.stats.memory.total} MB</span>
        </div>
        <div class="w-full bg-black/40 rounded-full h-1.5 overflow-hidden">
          <div class="bg-${accent}-500 h-1.5 rounded-full" style="width: ${this.stats.memory.percent}%"></div>
        </div>
      </div>

      <!-- DISK -->
      <div>
        <div class="flex justify-between text-[10px] text-gray-400 font-semibold mb-1 uppercase tracking-wide">
          <span>Storage</span>
          <span>${this.stats.disk.used} / ${this.stats.disk.total}</span>
        </div>
        <div class="w-full bg-black/40 rounded-full h-1.5 overflow-hidden">
          <div class="bg-${accent}-500 h-1.5 rounded-full" style="width: ${diskPercent}%"></div>
        </div>
      </div>
    `;
  }
}

customElements.define('ada-sysmon', SysmonWidget);
