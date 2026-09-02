class ScratchpadWidget extends HTMLElement {
  constructor() {
    super();
    this.text = "";
    this.typingTimer = null;
    this.mdTimer = null;
    this.previewing = false;
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
          setTimeout(() => this.adjustHeight(), 50); // wait for render
          // Existing notes open already rendered (fb-1787944441070); one
          // click on the preview drops back into the editor.
          if (this.text.trim()) this.showPreview();
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
    clearTimeout(this.mdTimer);
    const statusIcon = this.querySelector('#scratchpad-status');
    if (statusIcon) statusIcon.className = 'fa-solid fa-pen text-amber-500';

    this.adjustHeight();
    this.typingTimer = setTimeout(() => this.saveText(), 1000);
    // Markdown renders only after typing goes quiet, so the swap never
    // fights the keystroke flow (fb-1787944441070; tightened 5s→2s per Alex).
    this.mdTimer = setTimeout(() => this.showPreview(), 2000);
  }

  showPreview() {
    if (typeof marked === 'undefined') return;
    const textarea = this.querySelector('textarea');
    const preview = this.querySelector('[data-md-preview]');
    if (!textarea || !preview || !textarea.value.trim()) return;
    preview.innerHTML = marked.parse(textarea.value);
    this.wireCheckboxes(preview, textarea);
    textarea.classList.add('hidden');
    preview.classList.remove('hidden');
    this.previewing = true;
  }

  // GFM task-list checkboxes come out of marked disabled. Re-enable them and
  // write toggles back into the markdown source — the i-th rendered checkbox
  // corresponds to the i-th task marker in the text, top to bottom.
  wireCheckboxes(preview, textarea) {
    preview.querySelectorAll('input[type="checkbox"]').forEach((box, i) => {
      box.disabled = false;
      box.classList.add('cursor-pointer');
      box.addEventListener('change', () => {
        let n = -1;
        textarea.value = textarea.value.replace(
          /(^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm,
          (m, pre, state, post) => {
            n++;
            if (n !== i) return m;
            return pre + (state === ' ' ? 'x' : ' ') + post;
          }
        );
        this.saveText();
        this.showPreview(); // re-render so done-item styling stays in sync
      });
    });
  }

  showEditor() {
    const textarea = this.querySelector('textarea');
    const preview = this.querySelector('[data-md-preview]');
    if (!textarea || !preview) return;
    preview.classList.add('hidden');
    textarea.classList.remove('hidden');
    this.previewing = false;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }

  adjustHeight() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    
    // To get true text height, we must remove flex/height constraints
    // that force the textarea to stretch to the parent container.
    const originalFlex = textarea.style.flex;
    const originalHeight = textarea.style.height;
    
    textarea.style.flex = 'none';
    textarea.style.height = '0px';
    const contentHeight = textarea.scrollHeight;
    
    textarea.style.flex = originalFlex;
    textarea.style.height = originalHeight;
    
    // Header is ~30px, padding is 32px. 
    const requiredHeight = contentHeight + 65;
    
    // Row 1 = 120px, Row 2 = 256px, Row 3 = 392px, Row 4 = 528px
    let requiredRows = 1; 
    if (requiredHeight > 392) requiredRows = 4;
    else if (requiredHeight > 256) requiredRows = 3;
    else if (requiredHeight > 120) requiredRows = 2;
    
    const wrapper = this.parentElement;
    if (wrapper) {
      let currentRows = 2;
      const classesToRemove = [];
      wrapper.classList.forEach(cls => {
        if (cls.startsWith('row-span-')) classesToRemove.push(cls);
      });
      classesToRemove.forEach(cls => {
        currentRows = parseInt(cls.replace('row-span-', '')) || currentRows;
        wrapper.classList.remove(cls);
      });
      
      wrapper.classList.add(`row-span-${requiredRows}`);
      
      // Persist the size without triggering a full re-render
      if (currentRows !== requiredRows && window.homepageDoc) {
        const widgetDef = window.homepageDoc.widgets.find(w => w.id === 'scratchpad');
        if (widgetDef && widgetDef.rows !== requiredRows) {
           widgetDef.rows = requiredRows;
           if (window.saveHomepageDoc) window.saveHomepageDoc();
        }
      }
    }
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
        
        <textarea class="flex-1 w-full bg-transparent border-none resize-none focus:outline-none text-gray-200 text-sm placeholder-gray-600 custom-scrollbar" placeholder="Type a quick note here... It syncs instantly across all your devices. Markdown renders when you pause."></textarea>
        <div data-md-preview class="hidden flex-1 w-full overflow-y-auto custom-scrollbar cursor-text prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-1.5 marker:text-${accent}-400 prose-a:text-${accent}-400" title="Click to edit"></div>
      </div>
    `;

    this.querySelector('textarea').addEventListener('input', () => this.handleInput());
    this.querySelector('[data-md-preview]').addEventListener('click', () => this.showEditor());
  }
}

customElements.define('ada-scratchpad', ScratchpadWidget);
