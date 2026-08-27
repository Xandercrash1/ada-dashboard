class StopwatchWidget extends HTMLElement {
  constructor() {
    super();
    this.elapsed = 0;
    this.running = false;
    this.lastTime = 0;
  }
  connectedCallback() { this.render(); }
  disconnectedCallback() { clearInterval(this.interval); }
  
  toggle() {
    this.running = !this.running;
    if (this.running) {
      this.lastTime = Date.now();
      this.interval = setInterval(() => this.tick(), 50);
      this.querySelector('.play-btn i').classList.replace('fa-play', 'fa-pause');
    } else {
      clearInterval(this.interval);
      this.querySelector('.play-btn i').classList.replace('fa-pause', 'fa-play');
    }
  }

  reset() {
    this.running = false;
    clearInterval(this.interval);
    this.elapsed = 0;
    this.querySelector('.play-btn i').classList.replace('fa-pause', 'fa-play');
    this.updateDisplay();
  }

  tick() {
    const now = Date.now();
    this.elapsed += (now - this.lastTime);
    this.lastTime = now;
    this.updateDisplay();
  }

  updateDisplay() {
    const el = this.querySelector('.time-display');
    if (!el) return;
    const ms = Math.floor((this.elapsed % 1000) / 10);
    const s = Math.floor((this.elapsed / 1000) % 60);
    const m = Math.floor((this.elapsed / (1000 * 60)) % 60);
    const h = Math.floor(this.elapsed / (1000 * 60 * 60));
    
    const pad = n => n.toString().padStart(2, '0');
    el.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms)}` : `${pad(m)}:${pad(s)}.${pad(ms)}`;
  }

  render() {
    const theme = this.getAttribute('theme') || 'transparent';
    const accent = this.getAttribute('accent') || 'indigo';
    let bgClass = '';
    if (theme === 'glass') bgClass = 'bg-white/5 dark:bg-black/20 backdrop-blur-md border border-white/10 dark:border-white/5 shadow-lg';
    else if (theme === 'solid') bgClass = 'bg-dark-card border border-dark-border';
    else if (theme === 'neon') bgClass = `bg-${accent}-500/10 backdrop-blur-md border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/30 text-${accent}-100`;
    else if (theme === 'gradient') bgClass = `bg-gradient-to-br from-${accent}-600/80 to-${accent}-900/80 backdrop-blur-md border border-${accent}-400/30 shadow-lg text-white`;
    else bgClass = '';

    const title = this.getAttribute('title') || 'Stopwatch';
    const accent = this.getAttribute('accent') || 'emerald';
    
    this.innerHTML = `
      <div class="${bgClass} rounded-xl p-4 flex flex-col justify-between h-full">
        <div class="flex items-center gap-2 text-${accent}-400 mb-2">
            <i class="fa-solid fa-stopwatch"></i>
            <span class="text-xs font-semibold uppercase tracking-wider">${title}</span>
        </div>
        <div class="time-display text-3xl font-bold text-white font-mono tracking-wider text-center my-3">00:00.00</div>
        <div class="flex justify-center gap-3">
            <button class="play-btn w-10 h-10 rounded-full bg-${accent}-500 hover:bg-${accent}-600 text-white flex items-center justify-center transition-colors">
                <i class="fa-solid fa-play"></i>
            </button>
            <button class="reset-btn w-10 h-10 rounded-full bg-gray-700 hover:bg-gray-600 text-white flex items-center justify-center transition-colors">
                <i class="fa-solid fa-rotate-left"></i>
            </button>
        </div>
      </div>
    `;
    
    this.querySelector('.play-btn').addEventListener('click', () => this.toggle());
    this.querySelector('.reset-btn').addEventListener('click', () => this.reset());
  }
}
customElements.define('ada-stopwatch', StopwatchWidget);
