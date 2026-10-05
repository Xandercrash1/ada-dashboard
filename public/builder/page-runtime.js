// Page Builder v3 — shared page runtime. Loaded (after the Tailwind CDN) into
// both the editor canvas and the page viewer, so a page looks identical in
// each AND matches the dashboard: same Tailwind config, same theme tokens, and
// the same light/dark setting (localStorage 'ada_theme': dark | light | auto,
// shared with the dashboard because both are on the same origin).
// THEME_CSS is copied from public/index.html ("Theme tokens" .. light-theme
// remaps) — keep the two in step.
(function () {
  if (window.tailwind) {
    window.tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 50: '#eef2ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 900: '#1e1b4b' },
            dark: { bg: 'rgb(var(--bg-rgb) / <alpha-value>)', card: 'rgb(var(--card-rgb) / <alpha-value>)', border: 'var(--border)', accent: 'var(--accent)' }
          }
        }
      }
    };
  }
  const THEME_CSS = "/* Theme tokens. The Tailwind dark.* palette points at these vars. */\n    :root, [data-theme=\"dark\"] {\n      --bg: #121212; --card: #121212; --bg-rgb: 18 18 18; --card-rgb: 18 18 18; --border: rgba(255, 255, 255, 0.05); --accent: rgba(255, 255, 255, 0.08); --text: #e2e8f0;\n      --scroll-track: transparent; --scroll-thumb: rgba(255, 255, 255, 0.1);\n    }\n    [data-theme=\"light\"] {\n      --bg: #ffffff; --card: #ffffff; --bg-rgb: 255 255 255; --card-rgb: 255 255 255; --border: rgba(0, 0, 0, 0.06); --accent: rgba(0, 0, 0, 0.05); --text: #1e293b;\n      --scroll-track: transparent; --scroll-thumb: rgba(0, 0, 0, 0.15);\n    }\n    body {\n      background-color: var(--bg);\n      color: var(--text);\n      font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n      -webkit-tap-highlight-color: transparent;\n      transition: background-color .2s ease, color .2s ease;\n    }\n    .custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; }\n    .custom-scrollbar::-webkit-scrollbar-track { background: var(--scroll-track); }\n    .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 4px; }\n    /* Built-in Tailwind tokens assume a dark bg \u2014 remap the light-on-dark ones\n       for light theme. The [data-theme] prefix out-specifies a bare utility. */\n    [data-theme=\"light\"] .text-white    { color: #0f172a; }\n    [data-theme=\"light\"] .text-gray-100 { color: #1e293b; }\n    [data-theme=\"light\"] .text-gray-200 { color: #334155; }\n    [data-theme=\"light\"] .text-gray-300 { color: #475569; }\n    [data-theme=\"light\"] .text-gray-400 { color: #64748b; }\n    [data-theme=\"light\"] .text-gray-500 { color: #64748b; }\n    [data-theme=\"light\"] .text-gray-600 { color: #94a3b8; }\n    [data-theme=\"light\"] .placeholder-gray-500::placeholder { color: #94a3b8; }\n    /* Exceptions: text-white on a colored/gradient/dark element must STAY white. */\n    [data-theme=\"light\"] [class*=\"bg-indigo-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-purple-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-violet-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-rose-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-red-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-amber-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-orange-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-green-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-emerald-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-teal-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-cyan-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-blue-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-sky-\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-black\"].text-white,\n    [data-theme=\"light\"] [class*=\"bg-gradient\"].text-white { color: #ffffff; }\n    /* \u2026except bg-black/20 boxes: they're remapped to light gray below, so their\n       text must flip dark. Wins the [class*=\"bg-black\"] exception by source order. */\n    [data-theme=\"light\"] .bg-black\\/20.text-white { color: #0f172a; }\n    /* Translucent black/white utilities assume a dark page. Remap the subtle ones\n       (inputs, cards, hairline borders) so they read as light-gray on white.\n       Scrims and terminal panes (bg-black/40+) intentionally stay dark. */\n    [data-theme=\"light\"] .bg-black\\/20 { background-color: rgba(0, 0, 0, 0.045); }\n    [data-theme=\"light\"] .bg-white\\/5  { background-color: rgba(0, 0, 0, 0.03); }\n    [data-theme=\"light\"] .bg-white\\/10 { background-color: rgba(0, 0, 0, 0.05); }\n    [data-theme=\"light\"] .hover\\:bg-white\\/5:hover { background-color: rgba(0, 0, 0, 0.04); }\n    [data-theme=\"light\"] .border-white\\/5  { border-color: rgba(0, 0, 0, 0.08); }\n    [data-theme=\"light\"] .border-white\\/10 { border-color: rgba(0, 0, 0, 0.10); }\n    /* Terminal / code panes (bg-black*) intentionally stay dark in both themes. */\n    ";
  const s = document.createElement('style');
  s.textContent = THEME_CSS + `
    body { margin:0; background-color:var(--bg); color:var(--text);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }`;
  document.head.appendChild(s);

  const mql = matchMedia('(prefers-color-scheme: dark)');
  const mode = () => { try { return localStorage.getItem('ada_theme') || 'auto'; } catch (e) { return 'auto'; } };
  const apply = () => {
    const m = mode();
    const resolved = (m === 'light' || m === 'dark') ? m : (mql.matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  };
  apply();
  // Follow the dashboard live: its theme button writes localStorage (a
  // 'storage' event here), and 'auto' follows the OS.
  window.addEventListener('storage', e => { if (e.key === 'ada_theme') apply(); });
  mql.addEventListener('change', apply);
})();

// --- Dashboard services that widgets expect, for pages outside the dashboard ---
// The dashboard defines these globally; on a builder page they are provided
// here so widgets keep their feedback (Chat, Script button, Kanban, Todo).
(function () {
  let parentToast = null;
  try { parentToast = window.parent !== window && window.parent.showAppToast; } catch (e) {}
  if (parentToast && !window.showToast) {
    // Embedded in the dashboard: use its toasts so they appear in the app.
    window.showToast = (message, type) => window.parent.showAppToast(message, type);
  }
  if (!window.showToast) {
    window.showToast = function (message, type) {
      const t = document.createElement('div');
      const color = type === 'error' ? '#e11d48' : type === 'success' ? '#16a34a' : '#4f46e5';
      t.textContent = String(message || '');
      t.style.cssText = `position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;padding:10px 16px;border-radius:12px;background:${color};color:#fff;font:600 13px -apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw`;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    };
  }
  if (!window.showAppToast) window.showAppToast = window.showToast;
  if (!window.adaConfirm) window.adaConfirm = async (o) => window.confirm((o && (o.message || o.title)) || 'Are you sure?');

  // Live numbers for <span data-home-stat="…"> (the Stat box widget). The
  // dashboard mirrors these from its own counters; here they are fetched.
  const stats = {};
  const fill = () => document.querySelectorAll('[data-home-stat]').forEach(el => {
    const v = stats[el.getAttribute('data-home-stat')];
    if (v !== undefined && el.textContent !== String(v)) el.textContent = String(v);
  });
  const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json(); };
  async function system() {
    try {
      const s = await get('/api/system');
      Object.assign(stats, {
        cpu: s.cpu.load1m, cpu_5m: s.cpu.load5m, cpu_15m: s.cpu.load15m, cpu_cores: s.cpu.cores,
        ram: s.memory.usedGB, ram_percent: s.memory.percent, ram_total: s.memory.totalGB,
        disk_used: s.disk.usedGB, disk_percent: s.disk.percent, disk_free: s.disk.freeGB,
        uptime: s.uptimeFormatted, jobs: s.tmux ? s.tmux.length : 0,
      });
    } catch (e) { /* not available for this account */ }
    fill();
  }
  async function slow() {
    try { const t = await get('/api/todo'); stats.todo = (t.pastDue || []).length + (t.today || []).length; } catch (e) {}
    try {
      const f = await get('/api/feedback'); const items = Array.isArray(f) ? f : (f.items || []);
      stats.bugs = items.filter(i => i.type === 'bug' && i.status !== 'done' && i.status !== 'wont-do').length;
    } catch (e) {}
    fill();
  }
  const start = () => {
    if (!document.querySelector('[data-home-stat], ada-stat-box')) return setTimeout(start, 2000);   // only pages that show stats
    system(); slow();
    setInterval(system, 5000); setInterval(slow, 60000); setInterval(fill, 1000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
