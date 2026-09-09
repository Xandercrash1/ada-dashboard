class DocBodyWidget extends HTMLElement {
  constructor() {
    super();
    this.text = "";
    this.typingTimer = null;
    this.mdTimer = null;
    this.widgetId = null;
  }

  connectedCallback() {
    this.classList.add("block", "w-full", "h-full", "min-h-[300px]");
    this.widgetId = this.getAttribute('widget-id');
    if (!this.widgetId) {
      // Generate a stable ID if none provided by looking at the parent widget container, 
      // but ideally this is passed in from the layout builder
      const wrapper = this.closest('[data-widget-id]');
      this.widgetId = wrapper ? wrapper.getAttribute('data-widget-id') : 'default-body';
    }
    this.render();
    this.fetchText();
  }

  async fetchText() {
    if (!this.widgetId) return;
    try {
      const res = await fetch(`/api/docs/${this.widgetId}`);
      if (res.ok) {
        const data = await res.json();
        this.text = data.text || "";
        const textarea = this.querySelector('textarea');
        if (textarea && document.activeElement !== textarea) {
          textarea.value = this.text;
          setTimeout(() => this.adjustHeight(), 50);
          if (this.text.trim()) this.showPreview();
        }
      }
    } catch (e) {
      console.error("Failed to load doc body:", e);
    }
  }

  async saveText() {
    if (!this.widgetId) return;
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    this.text = textarea.value;
    
    const statusIcon = this.querySelector('#doc-status');
    if (statusIcon) statusIcon.style.opacity = '1';

    try {
      await fetch(`/api/docs/${this.widgetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: this.text })
      });
      if (statusIcon) {
        statusIcon.className = 'fa-solid fa-check text-emerald-500 text-xs';
        setTimeout(() => { if (statusIcon) statusIcon.style.opacity = '0'; }, 2000);
      }
    } catch (e) {
      if (statusIcon) statusIcon.className = 'fa-solid fa-triangle-exclamation text-rose-500 text-xs';
    }
  }

  handleInput() {
    clearTimeout(this.typingTimer);
    clearTimeout(this.mdTimer);
    const statusIcon = this.querySelector('#doc-status');
    if (statusIcon) {
      statusIcon.className = 'fa-solid fa-pen text-indigo-400 text-xs';
      statusIcon.style.opacity = '1';
    }

    this.adjustHeight();
    this.typingTimer = setTimeout(() => this.saveText(), 1000);
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
  }

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
        this.showPreview(); 
      });
    });
  }

  showEditor() {
    const textarea = this.querySelector('textarea');
    const preview = this.querySelector('[data-md-preview]');
    if (!textarea || !preview) return;
    preview.classList.add('hidden');
    textarea.classList.remove('hidden');
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }

  adjustHeight() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    textarea.style.height = '0px';
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = Math.max(contentHeight, 300) + 'px';
  }

  render() {
    // Completely borderless and transparent, looking like a native Notion document
    this.innerHTML = `
      <div class="relative w-full h-full p-4 group">
        <div class="absolute top-2 right-4 flex items-center justify-end h-4 w-4">
           <i id="doc-status" class="fa-solid fa-check text-emerald-500 text-xs transition-opacity duration-300" style="opacity: 0;"></i>
        </div>
        
        <textarea class="w-full h-full min-h-[300px] bg-transparent border-none resize-none focus:outline-none text-gray-200 text-base placeholder-gray-600 custom-scrollbar leading-relaxed" placeholder="Type '/' for commands, or start writing your document here..."></textarea>
        
        <div data-md-preview class="hidden w-full h-full min-h-[300px] cursor-text prose prose-invert max-w-none prose-p:leading-relaxed prose-headings:mt-8 prose-headings:mb-4 marker:text-indigo-400 prose-a:text-indigo-400" title="Click to edit"></div>
      </div>
    `;

    this.querySelector('textarea').addEventListener('input', () => this.handleInput());
    this.querySelector('[data-md-preview]').addEventListener('click', () => this.showEditor());
  }
}

customElements.define('ada-doc-body', DocBodyWidget);
