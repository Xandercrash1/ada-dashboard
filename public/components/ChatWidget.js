// ChatWidget.js — <ada-widget> : generative UI for the agent chat stream.
//
// Agents embed these tags directly in their markdown replies (raw HTML passes
// through marked untouched) and the browser upgrades them into live widgets.
// This replaces per-feature hardcoded tokens with one generic element; the
// legacy [ACTION: PROMOTE_STAGING] token remains supported in index.html for
// backward compatibility with the feedback-lifecycle automation.
//
// Types:
//   button    — invoke a registered script or any same-origin /api/ endpoint
//               attrs: label, icon, accent, confirm,
//                      script-id="X"  (POST /api/scripts/run)
//                   OR endpoint="/api/..." method="POST" payload='{"json":1}'
//   photo     — attrs: src, caption, alt
//   countdown — attrs: target (ISO timestamp), label
//   gauge     — attrs: value, max, label, unit, accent
//               optional live mode: endpoint="/api/..." path="cpu.usage" refresh="10"
//
// Lifecycle hooks (consumed by the conditional-widget layer, ticket
// fb-1787940012904): on completion/press a widget dispatches a bubbling
// 'ada-widget-event' CustomEvent with {widgetType, action, id} so future
// trigger logic can chain, hide, or remove widgets without touching this file.
//
// NOTE for agents: always close the tag explicitly (</ada-widget>). A
// self-closing <ada-widget /> does not exist in HTML and will swallow the
// rest of the message into the element.

const ACCENTS = ['indigo', 'purple', 'emerald', 'rose', 'amber', 'sky', 'cyan', 'red'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

class ChatWidget extends HTMLElement {
  connectedCallback() {
    // innerHTML is rewritten by render(); snapshot nothing from children.
    this.render();
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  attr(name, fallback = '') {
    const v = this.getAttribute(name);
    return v === null || v === '' ? fallback : v;
  }

  accent() {
    const a = this.attr('accent', 'indigo');
    return ACCENTS.includes(a) ? a : 'indigo';
  }

  emit(action, detail = {}) {
    this.dispatchEvent(new CustomEvent('ada-widget-event', {
      bubbles: true,
      detail: { widgetType: this.attr('type'), action, id: this.attr('id', null), ...detail }
    }));
  }

  render() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    const type = this.attr('type');
    if (type === 'button') this.renderButton();
    else if (type === 'photo') this.renderPhoto();
    else if (type === 'countdown') this.renderCountdown();
    else if (type === 'gauge') this.renderGauge();
    else {
      this.innerHTML = `
        <span class="inline-flex items-center gap-1.5 text-[10px] text-amber-400 border border-amber-700/50 bg-amber-950/30 rounded-lg px-2 py-1 my-1">
          <i class="fa-solid fa-puzzle-piece"></i> Unknown widget type: ${esc(type || '(none)')}
        </span>`;
    }
  }

  // --- button ---------------------------------------------------------------
  renderButton() {
    const accent = this.accent();
    const label = this.attr('label', 'Run');
    const icon = this.attr('icon', 'fa-bolt');
    this.innerHTML = `
      <div class="my-1.5">
        <button class="inline-flex items-center gap-2 bg-${accent}-600 hover:bg-${accent}-500 border border-${accent}-500 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors shadow-sm disabled:opacity-50">
          <i class="fa-solid ${esc(icon)}"></i> ${esc(label)}
        </button>
        <div data-out class="hidden mt-2 bg-black/80 border border-dark-border rounded-xl text-[11px] font-mono text-gray-300 p-3 whitespace-pre-wrap max-h-48 overflow-y-auto custom-scrollbar"></div>
      </div>`;
    this.querySelector('button').addEventListener('click', () => this.pressButton());
  }

  async pressButton() {
    const confirmText = this.attr('confirm');
    if (confirmText && !window.confirm(confirmText)) return;

    const btn = this.querySelector('button');
    const iconEl = btn.querySelector('i');
    const out = this.querySelector('[data-out]');
    const originalIcon = iconEl.className;
    iconEl.className = 'fa-solid fa-spinner fa-spin';
    btn.disabled = true;

    const scriptId = this.attr('script-id');
    let endpoint = this.attr('endpoint');
    let method = this.attr('method', 'POST').toUpperCase();
    let payload = this.attr('payload');
    if (scriptId) {
      endpoint = '/api/scripts/run';
      method = 'POST';
      payload = JSON.stringify({ id: scriptId });
    }

    try {
      // Same-origin API paths only — a widget can do exactly what page JS can
      // already do, nothing more (no external URLs, no protocol smuggling).
      if (!endpoint || !endpoint.startsWith('/api/')) {
        throw new Error('Widget endpoint must start with /api/');
      }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        throw new Error(`Unsupported method: ${method}`);
      }
      let body;
      if (payload && method !== 'GET') {
        body = JSON.stringify(JSON.parse(payload)); // validate it's real JSON
      }
      const res = await fetch(endpoint, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body
      });
      let shown = '';
      try {
        const data = await res.clone().json();
        // Script results read best as stdout/stderr; anything else as JSON.
        if (typeof data.stdout === 'string' || typeof data.stderr === 'string') {
          shown = [data.stdout, data.stderr].filter(Boolean).join('\n---\n').trim();
          if (!shown) shown = data.success === false ? 'Failed (no output)' : 'Done (no output)';
        } else {
          shown = JSON.stringify(data, null, 2);
        }
      } catch { shown = await res.text(); }
      out.textContent = shown.slice(0, 4000);
      out.classList.remove('hidden');
      if (window.showToast) window.showToast(res.ok ? 'Widget action completed' : `Action failed (HTTP ${res.status})`, res.ok ? 'success' : 'error');
      this.emit('pressed', { ok: res.ok, status: res.status });
    } catch (e) {
      out.textContent = `Error: ${e.message}`;
      out.classList.remove('hidden');
      if (window.showToast) window.showToast(e.message, 'error');
      this.emit('pressed', { ok: false, error: e.message });
    } finally {
      iconEl.className = originalIcon;
      btn.disabled = false;
    }
  }

  // --- photo ----------------------------------------------------------------
  renderPhoto() {
    const src = this.attr('src');
    // Same-origin paths or plain http(s) URLs only — never javascript:/data:.
    const safe = /^(\/|https?:\/\/)/i.test(src);
    if (!safe) {
      this.innerHTML = `<span class="text-[10px] text-red-400">Photo widget: invalid src</span>`;
      return;
    }
    const caption = this.attr('caption');
    this.innerHTML = `
      <figure class="my-1.5 max-w-sm">
        <img src="${esc(src)}" alt="${esc(this.attr('alt', caption || 'photo'))}"
             class="rounded-xl border border-dark-border shadow-sm max-h-72 object-contain bg-black/20"
             onerror="this.closest('figure').innerHTML='<span class=&quot;text-[10px] text-red-400&quot;>Image failed to load</span>'">
        ${caption ? `<figcaption class="mt-1 text-[10px] text-gray-500 italic">${esc(caption)}</figcaption>` : ''}
      </figure>`;
  }

  // --- countdown ------------------------------------------------------------
  renderCountdown() {
    const accent = this.accent();
    const label = this.attr('label', 'Countdown');
    const targetMs = Date.parse(this.attr('target'));
    if (Number.isNaN(targetMs)) {
      this.innerHTML = `<span class="text-[10px] text-red-400">Countdown widget: invalid target date</span>`;
      return;
    }
    this.innerHTML = `
      <div class="my-1.5 inline-flex items-center gap-3 bg-${accent}-950/40 border border-${accent}-800/60 rounded-xl px-4 py-2.5">
        <i class="fa-solid fa-hourglass-half text-${accent}-400"></i>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">${esc(label)}</div>
          <div data-time class="text-sm font-mono font-bold text-${accent}-300">--:--:--</div>
        </div>
      </div>`;
    const timeEl = this.querySelector('[data-time]');
    const tick = () => {
      let diff = targetMs - Date.now();
      if (diff <= 0) {
        clearInterval(this._timer);
        this._timer = null;
        timeEl.innerHTML = `<i class="fa-solid fa-check"></i> Done`;
        // Fires once; the conditional layer (ticket 2) listens for this.
        this.emit('complete');
        return;
      }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor(diff / 3600000) % 24;
      const m = Math.floor(diff / 60000) % 60;
      const s = Math.floor(diff / 1000) % 60;
      const pad = (n) => String(n).padStart(2, '0');
      timeEl.textContent = (d > 0 ? `${d}d ` : '') + `${pad(h)}:${pad(m)}:${pad(s)}`;
    };
    tick();
    if (this._timer === null && targetMs - Date.now() > 0) {
      this._timer = setInterval(tick, 1000);
    }
  }

  // --- gauge ----------------------------------------------------------------
  renderGauge() {
    const accent = this.accent();
    const label = this.attr('label', 'Gauge');
    const unit = this.attr('unit', '');
    this.innerHTML = `
      <div class="my-1.5 inline-flex items-center gap-3 bg-dark-card border border-dark-border rounded-xl px-4 py-3">
        <svg viewBox="0 0 36 20" class="w-16 h-9">
          <path d="M2 18 A 16 16 0 0 1 34 18" fill="none" stroke="currentColor" class="text-gray-700/50" stroke-width="3" stroke-linecap="round"/>
          <path data-arc d="M2 18 A 16 16 0 0 1 34 18" fill="none" stroke="currentColor" class="text-${accent}-400" stroke-width="3" stroke-linecap="round" stroke-dasharray="50.3" stroke-dashoffset="50.3"/>
        </svg>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">${esc(label)}</div>
          <div data-val class="text-sm font-mono font-bold text-${accent}-300">—</div>
        </div>
      </div>`;

    const update = (value) => {
      const max = parseFloat(this.attr('max', '100')) || 100;
      const v = Math.max(0, Math.min(parseFloat(value) || 0, max));
      const arcLen = 50.3; // half-circumference of the r=16 arc above
      this.querySelector('[data-arc]').setAttribute('stroke-dashoffset', String(arcLen * (1 - v / max)));
      this.querySelector('[data-val]').textContent = `${+v.toFixed(1)}${unit ? ' ' + unit : ''}`;
    };

    const endpoint = this.attr('endpoint');
    if (endpoint && endpoint.startsWith('/api/')) {
      const dotPath = this.attr('path');
      const pull = async () => {
        try {
          const data = await (await fetch(endpoint)).json();
          const v = dotPath ? dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), data) : data;
          if (typeof v === 'number' || typeof v === 'string') update(v);
        } catch { /* leave the last value on screen */ }
      };
      pull();
      const refresh = Math.max(3, parseInt(this.attr('refresh', '0'), 10) || 0);
      if (parseInt(this.attr('refresh', '0'), 10) > 0) this._timer = setInterval(pull, refresh * 1000);
    } else {
      update(this.attr('value', '0'));
    }
  }
}

customElements.define('ada-widget', ChatWidget);
