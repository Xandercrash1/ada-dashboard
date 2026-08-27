class TimerWidget extends HTMLElement {
  constructor() {
    super();
    this.remaining = 0;
    this.running = false;
    this.lastTime = 0;
  }
  connectedCallback() { 
    this.remaining = (parseInt(this.getAttribute('minutes')) || 5) * 60 * 1000;
    this.initial = this.remaining;
    this.render(); 
  }
  disconnectedCallback() { clearInterval(this.interval); }
  
  toggle() {
    this.running = !this.running;
    if (this.running) {
      if (this.remaining <= 0) this.remaining = this.initial;
      this.lastTime = Date.now();
      this.interval = setInterval(() => this.tick(), 100);
      this.querySelector('.play-btn i').classList.replace('fa-play', 'fa-pause');
    } else {
      clearInterval(this.interval);
      this.querySelector('.play-btn i').classList.replace('fa-pause', 'fa-play');
    }
  }

  reset() {
    this.running = false;
    clearInterval(this.interval);
    this.remaining = this.initial;
    this.querySelector('.play-btn i').classList.replace('fa-pause', 'fa-play');
    this.updateDisplay();
  }

  tick() {
    const now = Date.now();
    this.remaining -= (now - this.lastTime);
    this.lastTime = now;
    if (this.remaining <= 0) {
        this.remaining = 0;
        this.reset();
        // Play sound or alert here in future
    }
    this.updateDisplay();
  }

  updateDisplay() {
    const el = this.querySelector('.time-display');
    if (!el) return;
    const s = Math.floor((this.remaining / 1000) % 60);
    const m = Math.floor((this.remaining / (1000 * 60)) % 60);
    const h = Math.floor(this.remaining / (1000 * 60 * 60));
    
    const pad = n => n.toString().padStart(2, '0');
    el.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
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

    const title = this.hasAttribute('title') ? this.getAttribute('title') : 'Timer';
    // const accent = this.getAttribute('accent') || 'amber';
    
    this.innerHTML = `
      <div class="${bgClass} rounded-xl p-4 flex flex-col justify-between h-full">
        ${title ? `<div class="flex items-center gap-2 text-${accent}-400 mb-2"><i class="fa-solid fa-clock-rotate-left"></i><span class="text-xs font-semibold uppercase tracking-wider">${title}</span></div>` : ''}
        <div class="time-display text-4xl font-bold text-white font-mono tracking-wider text-center my-3">--:--</div>
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
    this.updateDisplay();
    
    this.querySelector('.play-btn').addEventListener('click', () => this.toggle());
    this.querySelector('.reset-btn').addEventListener('click', () => this.reset());
  }
}
customElements.define('ada-timer', TimerWidget);
