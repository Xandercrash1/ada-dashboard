// BubbleManager.js
// Manages the dynamic floating bubbles for agent chats.
class BubbleManager {
  constructor() {
    this.bubbles = {}; // sessionId -> bubble state
    this.maxBubbles = 3;
    
    // Create the container
    this.container = document.createElement('div');
    this.container.id = 'dynamic-bubbles-container';
    this.container.className = 'fixed bottom-6 right-4 z-50 flex flex-col gap-4 items-end pointer-events-none';
    document.body.appendChild(this.container);
    
    // Listen for new messages
    window.addEventListener('agentMessageReceived', (e) => this.onMessageReceived(e.detail.session));
    
    // Close bubble on outside click if it's expanded
    document.addEventListener('mousedown', (e) => this.onOutsideClick(e));
  }

  onMessageReceived(session) {
    // If the user is currently looking at this session in the Agents tab, don't show a bubble.
    if (localStorage.getItem('ada_activeTab') === 'server' && 
        localStorage.getItem('ada_activeServerSubTab') === 'agents' && 
        window.activeSessionId === session.id) {
      // Mark as read automatically since they are looking at it
      this.markAsRead(session.id, session);
      return;
    }
    
    let b = this.bubbles[session.id];
    if (b) {
      // Bubble already exists. Update it.
      this.resetTimer(session.id);
      this.updateBubbleUI(session.id, session);
    } else {
      // Create new bubble
      this.spawnBubble(session);
    }
  }
  
  markAsRead(sessionId, session) {
    if (!session || !session.messages || session.messages.length === 0) return;
    try {
      const sig = session.messages.length + '-' + session.messages[session.messages.length - 1].text.length;
      const readMap = JSON.parse(localStorage.getItem('ada_readSignatures') || '{}');
      readMap[sessionId] = sig;
      localStorage.setItem('ada_readSignatures', JSON.stringify(readMap));
    } catch(e) {}
  }
  
  spawnBubble(session) {
    // Enforce max bubbles: remove the oldest if we're at max
    const keys = Object.keys(this.bubbles);
    if (keys.length >= this.maxBubbles) {
      const oldestId = this.container.firstChild.dataset.sessionId;
      this.closeBubble(oldestId);
    }
    
    const el = document.createElement('div');
    el.className = 'pointer-events-auto flex flex-col items-end transition-all duration-300 transform translate-x-10 opacity-0';
    el.dataset.sessionId = session.id;
    this.container.appendChild(el);
    
    // Trigger animation
    requestAnimationFrame(() => {
      el.classList.remove('translate-x-10', 'opacity-0');
    });
    
    this.bubbles[session.id] = {
      el,
      session,
      expanded: false,
      timer: null
    };
    
    this.renderBubble(session.id);
    this.resetTimer(session.id);
  }
  
  closeBubble(sessionId) {
    const b = this.bubbles[sessionId];
    if (!b) return;
    
    clearTimeout(b.timer);
    
    // Animate out
    b.el.classList.add('translate-x-10', 'opacity-0');
    setTimeout(() => {
      if (b.el.parentNode) b.el.parentNode.removeChild(b.el);
      delete this.bubbles[sessionId];
    }, 300);
  }
  
  minimizeBubble(sessionId) {
    const b = this.bubbles[sessionId];
    if (!b || !b.expanded) return;
    b.expanded = false;
    this.renderBubble(sessionId);
  }
  
  expandBubble(sessionId) {
    const b = this.bubbles[sessionId];
    if (!b) return;
    b.expanded = true;
    this.markAsRead(sessionId, b.session); // Mark read when expanding
    this.renderBubble(sessionId);
    this.resetTimer(sessionId); // Activity resets timer
  }
  
  resetTimer(sessionId) {
    const b = this.bubbles[sessionId];
    if (!b) return;
    clearTimeout(b.timer);
    
    if (b.expanded) {
      b.timer = setTimeout(() => this.minimizeBubble(sessionId), 5 * 60 * 1000);
    } else {
      b.timer = setTimeout(() => this.closeBubble(sessionId), 5 * 60 * 1000);
    }
  }
  
  updateBubbleUI(sessionId, session) {
    const b = this.bubbles[sessionId];
    if (!b) return;
    b.session = session;
    this.renderBubble(sessionId);
  }
  
  renderBubble(sessionId) {
    const b = this.bubbles[sessionId];
    if (!b) return;
    
    const session = b.session;
    
    if (!b.expanded) {
      // Render minimized bubble
      b.el.innerHTML = `
        <div class="bubble-minimized cursor-pointer w-12 h-12 rounded-full bg-dark-card border border-indigo-500/50 shadow-lg shadow-indigo-900/30 flex items-center justify-center hover:bg-indigo-950 transition-colors relative" onclick="window.bubbleManager.expandBubble('${sessionId}')">
          <i class="fa-solid ${session.role === 'designer' ? 'fa-wand-magic-sparkles' : 'fa-robot'} text-indigo-400 text-lg"></i>
          <div class="absolute -top-1 -right-1 w-3.5 h-3.5 bg-rose-500 rounded-full border-2 border-dark-card"></div>
        </div>
      `;
    } else {
      // Render expanded chat window
      const msgsHtml = (session.messages || []).map(m => m.role === 'user'
        ? `<div class="flex justify-end"><div class="max-w-[85%] bg-indigo-600/80 text-white rounded-xl rounded-br-sm px-3 py-2 whitespace-pre-wrap break-words text-xs">${this.escapeHtml(m.text)}</div></div>`
        : `<div class="flex"><div class="max-w-[85%] bg-dark-bg border border-dark-border text-gray-800 dark:text-gray-200 rounded-xl rounded-bl-sm px-3 py-2 break-words prose prose-sm dark:prose-invert prose-p:leading-snug prose-pre:bg-gray-100 dark:prose-pre:bg-black/50 prose-a:text-indigo-500 marker:text-indigo-400 dark:prose-code:text-indigo-200 prose-code:text-indigo-600 text-xs">${marked.parse(m.text)}</div></div>`
      ).join('');
      
      let chipsHtml = '';
      if (session.role === 'designer') {
        chipsHtml = `
          <div class="flex items-center gap-1.5 px-3 py-2 overflow-x-auto custom-scrollbar border-b border-dark-border bg-dark-bg/50">
            <button onclick="window.bubbleManager.prefillInput('${sessionId}', 'Redesign the stats section: ')" class="designer-chip flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-dark-bg border border-dark-border text-gray-300 hover:text-white hover:border-indigo-500 transition-colors"><i class="fa-solid fa-chart-simple mr-1"></i>Stats</button>
            <button onclick="window.bubbleManager.prefillInput('${sessionId}', 'Undo your most recent change to the page document — restore it to how it was before your last edit.')" class="designer-chip flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-dark-bg border border-dark-border text-gray-300 hover:text-white hover:border-rose-500 transition-colors"><i class="fa-solid fa-rotate-left mr-1"></i>Undo</button>
            <button onclick="window.bubbleManager.prefillInput('${sessionId}', 'Look at what exists on this server (tools, scripts, TODOs, projects) and propose 2-3 new homepage widget ideas. Just propose — do not apply yet.')" class="designer-chip flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-dark-bg border border-dark-border text-gray-300 hover:text-white hover:border-emerald-500 transition-colors"><i class="fa-solid fa-lightbulb mr-1"></i>Ideas</button>
          </div>
        `;
      }
      
      b.el.innerHTML = `
        <div class="bubble-expanded w-[24rem] max-w-[calc(100vw-2rem)] bg-dark-card border border-indigo-800/60 rounded-2xl shadow-2xl shadow-indigo-950/50 flex flex-col overflow-hidden">
          <div class="flex items-center justify-between gap-2 px-4 py-3 bg-gradient-to-r from-indigo-950/60 to-purple-950/60 border-b border-dark-border cursor-pointer" onclick="window.bubbleManager.minimizeBubble('${sessionId}')">
            <div class="flex items-center gap-2 min-w-0">
              <i class="fa-solid ${session.role === 'designer' ? 'fa-wand-magic-sparkles' : 'fa-robot'} text-indigo-400"></i>
              <span class="text-sm font-bold text-white truncate">${this.escapeHtml(session.name || 'Agent')}</span>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              <button onclick="event.stopPropagation(); window.bubbleManager.openInAgentsTab('${sessionId}')" title="Open full conversation in Agents tab" class="w-6 h-6 rounded-lg text-gray-400 hover:text-white hover:bg-dark-bg text-xs flex items-center justify-center transition-colors">
                <i class="fa-solid fa-up-right-from-square"></i>
              </button>
              <button onclick="event.stopPropagation(); window.bubbleManager.closeBubble('${sessionId}')" title="Close" class="w-6 h-6 rounded-lg text-gray-400 hover:text-white hover:bg-dark-bg text-sm flex items-center justify-center transition-colors">&times;</button>
            </div>
          </div>
          
          ${chipsHtml}
          
          <div class="bubble-messages-box h-72 overflow-y-auto custom-scrollbar px-3 py-3 space-y-2 text-xs" id="bubble-msgs-${sessionId}">
            ${msgsHtml}
          </div>
          
          <form onsubmit="window.bubbleManager.submitForm(event, '${sessionId}')" class="flex items-center gap-2 p-3 border-t border-dark-border bg-dark-card">
            <input type="text" id="bubble-input-${sessionId}" placeholder="Reply to agent..." autocomplete="off" class="flex-1 bg-dark-bg border border-dark-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors">
            <button type="submit" class="w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs flex items-center justify-center transition-all flex-shrink-0">
              <i class="fa-solid fa-paper-plane"></i>
            </button>
          </form>
        </div>
      `;
      
      const box = document.getElementById(`bubble-msgs-${sessionId}`);
      if (box) box.scrollTop = box.scrollHeight;
      
      const inp = document.getElementById(`bubble-input-${sessionId}`);
      if (inp) inp.focus();
    }
  }
  
  prefillInput(sessionId, text) {
    const inp = document.getElementById(`bubble-input-${sessionId}`);
    if (inp) {
      inp.value = text;
      inp.focus();
    }
  }
  
  onOutsideClick(e) {
    // If the click is inside the dynamic-bubbles-container, ignore it
    if (this.container.contains(e.target)) return;
    
    // Otherwise minimize any expanded bubbles
    for (const sessionId of Object.keys(this.bubbles)) {
      if (this.bubbles[sessionId].expanded) {
        this.minimizeBubble(sessionId);
      }
    }
  }
  
  async submitForm(e, sessionId) {
    e.preventDefault();
    const inp = document.getElementById(`bubble-input-${sessionId}`);
    const text = inp.value.trim();
    if (!text) return;
    
    // Prefill the UI eagerly
    const session = this.bubbles[sessionId].session;
    if (session.messages) {
      session.messages.push({ role: 'user', text: text, timestamp: new Date().toISOString() });
      this.renderBubble(sessionId);
    }
    
    inp.value = '';
    this.resetTimer(sessionId);
    
    try {
      await fetch(`/api/agent/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text })
      });
      // The global poller will pick up the new message and update the UI
    } catch (err) {
      console.error('Failed to send bubble message', err);
    }
  }
  
  openInAgentsTab(sessionId) {
    this.closeBubble(sessionId);
    if (typeof window.switchTab === 'function') {
      window.switchTab('server');
      if (typeof window.switchServerSubTab === 'function') window.switchServerSubTab('agents');
      if (typeof window.loadAgentSessions === 'function') {
        window.loadAgentSessions().then(() => {
          if (typeof window.selectSession === 'function') window.selectSession(sessionId);
        });
      }
    }
  }
  
  forceBubble(sessionId) {
    if (this.bubbles[sessionId]) {
      this.expandBubble(sessionId);
    } else {
      fetch(`/api/agent/sessions/${sessionId}`)
        .then(res => res.json())
        .then(session => {
          this.spawnBubble(session);
          this.expandBubble(sessionId);
        });
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, 
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.bubbleManager = new BubbleManager();
});
