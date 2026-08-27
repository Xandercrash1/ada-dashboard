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
    if (hHand) hHand.style.transform = \`rotate(\${h}deg)\`;
    if (mHand) mHand.style.transform = \`rotate(\${m}deg)\`;
    if (sHand) sHand.style.transform = \`rotate(\${s}deg)\`;
  }

  render() {
    const theme = this.getAttribute('theme') || 'dark';
    const bg = theme === 'light' ? '#fff' : (theme === 'transparent' ? 'transparent' : '#1e1e2e');
    const face = theme === 'light' ? '#f3f4f6' : 'rgba(255,255,255,0.05)';
    const marks = theme === 'light' ? '#374151' : 'rgba(255,255,255,0.3)';
    const hands = theme === 'light' ? '#111827' : '#e2e8f0';
    const accent = '#6366f1'; // indigo
    
    this.innerHTML = \`
      <div style="background: \${bg}; padding: 20px; border-radius: 12px; height: 100%; display: flex; align-items: center; justify-content: center; min-height: 150px;">
        <div style="position: relative; width: 120px; height: 120px; border-radius: 50%; background: \${face}; border: 4px solid \${marks}; box-shadow: inset 0 0 10px rgba(0,0,0,0.1);">
          <div class="hour-hand" style="position: absolute; width: 4px; height: 35px; background: \${hands}; top: 25px; left: 54px; transform-origin: bottom center; border-radius: 2px;"></div>
          <div class="minute-hand" style="position: absolute; width: 3px; height: 45px; background: \${hands}; top: 15px; left: 54.5px; transform-origin: bottom center; border-radius: 1.5px;"></div>
          <div class="second-hand" style="position: absolute; width: 2px; height: 50px; background: \${accent}; top: 10px; left: 55px; transform-origin: bottom center; border-radius: 1px;"></div>
          <div style="position: absolute; width: 8px; height: 8px; background: \${accent}; border-radius: 50%; top: 52px; left: 52px;"></div>
        </div>
      </div>
    \`;
    this.updateTime();
  }
}
customElements.define('ada-analog-clock', AnalogClockWidget);
