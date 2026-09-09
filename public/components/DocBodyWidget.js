class DocBodyWidget extends HTMLElement {
  constructor() {
    super();
    this.text = "";
    this.typingTimer = null;
    
    this.widgetId = null;
    this.fadeTimer = null;
    
    this.slashActive = false;
    this.slashQuery = "";
    this.slashStartIndex = -1;
    this.slashSelectedIndex = 0;
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
          if (this.text.trim() && !window.isEditingLayout) this.showPreview();
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
    if (statusIcon) {
      statusIcon.style.opacity = '1';
      statusIcon.className = 'fa-solid fa-spinner fa-spin text-gray-500 text-[10px] transition-all duration-300';
    }

    try {
      await fetch(`/api/docs/${this.widgetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: this.text })
      });
      if (statusIcon) {
        statusIcon.className = 'fa-solid fa-cloud-arrow-up text-emerald-500 text-[10px] transition-all duration-300';
        setTimeout(() => { if (statusIcon) statusIcon.className = 'fa-solid fa-cloud text-gray-500 text-[10px] transition-all duration-300'; }, 2000);
        
        clearTimeout(this.fadeTimer);
        this.fadeTimer = setTimeout(() => { if (statusIcon) statusIcon.style.opacity = '0'; }, 45000);
      }
    } catch (e) {
      if (statusIcon) {
        statusIcon.className = 'fa-solid fa-circle-exclamation text-rose-500 text-[10px] transition-all duration-300';
      }
    }
  }

  handleKeydown(e) {
    if (!this.slashActive) return;
    
    const menu = this.querySelector('#slash-menu');
    const items = menu.querySelectorAll('.slash-item');
    if (!items.length) return;
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.slashSelectedIndex = (this.slashSelectedIndex + 1) % items.length;
      this.updateSlashSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.slashSelectedIndex = (this.slashSelectedIndex - 1 + items.length) % items.length;
      this.updateSlashSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[this.slashSelectedIndex].click();
    } else if (e.key === 'Escape') {
      this.closeSlashMenu();
    }
  }

  handleInput() {
    clearTimeout(this.typingTimer);
    clearTimeout(this.fadeTimer);
    
    this.checkSlashCommand();
    
    const statusIcon = this.querySelector('#doc-status');
    if (statusIcon) {
      statusIcon.className = 'fa-solid fa-pen text-indigo-400 text-[10px] transition-all duration-300';
      statusIcon.style.opacity = '1';
    }

    this.adjustHeight();
    this.typingTimer = setTimeout(() => this.saveText(), 1000);
    
  }

  checkSlashCommand() {
    const textarea = this.querySelector('textarea');
    const val = textarea.value;
    const pos = textarea.selectionStart;
    
    // Look backwards from cursor for a slash
    const textBeforeCursor = val.substring(0, pos);
    const match = textBeforeCursor.match(/(?:\s|^)\/([a-zA-Z0-9-]*)$/);
    
    if (match) {
      this.slashActive = true;
      this.slashQuery = match[1].toLowerCase();
      this.slashStartIndex = pos - match[1].length - 1; // index of the '/'
      this.openSlashMenu();
    } else {
      this.closeSlashMenu();
    }
  }

  openSlashMenu() {
    const menu = this.querySelector('#slash-menu');
    const container = this.querySelector('#slash-menu-items');
    
    if (!window.homepageDoc || !window.homepageDoc.widgets) {
      this.closeSlashMenu();
      return;
    }
    
    // Filter available widgets that are NOT the doc body itself
    let available = window.homepageDoc.widgets.filter(w => w.id !== this.widgetId);
    
    if (this.slashQuery) {
      available = available.filter(w => 
        (w.title || '').toLowerCase().includes(this.slashQuery) || 
        w.id.toLowerCase().includes(this.slashQuery) ||
        (w.html || '').toLowerCase().includes(this.slashQuery)
      );
    }
    
    if (available.length === 0) {
      this.closeSlashMenu();
      return;
    }
    
    container.innerHTML = available.map((w, i) => {
      let icon = 'fa-puzzle-piece';
      if (w.html && w.html.includes('clock')) icon = 'fa-clock';
      if (w.html && w.html.includes('photo')) icon = 'fa-image';
      if (w.html && w.html.includes('scratchpad')) icon = 'fa-pen-nib';
      if (w.icon) icon = w.icon;
      
      const title = w.title || (w.html ? w.html.match(/<([a-zA-Z0-9-]+)/)[1] : w.id);
      
      return `
        <div class="slash-item p-2 flex items-center gap-3 rounded-lg cursor-pointer hover:bg-indigo-500/10 text-gray-600 dark:text-gray-300 hover:text-indigo-500 transition-colors ${i === 0 ? 'bg-indigo-500/10 text-indigo-500' : ''}" data-id="${w.id}" data-index="${i}">
          <div class="w-6 h-6 flex items-center justify-center bg-gray-100 dark:bg-black/20 rounded-md text-[10px]"><i class="fa-solid ${icon}"></i></div>
          <div class="flex-1 flex flex-col">
            <span class="text-xs font-bold leading-tight">${title}</span>
            <span class="text-[9px] opacity-50 font-mono leading-tight">${w.id}</span>
          </div>
        </div>
      `;
    }).join('');
    
    this.slashSelectedIndex = 0;
    
    // Bind clicks
    container.querySelectorAll('.slash-item').forEach(item => {
      item.addEventListener('click', () => {
        this.injectWidget(item.getAttribute('data-id'));
      });
      item.addEventListener('mouseenter', () => {
        this.slashSelectedIndex = parseInt(item.getAttribute('data-index'));
        this.updateSlashSelection();
      });
    });
    
    // Position the menu near the cursor (simplified positioning: bottom right of cursor generally)
    const textarea = this.querySelector('textarea');
    menu.classList.remove('hidden');
    
    // Fallback simple positioning if caret coords are hard: 
    // Just float it below the top left, but visually it works.
    // For a perfect Notion clone we'd use a mirror div, but this is a quick MVP.
    menu.style.top = '40px';
    menu.style.left = '20px';
  }

  updateSlashSelection() {
    const items = this.querySelectorAll('.slash-item');
    items.forEach((item, i) => {
      if (i === this.slashSelectedIndex) {
        item.classList.add('bg-indigo-500/10', 'text-indigo-500');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('bg-indigo-500/10', 'text-indigo-500');
      }
    });
  }

  closeSlashMenu() {
    this.slashActive = false;
    const menu = this.querySelector('#slash-menu');
    if (menu) menu.classList.add('hidden');
  }

  injectWidget(widgetId) {
    const textarea = this.querySelector('textarea');
    const val = textarea.value;
    
    const before = val.substring(0, this.slashStartIndex);
    const after = val.substring(textarea.selectionStart);
    
    const shortcode = `[widget: ${widgetId}]`;
    textarea.value = before + shortcode + ' ' + after;
    
    this.closeSlashMenu();
    this.saveText();
    
    // Move cursor after the inserted widget
    const newPos = this.slashStartIndex + shortcode.length + 1;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
  }

  showPreview() {
    if (typeof marked === 'undefined') return;
    const textarea = this.querySelector('textarea');
    const preview = this.querySelector('[data-md-preview]');
    if (!textarea || !preview || !textarea.value.trim()) return;
    
    let html = marked.parse(textarea.value);
    
    // Reset all sidebar widgets to visible
    document.querySelectorAll('.widget-container').forEach(c => c.style.display = '');
    
    // Inject Live Widgets
    if (window.homepageDoc && window.homepageDoc.widgets) {
      html = html.replace(/\[widget:\s*([a-zA-Z0-9-]+)\]/g, (match, id) => {
        const w = window.homepageDoc.widgets.find(widget => widget.id === id);
        if (w) {
          // Hide it from the sidebar
          const container = document.getElementById(w.id + '-container');
          if (container) container.style.display = 'none';
          
          return `<div class="embedded-widget my-6 rounded-2xl overflow-hidden border border-white/5 relative" style="min-height: 200px;">${w.html}</div>`;
        }
        return match;
      });
    }
    
    preview.innerHTML = html;
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
    
    // Show all sidebar widgets while editing so they can be dragged
    document.querySelectorAll('.widget-container').forEach(c => c.style.display = '');
    
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
           <i id="doc-status" class="fa-solid fa-cloud text-gray-600 text-[10px] transition-all duration-300" style="opacity: 0;"></i>
        </div>
        
        <textarea class="w-full h-full min-h-[300px] bg-transparent border-none resize-none focus:outline-none text-gray-800 dark:text-gray-200 text-base placeholder-gray-400 dark:placeholder-gray-600 custom-scrollbar leading-relaxed" placeholder="Type '/' for commands, or start writing your document here..."></textarea>
        
        <div data-md-preview class="hidden w-full h-full min-h-[300px] cursor-text prose dark:prose-invert max-w-none prose-p:leading-relaxed prose-headings:mt-8 prose-headings:mb-4 marker:text-indigo-400 prose-a:text-indigo-400" title="Click to edit"></div>
        
        <div id="slash-menu" class="hidden absolute z-50 w-64 bg-white dark:bg-dark-bg border border-gray-200 dark:border-dark-border rounded-xl shadow-2xl overflow-hidden flex flex-col">
           <div class="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 dark:bg-dark-card border-b border-gray-200 dark:border-dark-border">Embed Widget</div>
           <div id="slash-menu-items" class="max-h-64 overflow-y-auto custom-scrollbar p-1"></div>
        </div>
      </div>
    `;

    const textarea = this.querySelector('textarea');
    const preview = this.querySelector('[data-md-preview]');
    
    textarea.addEventListener('keydown', (e) => this.handleKeydown(e));
    textarea.addEventListener('input', () => this.handleInput());
    textarea.addEventListener('blur', () => {
      if (window.isEditingLayout) return;
      this.showPreview();
    });
    
    // Explicitly handle drops into the textarea
    textarea.addEventListener('dragover', (e) => {
      if (window.isEditingLayout) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    });
    
    textarea.addEventListener('drop', (e) => {
      if (!window.isEditingLayout) return;
      e.preventDefault();
      
      const rawData = e.dataTransfer.getData('text/plain');
      const match = rawData.match(/\[widget:\s*(.+)\]/);
      if (match) {
        const shortcode = match[0];
        
        // Try to insert exactly where dropped!
        let inserted = false;
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (range && range.startContainer) {
            // Because it's a textarea, caretRangeFromPoint often returns the text node of the textarea.
            // But getting exact string index is tricky. We can use selectionStart/End if focus is updated, 
            // but preventDefault stops focus.
            // Let's just focus, set the selection, and insert.
            textarea.focus();
            
            // Textarea specific drop injection:
            // The browser's native textdrop is blocked because we are dragging a DOM element.
            // A reliable hack for textareas is to just append if we can't find the exact index.
            const text = textarea.value;
            textarea.value = text + '\n\n' + shortcode + '\n';
            inserted = true;
          }
        }
        
        if (!inserted) {
           textarea.value += '\n\n' + shortcode + '\n';
        }

        this.saveText();
        this.showPreview();
      }
    });
    
    preview.addEventListener('click', () => this.showEditor());
    
    // Allow dragging directly onto the preview mode document!
    preview.addEventListener('dragover', (e) => {
      if (window.isEditingLayout) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    });
    
    preview.addEventListener('drop', (e) => {
      if (!window.isEditingLayout) return;
      e.preventDefault();
      const rawData = e.dataTransfer.getData('text/plain');
      const match = rawData.match(/\[widget:\s*(.+)\]/);
      if (match) {
        textarea.value += '\n\n' + match[0] + '\n';
        this.saveText();
        this.showPreview();
      }
    });
  }
}

customElements.define('ada-doc-body', DocBodyWidget);
