class AnalogClockWidget extends HTMLElement {
  connectedCallback() {
    this.render();
    this.interval = setInterval(() => this.updateTime(), 1000);
  }
  disconnectedCallback() { clearInterval(this.interval); }
  static get observedAttributes() { return ['theme']; }
  attributeChangedCallback() { this.render(); }

  updateTime() {
    const now = new Date();
    const s = now.getSeconds() * 6;
    const m = now.getMinutes() * 6 + s / 60;
    const h = (now.getHours() % 12) * 30 + m / 12;
    
    const hHand = this.querySelector('.hour-hand');
    const mHand = this.querySelector('.minute-hand');
    const sHand = this.querySelector('.second-hand');
    if (hHand) hHand.style.transform = `rotate(${h}deg)`;
    if (mHand) mHand.style.transform = `rotate(${m}deg)`;
    if (sHand) sHand.style.transform = `rotate(${s}deg)`;
  }

  render() {
    const theme = this.getAttribute('theme') || 'transparent';
    const accentColor = this.getAttribute('accent') || 'indigo';
    let bgClass = '';
    let styleBg = '';
    let face = 'rgba(255,255,255,0.05)';
    let marks = 'rgba(255,255,255,0.3)';
    let hands = '#e2e8f0';
    let accent = '#6366f1'; 
    
    if (theme === 'glass') {
        bgClass = 'bg-white/5 dark:bg-black/20 backdrop-blur-md border border-white/10 dark:border-white/5 shadow-lg';
    } else if (theme === 'neon') {
        bgClass = `bg-${accentColor}-500/10 backdrop-blur-md border border-${accentColor}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accentColor}-500/30 text-${accentColor}-100`;
        accent = '#38bdf8';
    } else if (theme === 'gradient') {
        bgClass = `bg-gradient-to-br from-${accentColor}-600/80 to-${accentColor}-900/80 backdrop-blur-md border border-${accentColor}-400/30 shadow-lg text-white`;
        face = 'rgba(0,0,0,0.2)';
    } else if (theme === 'light') {
        styleBg = 'background: #fff;';
        face = '#f3f4f6';
        marks = '#374151';
        hands = '#111827';
    } else if (theme === 'dark') {
        styleBg = 'background: #1e1e2e;';
    } else if (theme === 'transparent') {
        bgClass = '';
    }

    this.innerHTML = `
      <div class="${bgClass}" style="${styleBg} padding: 20px; border-radius: 12px; height: 100%; display: flex; align-items: center; justify-content: center; min-height: 150px;">
        <div style="position: relative; width: 120px; height: 120px; border-radius: 50%; background: ${face}; border: 4px solid ${marks}; box-shadow: inset 0 0 10px rgba(0,0,0,0.1);">
          <div class="hour-hand" style="position: absolute; width: 4px; height: 35px; background: ${hands}; top: 25px; left: 54px; transform-origin: bottom center; border-radius: 2px;"></div>
          <div class="minute-hand" style="position: absolute; width: 3px; height: 45px; background: ${hands}; top: 15px; left: 54.5px; transform-origin: bottom center; border-radius: 1.5px;"></div>
          <div class="second-hand" style="position: absolute; width: 2px; height: 50px; background: ${accent}; top: 10px; left: 55px; transform-origin: bottom center; border-radius: 1px;"></div>
          <div style="position: absolute; width: 8px; height: 8px; background: ${accent}; border-radius: 50%; top: 52px; left: 52px;"></div>
        </div>
      </div>
    `;
    this.updateTime();
  }
}
customElements.define('ada-analog-clock', AnalogClockWidget);
