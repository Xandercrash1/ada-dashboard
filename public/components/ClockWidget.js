class ClockWidget extends HTMLElement {
  connectedCallback() {
    this.render();
    this.interval = setInterval(() => this.updateTime(), 1000);
  }
  disconnectedCallback() {
    clearInterval(this.interval);
  }
  static get observedAttributes() { return ['theme', 'format']; }
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
    const theme = this.getAttribute('theme') || 'purple';
    this.innerHTML = `
      <div style="background: ${theme}; color: white; text-align: center; padding: 10px; border-radius: 5px; height: 100%; display: flex; flex-direction: column; justify-content: center;">
          <div class="time" style="font-family:'Courier New',monospace;font-size:2.4rem;font-weight:700;letter-spacing:3px;"></div>
          <div class="date" style="font-size:0.85rem;color:rgba(255,255,255,0.8);margin-top:5px;"></div>
      </div>
    `;
    this.updateTime();
  }
}
customElements.define('ada-clock', ClockWidget);
