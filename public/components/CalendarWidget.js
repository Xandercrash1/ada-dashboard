// CalendarWidget.js — <ada-calendar> : live agenda from /api/agenda
// (Google-Calendar ICS feeds + local data/calendar.json events, merged
// server-side; fb-1788188240701). Renders the next 7 days in Eastern time.
class AdaCalendar extends HTMLElement {
  constructor() {
    super();
    this.agenda = null;
  }

  connectedCallback() {
    this.render();
    this.fetchEvents();
    this._poll = setInterval(() => this.fetchEvents(), 5 * 60 * 1000);
  }

  disconnectedCallback() {
    if (this._poll) clearInterval(this._poll);
  }

  async fetchEvents() {
    try {
      const res = await fetch('/api/agenda?days=7');
      if (res.ok) {
        this.agenda = await res.json();
        this.render();
      }
    } catch (e) {}
  }

  static get observedAttributes() { return ['theme', 'accent']; }
  attributeChangedCallback() { this.render(); }

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  dayLabel(date, todayKey, tomorrowKey) {
    const key = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (key === todayKey) return 'Today';
    if (key === tomorrowKey) return 'Tomorrow';
    return date.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  }

  render() {
    const theme = this.getAttribute('theme') || 'glass';
    const accent = this.getAttribute('accent') || 'indigo';

    const bgClass = theme === 'transparent' ? 'bg-transparent' :
                   theme === 'solid' ? 'bg-dark-card border border-dark-border' :
                   theme === 'neon' ? `bg-dark-card border border-${accent}-500/50 shadow-[0_0_15px_rgba(0,0,0,0)] shadow-${accent}-500/20` :
                   theme === 'gradient' ? `bg-gradient-to-br from-${accent}-900/40 to-dark-card border border-${accent}-500/30` :
                   `bg-dark-bg/60 backdrop-blur-xl border border-white/10`; // glass

    const TZ = 'America/New_York';
    const events = (this.agenda && this.agenda.events) || [];
    const feeds = (this.agenda && this.agenda.feeds) || [];
    const feedError = feeds.find(f => !f.ok);
    const noFeeds = this.agenda && feeds.length === 0;

    // Group by Eastern calendar day; multi-day events land on their start day.
    const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const tomorrowKey = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
    const groups = new Map();
    for (const ev of events) {
      const d = new Date(ev.startsAt);
      const key = d.toLocaleDateString('en-CA', { timeZone: TZ });
      if (!groups.has(key)) groups.set(key, { date: d, items: [] });
      groups.get(key).items.push(ev);
    }

    let html = `
      <div class="${bgClass} rounded-2xl p-4 flex flex-col h-full overflow-hidden relative group transition-all duration-300">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2 text-${accent}-400">
            <i class="fa-regular fa-calendar text-sm"></i>
            <span class="text-xs font-bold uppercase tracking-wider">Agenda</span>
          </div>
          <span class="text-[10px] text-gray-500 font-semibold" title="${feedError ? 'Feed error: ' + this.esc(feedError.error) : ''}">
            ${feedError ? `<i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1"></i>` : ''}Next 7 days
          </span>
        </div>
        <div class="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-3">
    `;

    if (!this.agenda) {
      html += `<div class="h-full flex items-center justify-center text-gray-500 text-xs opacity-60"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Loading agenda…</div>`;
    } else if (events.length === 0) {
      html += `
        <div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2 opacity-50 pt-4">
          <i class="fa-regular fa-calendar-check text-2xl"></i>
          <span class="text-xs">${noFeeds ? 'No calendar connected yet' : 'Nothing scheduled'}</span>
        </div>
      `;
    } else {
      for (const [, group] of groups) {
        html += `<div>
          <div class="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">${this.dayLabel(group.date, todayKey, tomorrowKey)}</div>
          <div class="space-y-1.5">`;
        for (const ev of group.items) {
          const time = ev.allDay ? 'All day'
            : new Date(ev.startsAt).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
          const dot = ev.source === 'local' ? 'bg-emerald-400' : `bg-${accent}-400`;
          html += `
            <div class="flex items-start gap-2.5 p-1.5 rounded-lg hover:bg-white/5 transition-colors" title="${this.esc(ev.calendar)}">
              <span class="w-1.5 h-1.5 rounded-full ${dot} mt-1.5 flex-shrink-0"></span>
              <div class="min-w-[4.2rem] text-[11px] font-bold text-white pt-0.5">${time}</div>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-semibold text-gray-200 truncate">${this.esc(ev.title)}</div>
                ${ev.location ? `<div class="text-[10px] text-gray-500 truncate mt-0.5"><i class="fa-solid fa-location-dot mr-1"></i>${this.esc(ev.location)}</div>` : ''}
              </div>
            </div>`;
        }
        html += `</div></div>`;
      }
    }

    html += `</div></div>`;
    this.innerHTML = html;
  }
}

customElements.define('ada-calendar', AdaCalendar);
