class ScriptRunnerWidget extends HTMLElement {
  // Config fields the Widget Inspector renders (fb-1789015021586).
  static configSchema = [
    { attr: 'script-id', label: 'Script', type: 'select', source: { url: '/api/scripts', value: 'id', label: 'name' }, default: 'sys-health' },
    { attr: 'label', label: 'Button label', type: 'text', default: 'Run Script' },
    { attr: 'icon', label: 'Icon (FontAwesome)', type: 'text', default: 'fa-terminal' },
  ];

  connectedCallback() {
    this.classList.add("block", "w-full", "h-full"); this.render(); }
  static get observedAttributes() { return ['script-id', 'label', 'icon', 'accent']; }
  attributeChangedCallback() { this.render(); }
  
  async runScript() {
    const scriptId = this.getAttribute('script-id');
    if (!scriptId) { if (window.showToast) window.showToast('Pick a script for this button in its Settings', 'warn'); return; }
    
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
      // The server waits for the script and returns its output: show it, and
      // report the script's own result (it can fail with HTTP 200).
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.success !== false;
      const secs = typeof data.durationMs === 'number' ? ` in ${(data.durationMs / 1000).toFixed(1)}s` : '';
      if (window.showToast) window.showToast(ok ? `Script finished${secs}` : `Script failed${data.error ? ': ' + data.error : ''}`, ok ? 'success' : 'error');
      this.showOutput(ok, data);
    } catch (e) {
      if (window.showToast) window.showToast('Error connecting to server', 'error');
    } finally {
      // Restore state
      iconEl.className = originalIcon;
      btn.disabled = false;
      btn.classList.remove('opacity-50');
    }
  }

  showOutput(ok, data) {
    const box = this.querySelector('[data-role="output"]');
    const pre = this.querySelector('[data-role="output"] pre');
    if (!box || !pre) return;
    let text = (data.stdout || '').trimEnd();
    if (data.stderr) text += (text ? '\n\n' : '') + '[stderr]\n' + String(data.stderr).trimEnd();
    if (data.error && !ok) text += (text ? '\n' : '') + data.error;
    if (Array.isArray(data.available)) text += '\nAvailable scripts: ' + data.available.join(', ');
    pre.textContent = text || '(no output)';
    pre.classList.toggle('text-rose-300', !ok);
    box.classList.remove('hidden');
    if (this._savedHeight === undefined) this._savedHeight = this.style.height;
    this.style.height = 'auto';   // grow to show the output
  }

  render() {
    const theme = this.getAttribute('theme') || 'transparent';
    const accent = this.getAttribute('accent') || 'indigo';
    let bgClass = '';
    if (theme === 'glass') bgClass = 'bg-dark-bg/60 backdrop-blur-xl border border-dark-border shadow-sm';
    else if (theme === 'solid') bgClass = 'bg-dark-card border border-dark-border';
    else if (theme === 'neon') bgClass = `bg-${accent}-500/10 backdrop-blur-md border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/30 text-${accent}-100`;
    else if (theme === 'gradient') bgClass = `bg-gradient-to-br from-${accent}-600/80 to-${accent}-900/80 backdrop-blur-md border border-${accent}-400/30 shadow-lg text-white`;
    else bgClass = '';

    const label = this.getAttribute('label') || 'Run Script';
    const icon = this.getAttribute('icon') || 'fa-terminal';
    // const accent = this.getAttribute('accent') || 'indigo';
    const scriptId = this.getAttribute('script-id') || '';

    this.innerHTML = `
      <div class="${bgClass} rounded-xl p-4 flex flex-col justify-center items-center h-full gap-3 transition-colors">
        <div class="text-gray-500 dark:text-gray-400 text-xs font-semibold uppercase tracking-wider">${scriptId || 'Pick a script in Settings'}</div>
        <button class="w-full py-3 px-4 rounded-lg bg-${accent}-500 hover:bg-${accent}-600 text-white font-bold flex items-center justify-center gap-2 transition-colors">
            <i class="fa-solid ${icon}"></i> ${label}
        </button>
        <div data-role="output" class="hidden w-full">
          <div class="flex justify-between items-center mb-1 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">
            <span>Output</span><button type="button" data-role="hide" class="normal-case tracking-normal hover:underline">Hide</button>
          </div>
          <pre class="w-full max-h-56 overflow-auto text-[11px] leading-snug p-2 rounded-lg bg-black/80 text-gray-100 text-left whitespace-pre-wrap break-words"></pre>
        </div>
      </div>
    `;

    this.querySelector('button').addEventListener('click', () => this.runScript());
    this.querySelector('[data-role="hide"]').addEventListener('click', () => {
      this.querySelector('[data-role="output"]').classList.add('hidden');
      if (this._savedHeight !== undefined) { this.style.height = this._savedHeight; this._savedHeight = undefined; }
    });
  }
}
customElements.define('ada-script-runner', ScriptRunnerWidget);
