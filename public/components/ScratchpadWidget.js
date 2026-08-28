class ScratchpadWidget extends HTMLElement {
  constructor() {
    super();
    this.text = "";
    this.typingTimer = null;
  }

  connectedCallback() {
    this.render();
    this.fetchText();
  }

  static get observedAttributes() { return ['theme', 'accent']; }
  attributeChangedCallback() { this.render(); }

  async fetchText() {
    try {
      const res = await fetch('/api/scratchpad');
      if (res.ok) {
        const data = await res.json();
        this.text = data.text || "";
        const textarea = this.querySelector('textarea');
        if (textarea && document.activeElement !== textarea) {
          textarea.value = this.text;
        }
      }
    } catch (e) {}
  }

  async saveText() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    this.text = textarea.value;
    
    const statusIcon = this.querySelector('#scratchpad-status');
    if (statusIcon) statusIcon.className = 'fa-solid fa-spinner fa-spin text-gray-500';

    try {
      await fetch('/api/scratchpad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: this.text })
      });
      if (statusIcon) statusIcon.className = 'fa-solid fa-cloud-arrow-up text-emerald-500';
      setTimeout(() => { if (statusIcon) statusIcon.className = 'fa-solid fa-cloud text-gray-600'; }, 2000);
    } catch (e) {
      if (statusIcon) statusIcon.className = 'fa-solid fa-circle-exclamation text-rose-500';
    }
  }

  handleInput() {
    clearTimeout(this.typingTimer);
    const statusIcon = this.querySelector('#scratchpad-status');
    if (statusIcon) statusIcon.className = 'fa-solid fa-pen text-amber-500';
    
    this.typingTimer = setTimeout(() => this.saveText(), 1000);
  }

  render() {
    const theme = this.getAttribute('theme') || 'glass';
    const accent = this.getAttribute('accent') || 'amber';

    const bgClass = theme === 'transparent' ? 'bg-transparent' : 
                   theme === 'solid' ? 'bg-dark-card border border-dark-border' :
                   theme === 'neon' ? `bg-dark-card border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/20` :
                   theme === 'gradient' ? `bg-gradient-to-br from-${accent}-900/40 to-dark-card border border-${accent}-500/30` :
                   `bg-dark-bg/60 backdrop-blur-xl border border-white/10`; 

    this.innerHTML = `
      <div class="${bgClass} rounded-2xl p-4 flex flex-col h-full overflow-hidden transition-all duration-300 group">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2 text-${accent}-400">
            <i class="fa-solid fa-note-sticky text-sm"></i>
            <span class="text-xs font-bold uppercase tracking-wider">Scratchpad</span>
          </div>
          <i id="scratchpad-status" class="fa-solid fa-cloud text-gray-600 text-[10px] transition-colors"></i>
        </div>
        
        <textarea class="flex-1 w-full bg-transparent border-none resize-none focus:outline-none text-gray-200 text-sm placeholder-gray-600 custom-scrollbar" placeholder="Type a quick note here... It syncs instantly across all your devices."></textarea>
      </div>
    `;
    
    this.querySelector('textarea').addEventListener('input', () => this.handleInput());
  }
}

customElements.define('ada-scratchpad', ScratchpadWidget);
