class ClockWidget extends HTMLElement {
  connectedCallback() {
    this.render();
    this.interval = setInterval(() => this.updateTime(), 1000);
  }
  disconnectedCallback() { clearInterval(this.interval); }
  static get observedAttributes() { return ['theme', 'format', 'font']; }
  attributeChangedCallback() { this.render(); }
  
  updateTime() {
    const timeEl = this.querySelector('.time');
    const dateEl = this.querySelector('.date');
    if (!timeEl || !dateEl) return;
    
    const now = new Date();
    const format = this.getAttribute('format') || '12h';
    timeEl.textContent = now.toLocaleTimeString([], { 
      hour: '2-digit', minute: '2-digit', second: '2-digit', 
      hour12: format !== '24h' 
    });
    dateEl.textContent = now.toLocaleDateString();
  }

  render() {
    const theme = this.getAttribute('theme') || 'transparent';
    const accent = this.getAttribute('accent') || 'indigo';
    let bgClass = '';
    let styleBg = '';
    
    if (theme === 'glass') {
        bgClass = 'bg-white/5 dark:bg-black/20 backdrop-blur-md border border-white/10 dark:border-white/5 shadow-lg';
    } else if (theme === 'neon') {
        bgClass = `bg-${accent}-500/10 backdrop-blur-md border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/30 text-${accent}-100`;
    } else if (theme === 'gradient') {
        bgClass = `bg-gradient-to-br from-${accent}-600/80 to-${accent}-900/80 backdrop-blur-md border border-${accent}-400/30 shadow-lg text-white`;
    } else if (theme === 'transparent') {
        bgClass = '';
    } else {
        styleBg = `background: ${theme};`;
    }

    const font = this.getAttribute('font') || "'Courier New', monospace";
    this.innerHTML = `
      <div class="${bgClass}" style="${styleBg} color: white; text-align: center; padding: 10px; border-radius: 5px; height: 100%; display: flex; flex-direction: column; justify-content: center;">
          <div class="time" style="font-family:${font};font-size:2.4rem;font-weight:700;letter-spacing:3px;"></div>
          <div class="date" style="font-size:0.85rem;color:rgba(255,255,255,0.8);margin-top:5px;font-family: 'Inter', sans-serif;"></div>
      </div>
    `;
    this.updateTime();
  }
}
customElements.define('ada-clock', ClockWidget);
