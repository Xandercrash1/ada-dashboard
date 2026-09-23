class KanbanWidget extends HTMLElement {
  constructor() {
    super();
    this.board = { columns: [] };
    this.widgetId = '';
  }

  connectedCallback() {
    this.classList.add("block", "w-full", "h-full");
    this.widgetId = this.closest('.widget-container')?.id?.replace('-container', '') || this.getAttribute('data-widget-id') || 'default-board';
    this.render();
    this.fetchData();
  }

  static get observedAttributes() { return ['theme', 'accent']; }
  attributeChangedCallback() { this.render(); }

  async fetchData() {
    try {
      const res = await fetch(`/api/kanban/${this.widgetId}`);
      if (res.ok) {
        this.board = await res.json();
        this.updateView();
      }
    } catch (e) {
      console.error("Failed to load kanban data", e);
    }
  }

  async saveBoard() {
    try {
      await fetch(`/api/kanban/${this.widgetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.board)
      });
    } catch (e) {
      console.error("Failed to save kanban data", e);
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  addTask(colId) {
    const title = prompt('Task title:');
    if (!title || !title.trim()) return;
    
    const col = this.board.columns.find(c => c.id === colId);
    if (!col) return;
    
    col.tasks.push({
      id: 'task-' + Date.now(),
      title: title.trim()
    });
    
    this.updateView();
    this.saveBoard();
  }

  async deleteTask(colId, taskId) {
    const ok = window.adaConfirm
      ? await window.adaConfirm({ title: 'Delete task', message: 'Delete this task?', confirmLabel: 'Delete', danger: true })
      : window.confirm('Delete this task?');
    if (!ok) return;
    const col = this.board.columns.find(c => c.id === colId);
    if (!col) return;
    
    col.tasks = col.tasks.filter(t => t.id !== taskId);
    this.updateView();
    this.saveBoard();
  }

  handleDragStart(e, taskId, colId) {
    e.dataTransfer.setData('application/json', JSON.stringify({ taskId, colId }));
    e.target.style.opacity = '0.4';
  }

  handleDragEnd(e) {
    e.target.style.opacity = '1';
    this.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('bg-black/10', 'dark:bg-white/5'));
  }

  handleDragOver(e) {
    e.preventDefault();
    const colEl = e.target.closest('.kanban-column');
    if (colEl) colEl.classList.add('bg-black/10', 'dark:bg-white/5');
  }

  handleDragLeave(e) {
    const colEl = e.target.closest('.kanban-column');
    if (colEl) colEl.classList.remove('bg-black/10', 'dark:bg-white/5');
  }

  handleDrop(e, targetColId) {
    e.preventDefault();
    this.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('bg-black/10', 'dark:bg-white/5'));
    
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      const { taskId, colId: sourceColId } = data;
      
      if (sourceColId === targetColId) return;
      
      const sourceCol = this.board.columns.find(c => c.id === sourceColId);
      const targetCol = this.board.columns.find(c => c.id === targetColId);
      
      if (!sourceCol || !targetCol) return;
      
      const taskIndex = sourceCol.tasks.findIndex(t => t.id === taskId);
      if (taskIndex === -1) return;
      
      const [task] = sourceCol.tasks.splice(taskIndex, 1);
      targetCol.tasks.push(task);
      
      this.updateView();
      this.saveBoard();
    } catch (err) {}
  }

  updateView() {
    const content = this.querySelector('#kanban-content');
    if (!content) return;
    
    if (!this.board || !this.board.columns || this.board.columns.length === 0) {
      content.innerHTML = `<div class="w-full h-full flex flex-col items-center justify-center text-gray-500 opacity-60"><i class="fa-solid fa-circle-notch fa-spin text-xl mb-2"></i>Loading Board...</div>`;
      return;
    }

    const accent = this.getAttribute('accent') || 'indigo';

    let html = `<div class="flex h-full gap-4 overflow-x-auto pb-2 custom-scrollbar">`;
    
    for (const col of this.board.columns) {
      html += `
        <div class="flex-shrink-0 w-64 flex flex-col bg-gray-100/50 dark:bg-black/20 rounded-xl border border-gray-200/50 dark:border-white/5 kanban-column transition-colors duration-200"
             ondragover="this.closest('ada-kanban').handleDragOver(event)"
             ondragleave="this.closest('ada-kanban').handleDragLeave(event)"
             ondrop="this.closest('ada-kanban').handleDrop(event, '${col.id}')">
          
          <div class="p-3 flex items-center justify-between border-b border-gray-200/50 dark:border-white/5 font-semibold text-gray-700 dark:text-gray-300 text-sm">
            <span>${this.escapeHtml(col.title)}</span>
            <span class="bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-400 text-[10px] px-1.5 py-0.5 rounded-full">${col.tasks.length}</span>
          </div>
          
          <div class="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar min-h-[100px]">
            ${col.tasks.map(task => `
              <div draggable="true"
                   ondragstart="this.closest('ada-kanban').handleDragStart(event, '${task.id}', '${col.id}')"
                   ondragend="this.closest('ada-kanban').handleDragEnd(event)"
                   class="bg-white dark:bg-dark-card border border-gray-200 dark:border-dark-border p-3 rounded-lg shadow-sm cursor-grab active:cursor-grabbing hover:border-${accent}-400 dark:hover:border-${accent}-500 transition-colors group relative">
                
                <div class="text-xs text-gray-800 dark:text-gray-200 pr-4">${this.escapeHtml(task.title)}</div>
                
                <button onclick="this.closest('ada-kanban').deleteTask('${col.id}', '${task.id}')" class="absolute top-2 right-2 text-gray-400 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity">
                  <i class="fa-solid fa-xmark text-xs"></i>
                </button>
              </div>
            `).join('')}
          </div>
          
          <div class="p-2 border-t border-gray-200/50 dark:border-white/5">
            <button onclick="this.closest('ada-kanban').addTask('${col.id}')" class="w-full py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors flex items-center justify-center gap-1">
              <i class="fa-solid fa-plus"></i> Add task
            </button>
          </div>
        </div>
      `;
    }
    
    html += `</div>`;
    content.innerHTML = html;
  }

  render() {
    const theme = this.getAttribute('theme') || 'glass';
    const accent = this.getAttribute('accent') || 'indigo';

    const bgClass = theme === 'transparent' ? 'bg-transparent' : 
                   theme === 'solid' ? 'bg-white dark:bg-dark-card border border-gray-200 dark:border-dark-border' :
                   theme === 'neon' ? `bg-white dark:bg-dark-card border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/20` :
                   theme === 'gradient' ? `bg-gradient-to-br from-${accent}-50/90 to-white dark:from-${accent}-900/40 dark:to-dark-card border border-${accent}-200 dark:border-${accent}-500/30` :
                   `bg-gray-50/80 dark:bg-dark-bg/60 backdrop-blur-xl border border-gray-200 dark:border-dark-border shadow-sm`; 

    this.innerHTML = `
      <div class="${bgClass} rounded-2xl p-4 flex flex-col h-full transition-all duration-300">
        
        <!-- Header -->
        <div class="flex items-center justify-between mb-4 flex-shrink-0">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-${accent}-100 dark:bg-${accent}-500/20 flex items-center justify-center text-${accent}-600 dark:text-${accent}-400">
              <i class="fa-solid fa-table-columns text-sm"></i>
            </div>
            <h2 class="text-sm font-bold text-gray-900 dark:text-gray-200 tracking-wide">Kanban Board</h2>
          </div>
        </div>

        <!-- Kanban Board Content -->
        <div id="kanban-content" class="flex-1 overflow-hidden">
           <div class="w-full h-full flex flex-col items-center justify-center text-gray-500 opacity-60"><i class="fa-solid fa-circle-notch fa-spin text-xl mb-2"></i>Loading Board...</div>
        </div>
      </div>
    `;
  }
}

customElements.define('ada-kanban', KanbanWidget);
