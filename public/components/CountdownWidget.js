class CountdownWidget extends HTMLElement {
  connectedCallback() {
    this.render();
    this.interval = setInterval(() => this.updateTime(), 1000);
  }
  disconnectedCallback() { clearInterval(this.interval); }
  static get observedAttributes() { return ['target', 'title', 'accent']; }
  attributeChangedCallback() { this.render(); }

  updateTime() {
    const targetStr = this.getAttribute('target');
    if (!targetStr) return;
    const targetDate = new Date(targetStr).getTime();
    const now = new Date().getTime();
    const dist = targetDate - now;

    const el = this.querySelector('.timer-text');
    if (!el) return;

    if (dist < 0) {
      el.textContent = "00:00:00:00";
      return;
    }

    const d = Math.floor(dist / (1000 * 60 * 60 * 24));
    const h = Math.floor((dist % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const m = Math.floor((dist % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((dist % (1000 * 60)) / 1000);

    const pad = n => n.toString().padStart(2, '0');
    el.textContent = `${pad(d)}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
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

    const title = this.hasAttribute('title') ? this.getAttribute('title') : 'Countdown';
    // const accent = this.getAttribute('accent') || 'indigo';
    
    this.innerHTML = `
      <div class="${bgClass} rounded-xl p-4 flex flex-col justify-between h-full">
        ${title ? `<div class="flex items-center gap-2 text-${accent}-400 mb-2"><i class="fa-solid fa-hourglass-half"></i><span class="text-xs font-semibold uppercase tracking-wider">${title}</span></div>` : ''}
        <div class="timer-text text-2xl font-bold text-white font-mono tracking-widest text-center mt-2">--:--:--:--</div>
      </div>
    `;
    this.updateTime();
  }
}
customElements.define('ada-countdown', CountdownWidget);
