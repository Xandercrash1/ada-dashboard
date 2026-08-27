class ScriptRunnerWidget extends HTMLElement {
  connectedCallback() { this.render(); }
  static get observedAttributes() { return ['script-id', 'label', 'icon', 'accent']; }
  attributeChangedCallback() { this.render(); }
  
  async runScript() {
    const scriptId = this.getAttribute('script-id');
    if (!scriptId) return;
    
    const btn = this.querySelector('button');
    const iconEl = btn.querySelector('i');
    const originalIcon = iconEl.className;
    
    // Set loading state
    iconEl.className = 'fa-solid fa-spinner fa-spin';
    btn.disabled = true;
    btn.classList.add('opacity-50');
    
    try {
      const res = await fetch('/api/scripts/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: scriptId })
      });
      if (res.ok) {
        if (window.showToast) window.showToast('Script started successfully', 'success');
      } else {
        if (window.showToast) window.showToast('Failed to start script', 'error');
      }
    } catch (e) {
      if (window.showToast) window.showToast('Error connecting to server', 'error');
    } finally {
      // Restore state
      iconEl.className = originalIcon;
      btn.disabled = false;
      btn.classList.remove('opacity-50');
    }
  }

  render() {
    const theme = this.getAttribute('theme') || 'transparent';
    let bgClass = '';
    if (theme === 'glass') bgClass = 'bg-white/5 dark:bg-black/20 backdrop-blur-md border border-white/10 dark:border-white/5 shadow-lg';
    else if (theme === 'solid') bgClass = 'bg-dark-card border border-dark-border';
    else bgClass = '';

    const label = this.getAttribute('label') || 'Run Script';
    const icon = this.getAttribute('icon') || 'fa-terminal';
    const accent = this.getAttribute('accent') || 'indigo';
    const scriptId = this.getAttribute('script-id') || 'sys-health';
    
    this.innerHTML = `
      <div class="${bgClass} rounded-xl p-4 flex flex-col justify-center items-center h-full gap-3 transition-colors hover:bg-dark-bg">
        <div class="text-gray-400 text-xs font-semibold uppercase tracking-wider">${scriptId}</div>
        <button class="w-full py-3 px-4 rounded-lg bg-${accent}-500 hover:bg-${accent}-600 text-white font-bold flex items-center justify-center gap-2 transition-colors">
            <i class="fa-solid ${icon}"></i> ${label}
        </button>
      </div>
    `;
    
    this.querySelector('button').addEventListener('click', () => this.runScript());
  }
}
customElements.define('ada-script-runner', ScriptRunnerWidget);
