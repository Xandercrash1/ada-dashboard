class TodoWidget extends HTMLElement {
  // Settings shown by the page builder (and any inspector reading configSchema).
  static configSchema = [
    { attr: 'show-past-due', label: 'Show overdue', type: 'checkbox', default: 'true' },
    { attr: 'show-today', label: 'Show today', type: 'checkbox', default: 'true' },
    { attr: 'show-upcoming', label: 'Show upcoming', type: 'checkbox', default: 'false' },
  ];
  constructor() {
    super();
    this.todoView = null;
    this.config = {
      showPastDue: true,
      showToday: true,
      showUpcoming: false
    };
  }

  connectedCallback() {
    this.classList.add("block", "w-full", "h-full");
    if (!this._wired) {
      this._wired = true;
      this.addEventListener('click', e => this.onAction(e));
      this.addEventListener('submit', e => { e.preventDefault(); this.submitForm(); });
    }
    this.loadConfig();
    this.render();
    this.fetchData();
  }

  // Settings come from attributes first (show-past-due / show-today / show-upcoming,
  // "true"/"false"), so a page builder can set them directly. Falls back to the
  // legacy homepageDoc lookup for the current dashboard grid.
  static get observedAttributes() { return ['show-past-due', 'show-today', 'show-upcoming']; }

  attributeChangedCallback() {
    if (!this.isConnected) return;
    this.loadConfig();
    this.render();
    this.updateView();
  }

  loadConfig() {
    if (window.homepageDoc && window.homepageDoc.widgets) {
      const wId = this.closest('.widget-container')?.id?.replace('-container', '') || this.getAttribute('data-widget-id');
      const w = window.homepageDoc.widgets.find(x => x.id === wId);
      if (w && w.config) {
        this.config = { ...this.config, ...w.config };
      }
    }
    const attrMap = { 'show-past-due': 'showPastDue', 'show-today': 'showToday', 'show-upcoming': 'showUpcoming' };
    for (const [attr, key] of Object.entries(attrMap)) {
      if (this.hasAttribute(attr)) this.config[key] = this.getAttribute(attr) !== 'false';
    }
  }

  async fetchData() {
    try {
      const res = await fetch('/api/todo');
      if (res.ok) {
        const data = await res.json();
        this.todoView = data;
        this.updateView();
      }
    } catch (e) {
      console.error("Failed to load todo data for widget", e);
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  }

  getPriorityColor(priority) {
    switch((priority || '').toLowerCase()) {
      case 'high': return 'text-rose-400';
      case 'medium': return 'text-amber-400';
      case 'low': return 'text-sky-400';
      default: return 'text-gray-400';
    }
  }

  renderTaskRow(t) {
    const priorityColor = this.getPriorityColor(t.priority);
    return `
      <div data-row="${this.escapeHtml(t.id)}" class="flex items-start gap-3 group relative hover:bg-black/10 p-2 rounded-xl transition-colors border-l-2 border-transparent hover:border-indigo-400/50">
        <button data-action="complete" data-id="${this.escapeHtml(t.id)}" class="mt-0.5 w-4 h-4 rounded border border-gray-500 hover:border-indigo-400 hover:bg-indigo-500/20 flex items-center justify-center transition-all flex-shrink-0 text-transparent hover:text-indigo-400" title="Complete">
          <i class="fa-solid fa-check text-[9px]"></i>
        </button>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <h4 class="text-xs font-semibold text-gray-200 truncate cursor-pointer hover:text-indigo-300" data-action="edit" data-id="${this.escapeHtml(t.id)}">
              ${t.type === 'meeting' ? '<i class="fa-solid fa-users mr-1"></i> ' : ''}
              ${this.escapeHtml(t.name)}
            </h4>
          </div>
          <div class="flex flex-wrap items-center gap-2 mt-1">
            ${t.project ? `<span class="px-1.5 py-0.5 rounded bg-white/5 text-gray-400 text-[9px] font-mono">${this.escapeHtml(t.project)}</span>` : ''}
            ${(Array.isArray(t.tags) ? t.tags : []).map(n => `<span class="px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 text-[9px]"><i class="fa-solid fa-user text-[7px]"></i> ${this.escapeHtml(n[0].toUpperCase() + n.slice(1))}</span>`).join('')}
            <span class="text-[9px] font-semibold ${priorityColor}">${this.escapeHtml(t.priority || 'None')}</span>
            ${t.dueDate ? `<span class="text-[9px] text-gray-500"><i class="fa-regular fa-clock"></i> ${this.formatDate(t.dueDate)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  updateView() {
    const content = this.querySelector('#todo-content');
    if (!content) return;
    
    if (!this.todoView) {
      content.innerHTML = `<div class="text-center text-xs text-gray-500 py-6">Loading Tasks...</div>`;
      return;
    }

    let html = '';
    const { pastDue, today, upcoming } = this.todoView;

    if (this.config.showPastDue && pastDue && pastDue.length > 0) {
      html += `
        <div class="mb-4">
          <h3 class="text-[10px] font-bold uppercase tracking-wider text-rose-400 mb-2 px-2 flex items-center justify-between">
            <span><i class="fa-solid fa-circle-exclamation mr-1"></i> Overdue</span>
            <span class="bg-rose-500/20 text-rose-400 px-1.5 rounded">${pastDue.length}</span>
          </h3>
          <div class="space-y-1">
            ${pastDue.map(t => this.renderTaskRow(t)).join('')}
          </div>
        </div>
      `;
    }

    if (this.config.showToday && today && today.length > 0) {
      html += `
        <div class="mb-4">
          <h3 class="text-[10px] font-bold uppercase tracking-wider text-indigo-400 mb-2 px-2 flex items-center justify-between">
            <span>Today</span>
            <span class="bg-indigo-500/20 text-indigo-400 px-1.5 rounded">${today.length}</span>
          </h3>
          <div class="space-y-1">
            ${today.map(t => this.renderTaskRow(t)).join('')}
          </div>
        </div>
      `;
    }

    if (this.config.showUpcoming && upcoming && upcoming.length > 0) {
      html += `
        <div class="mb-4">
          <h3 class="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2 px-2 flex items-center justify-between">
            <span>Upcoming</span>
            <span class="bg-gray-500/20 text-gray-300 px-1.5 rounded">${upcoming.length}</span>
          </h3>
          <div class="space-y-1">
            ${upcoming.map(t => this.renderTaskRow(t)).join('')}
          </div>
        </div>
      `;
    }

    if (!html) {
      html = `
        <div class="flex flex-col items-center justify-center py-8 text-gray-500 space-y-2 opacity-50">
          <i class="fa-regular fa-circle-check text-2xl"></i>
          <span class="text-xs font-medium">No tasks match this view.</span>
        </div>
      `;
    }

    content.innerHTML = html;
  }

  toggleConfig(key) {
    this.config[key] = !this.config[key];
    const attr = key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    if (this.hasAttribute(attr)) this.setAttribute(attr, String(this.config[key]));
    
    // Save to homepageDoc if editing
    if (window.homepageDoc && window.homepageDoc.widgets) {
      const wId = this.closest('.widget-container')?.id?.replace('-container', '') || this.getAttribute('data-widget-id');
      const w = window.homepageDoc.widgets.find(x => x.id === wId);
      if (w) {
        w.config = this.config;
        if (window.saveHomepageDoc) window.saveHomepageDoc();
      }
    }
    
    this.updateView();
  }

  // --- Actions: the widget talks to the TODO API itself, so it works on any page ---
  async api(url, opts) {
    try {
      const res = await fetch(url, opts);
      let data = null;
      try { data = await res.json(); } catch (_) { /* empty/non-JSON body */ }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: null };
    }
  }

  showError(msg) {
    const el = this.querySelector('[data-role="error"]');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    if (msg) setTimeout(() => el.classList.add('hidden'), 6000);
  }

  findTask(id) {
    const v = this.todoView || {};
    return [...(v.pastDue || []), ...(v.today || []), ...(v.upcoming || [])].find(t => t.id === id);
  }

  // Keep the dashboard's own TODO views in step when the widget sits on the dashboard.
  async refreshAll() {
    await this.fetchData();
    if (typeof window.loadTodoDaily === 'function') window.loadTodoDaily();
  }

  onAction(e) {
    const el = e.target.closest('[data-action]');
    if (!el || !this.contains(el)) return;
    const { action, id } = el.dataset;
    if (action === 'complete') this.completeTask(id);
    else if (action === 'edit') this.openForm('edit', id);
    else if (action === 'add') this.openForm('add');
    else if (action === 'cancel') this.closeForm();
  }

  async completeTask(id) {
    const row = this.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (row) { row.style.opacity = '0.35'; row.style.pointerEvents = 'none'; }
    const r = await this.api(`/api/todo/tasks/${encodeURIComponent(id)}/complete`, { method: 'POST' });
    if (!r.ok) {
      if (row) { row.style.opacity = '1'; row.style.pointerEvents = ''; }
      this.showError('Could not complete task' + (r.data && r.data.error ? ': ' + r.data.error : '.'));
      return;
    }
    this.showError(null);
    await this.refreshAll();
  }

  openForm(mode, id) {
    // On the dashboard, use its full task modal (recurrence, people, etc.).
    if (mode === 'edit' && typeof window.openEditTodoModal === 'function') return window.openEditTodoModal(id);
    if (mode === 'add' && typeof window.openAddTodoModal === 'function') return window.openAddTodoModal();
    const form = this.querySelector('[data-role="form"]');
    const t = mode === 'edit' ? this.findTask(id) : null;
    if (mode === 'edit' && !t) return this.showError('Task not found — try refreshing.');
    this.editingId = t ? t.id : null;
    form.reset();
    this.querySelector('[data-role="form-title"]').textContent = t ? 'Edit task' : 'New task';
    // Due date applies to new one-off tasks; editing keeps the task's own schedule.
    this.querySelector('[data-role="due-row"]').classList.toggle('hidden', !!t);
    if (t) {
      form.name.value = t.name || '';
      form.project.value = t.project || '';
      form.priority.value = t.priority || 'Medium';
      form.notes.value = t.notes || '';
    } else {
      form.dueDate.value = new Date().toLocaleDateString('en-CA');
    }
    form.classList.remove('hidden');
    form.name.focus();
  }

  closeForm() {
    this.querySelector('[data-role="form"]')?.classList.add('hidden');
    this.editingId = null;
  }

  async submitForm() {
    const form = this.querySelector('[data-role="form"]');
    const payload = {
      name: form.name.value.trim(),
      project: form.project.value.trim(),
      priority: form.priority.value,
      notes: form.notes.value.trim(),
    };
    if (!payload.name) return this.showError('Give the task a name.');
    let r;
    if (this.editingId) {
      r = await this.api(`/api/todo/tasks/${encodeURIComponent(this.editingId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } else {
      r = await this.api('/api/todo/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, type: 'scheduled', dueDate: form.dueDate.value }) });
    }
    if (!r.ok) return this.showError((r.data && r.data.error) || `Could not save task (HTTP ${r.status || 0}).`);
    this.showError(null);
    this.closeForm();
    await this.refreshAll();
  }

  render() {
    this.innerHTML = `
      <div class="w-full h-full flex flex-col p-4 bg-dark-bg/60 backdrop-blur-xl rounded-2xl border border-dark-border relative group overflow-hidden">
        
        <!-- Header -->
        <div class="flex items-center justify-between mb-4 flex-shrink-0">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center text-indigo-400">
              <i class="fa-solid fa-list-check text-sm"></i>
            </div>
            <h2 class="text-sm font-bold text-gray-200">Tasks</h2>
          </div>
          <div class="flex items-center gap-1">
            
            <!-- Config Menu Dropdown Trigger -->
            <div class="relative group/menu">
              <button class="w-6 h-6 rounded-md hover:bg-white/10 flex items-center justify-center text-gray-400 hover:text-gray-200 transition-colors">
                <i class="fa-solid fa-sliders text-[10px]"></i>
              </button>
              
              <!-- Config Dropdown -->
              <div class="absolute right-0 top-full mt-1 w-40 bg-dark-bg border border-dark-border rounded-xl shadow-2xl opacity-0 invisible group-hover/menu:opacity-100 group-hover/menu:visible transition-all z-20 flex flex-col overflow-hidden">
                <div class="px-3 py-2 text-[9px] font-bold text-gray-500 uppercase tracking-wider bg-dark-card border-b border-dark-border">Show Sections</div>
                
                <label class="flex items-center gap-2 p-2.5 hover:bg-white/5 cursor-pointer text-xs text-gray-300">
                  <input type="checkbox" ${this.config.showPastDue ? 'checked' : ''} onchange="this.closest('ada-todo').toggleConfig('showPastDue')" class="rounded border-gray-600 bg-black/50 text-indigo-500 focus:ring-indigo-500/50">
                  <span class="text-rose-400">Overdue</span>
                </label>
                
                <label class="flex items-center gap-2 p-2.5 hover:bg-white/5 cursor-pointer text-xs text-gray-300">
                  <input type="checkbox" ${this.config.showToday ? 'checked' : ''} onchange="this.closest('ada-todo').toggleConfig('showToday')" class="rounded border-gray-600 bg-black/50 text-indigo-500 focus:ring-indigo-500/50">
                  <span class="text-indigo-400">Today</span>
                </label>
                
                <label class="flex items-center gap-2 p-2.5 hover:bg-white/5 cursor-pointer text-xs text-gray-300 border-t border-white/5">
                  <input type="checkbox" ${this.config.showUpcoming ? 'checked' : ''} onchange="this.closest('ada-todo').toggleConfig('showUpcoming')" class="rounded border-gray-600 bg-black/50 text-indigo-500 focus:ring-indigo-500/50">
                  <span class="text-gray-400">Upcoming</span>
                </label>
              </div>
            </div>

            <button data-action="add" class="w-6 h-6 rounded-md bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center text-white transition-colors" title="New Task">
              <i class="fa-solid fa-plus text-[10px]"></i>
            </button>
          </div>
        </div>

        <div data-role="error" class="hidden mb-2 px-2 py-1.5 rounded-lg bg-rose-500/10 text-rose-300 text-[11px]"></div>

        <!-- Task List Content -->
        <div id="todo-content" class="flex-1 overflow-y-auto custom-scrollbar pr-1 -mr-1">
          <!-- Populated dynamically -->
        </div>

        <!-- Built-in add/edit form, used when the dashboard's full task modal isn't on the page -->
        <form data-role="form" class="hidden absolute inset-0 z-30 p-4 bg-[#121212]/95 backdrop-blur-xl flex flex-col gap-2 text-xs">
          <div class="flex items-center justify-between mb-1">
            <h3 data-role="form-title" class="text-sm font-bold text-gray-200">New task</h3>
            <button type="button" data-action="cancel" class="w-6 h-6 rounded-md hover:bg-white/10 text-gray-400" title="Cancel"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <input name="name" required placeholder="Task name" class="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-100 placeholder-gray-500">
          <div class="grid grid-cols-2 gap-2">
            <input name="project" placeholder="Project" class="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-100 placeholder-gray-500">
            <select name="priority" class="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-100">
              <option>High</option><option selected>Medium</option><option>Low</option>
            </select>
          </div>
          <label data-role="due-row" class="flex items-center gap-2 text-gray-400">Due <input name="dueDate" type="date" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-100"></label>
          <textarea name="notes" rows="2" placeholder="Notes" class="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-gray-100 placeholder-gray-500"></textarea>
          <button type="submit" class="mt-auto py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold">Save</button>
        </form>

      </div>
    `;
  }
}
customElements.define('ada-todo', TodoWidget);
