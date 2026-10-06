/*
 * projects-tab.js — the Projects tab (One Ada, Plan — One Ada.md § 4 P2-4).
 *
 * One row per project from the vault's Projects/REGISTRY.md: "Docs" opens the
 * project's hub (projectStatus.md on top, every other document linked below);
 * "Website" appears when the registry gives the project a web page. Device-only
 * projects show where they live and have no hub. A pinned card opens the One Ada
 * start-up page (device/START.md + enrollment token + device list).
 *
 * Deep links (for Claude in Chrome and bookmarks):
 *   #projects · #projects/start · #projects/<slug> · #projects/<slug>/doc/<path>
 * Vault content is Alex's own, but raw HTML inside a document is still escaped,
 * never rendered.
 */
(function () {
  'use strict';
  const root = () => document.getElementById('projects-root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, opts) => {
    const r = await fetch(url, opts);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
    return b;
  };
  const card = 'rounded-xl border border-gray-200 dark:border-dark-border bg-white dark:bg-dark-card';
  const btn = 'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors';
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

  function md(text) {
    const r = new marked.Renderer();
    r.html = (t) => esc(typeof t === 'string' ? t : (t && (t.text || t.raw)) || '');   // never render raw HTML
    const src = String(text || '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');   // Obsidian links → text
    return marked.parse(src, { renderer: r });
  }
  const prose = 'prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-black/50 prose-a:text-indigo-500';

  function setHash(h) { if (location.hash !== h) history.replaceState(null, '', h); }
  function loading() { root().innerHTML = `<div class="text-gray-400 text-sm p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`; }
  function fail(e) { root().innerHTML = `<div class="${card} p-4 text-rose-400 text-sm">${esc(e.message)}</div><div class="mt-3"><a href="#projects" class="text-indigo-400 text-sm">← All projects</a></div>`; }
  const back = (href, label) => `<a href="${href}" class="text-indigo-400 hover:text-indigo-300 text-sm"><i class="fa-solid fa-arrow-left"></i> ${esc(label)}</a>`;

  // ------------------------------------------------------------ list
  async function showList() {
    setHash('#projects'); loading();
    let rows;
    try { rows = await api('/api/projects'); } catch (e) { return fail(e); }
    const row = (p) => {
      const onlyDevice = !/repo/i.test(p.home);   // "device:x (live) · repo (snapshot)" is not device-only
      const where = /^repo/i.test(p.home) ? '' : `<span class="text-xs px-2 py-0.5 rounded-full bg-amber-950 text-amber-300 border border-amber-800">${esc(p.home.replace(/device:/g, 'on '))}${onlyDevice ? ' only' : ''}</span>`;
      const needs = p.requires ? `<span class="text-xs text-gray-400">needs ${esc(p.requires)}</span>` : '';
      const docs = p.hasHub ? `<a href="#projects/${esc(p.slug)}" class="${btn} bg-indigo-600 hover:bg-indigo-500 text-white"><i class="fa-solid fa-folder-open"></i> Docs</a>` : '';
      const web = p.web ? `<a href="${esc(p.web)}" target="_blank" rel="noopener" class="${btn} bg-gray-700 hover:bg-gray-600 text-white"><i class="fa-solid fa-arrow-up-right-from-square"></i> Website</a>` : '';
      return `<div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 dark:border-dark-border last:border-0">
        <div class="min-w-0"><div class="font-medium text-gray-900 dark:text-gray-100 truncate">${esc(p.name)}</div>
        <div class="flex gap-2 items-center mt-0.5">${where}${needs}${p.deviceOnly ? `<span class="text-xs text-gray-400">device-only parts: ${esc(p.deviceOnly)}</span>` : ''}</div></div>
        <div class="flex gap-2 flex-shrink-0">${docs}${web}</div></div>`;
    };
    root().innerHTML = `
      <div class="flex items-center justify-between"><h2 class="text-xl font-semibold text-gray-900 dark:text-white"><i class="fa-solid fa-diagram-project text-indigo-400"></i> Projects</h2>
        <span class="text-xs text-gray-400">${rows.length} projects · from the vault's Projects/REGISTRY.md</span></div>
      <a href="#projects/start" class="block ${card} p-4 hover:border-indigo-500 transition-colors">
        <div class="font-semibold text-gray-900 dark:text-white"><i class="fa-solid fa-plug text-indigo-400"></i> One Ada — Start</div>
        <div class="text-sm text-gray-400 mt-1">Join a new machine to Ada: setup instructions, enrollment token, approved devices.</div></a>
      <div class="${card} overflow-hidden">${rows.map(row).join('') || '<div class="p-4 text-gray-400 text-sm">No projects in the registry.</div>'}</div>`;
  }

  // ------------------------------------------------------------ hub
  async function showHub(slug) {
    setHash(`#projects/${slug}`); loading();
    let h;
    try { h = await api(`/api/projects/${encodeURIComponent(slug)}`); } catch (e) { return fail(e); }
    const groups = {};
    for (const d of h.docs) { const g = d.rel.includes('/') ? d.rel.slice(0, d.rel.lastIndexOf('/')) : ''; (groups[g] = groups[g] || []).push(d); }
    const docLink = (d) => d.viewable
      ? `<a href="#projects/${esc(slug)}/doc/${encodeURIComponent(d.rel)}" class="text-indigo-400 hover:text-indigo-300">${esc(d.title)}</a>`
      : `<span class="text-gray-400" title="Not viewable here">${esc(d.rel.split('/').pop())}</span>`;
    const lists = Object.keys(groups).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))).map((g) => `
      <div class="mt-3">${g ? `<div class="text-xs uppercase tracking-wide text-gray-400 mb-1"><i class="fa-regular fa-folder"></i> ${esc(g)}</div>` : ''}
      <ul class="space-y-1 text-sm">${groups[g].map((d) => `<li class="flex justify-between gap-3"><span class="truncate">${docLink(d)}</span><span class="text-xs text-gray-500 flex-shrink-0">${esc(fmtDate(d.mtime))}</span></li>`).join('')}</ul></div>`).join('');
    root().innerHTML = `
      ${back('#projects', 'All projects')}
      <div class="flex items-center justify-between gap-3"><h2 class="text-xl font-semibold text-gray-900 dark:text-white">${esc(h.name)}</h2>
        ${h.web ? `<a href="${esc(h.web)}" target="_blank" rel="noopener" class="${btn} bg-gray-700 hover:bg-gray-600 text-white"><i class="fa-solid fa-arrow-up-right-from-square"></i> Website</a>` : ''}</div>
      <div class="${card} p-5"><div class="text-xs uppercase tracking-wide text-gray-400 mb-2">Project status</div>
        <div class="${prose}">${h.statusMd ? md(h.statusMd) : '<p class="text-gray-400">No projectStatus.md yet.</p>'}</div></div>
      <div class="${card} p-5"><div class="flex items-center justify-between"><div class="text-xs uppercase tracking-wide text-gray-400">Pages (${(h.pages || []).length})</div>
        <button id="pj-new-page" class="${btn} bg-indigo-600 hover:bg-indigo-500 text-white"><i class="fa-solid fa-plus"></i> New project page</button></div>
        ${(h.pages || []).length ? `<ul class="mt-2 space-y-1 text-sm">${h.pages.map((pg) => `<li><a href="#" data-open-page="${esc(pg.id)}" class="text-indigo-400 hover:text-indigo-300"><i class="fa-solid ${esc(/^fa-[a-z0-9-]+$/.test(pg.icon || '') ? pg.icon : 'fa-file')}"></i> ${esc(pg.title)}</a></li>`).join('')}</ul>`
          : '<p class="text-gray-400 text-sm mt-2">No dashboard pages yet. New docs for this project can be built as pages here.</p>'}
        <div id="pj-msg" class="text-sm text-gray-400 mt-2"></div></div>
      <div class="${card} p-5"><div class="text-xs uppercase tracking-wide text-gray-400">Documents (${h.docs.length})</div>${lists || '<p class="text-gray-400 text-sm mt-2">No other documents.</p>'}</div>`;
    root().querySelectorAll('[data-open-page]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openPage(a.dataset.openPage); }; });
    document.getElementById('pj-new-page').onclick = () => createProjectPage(h).catch((e) => { document.getElementById('pj-msg').textContent = e.message; });
  }

  // ------------------------------------------------------------ project pages
  // A project page is a normal dashboard page tagged with `project`: no top-bar tab, listed on the hub.
  // It starts with a short intro linking back here; status and docs stay in the vault (one home each).
  async function openPage(id) {
    if (typeof loadCustomPages === 'function' && !(window.customPages || []).some?.((p) => p.id === id)) { try { await loadCustomPages(); } catch {} }
    if (typeof switchTab === 'function') switchTab(id);
  }
  async function createProjectPage(h) {
    let id = ('proj-' + h.slug).slice(0, 64).replace(/-+$/, '');
    const taken = new Set(((await api('/api/pages')).pages || []).map((p) => p.id));
    for (let i = 2; taken.has(id); i++) id = ('proj-' + h.slug).slice(0, 60).replace(/-+$/, '') + '-' + i;
    await api('/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, title: h.name, icon: 'fa-diagram-project', project: h.slug }) });
    const intro = `<p>Dashboard page for <strong>${esc(h.name)}</strong>. Build new, interactive docs and tools for this project here.</p>`
      + `<p><a href="#projects/${esc(h.slug)}" class="text-indigo-400 hover:text-indigo-300 underline">Status &amp; documents → ${esc(h.name)} hub</a></p>`;
    await api(`/api/pages/${id}/content`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ widgets: [{ id: 'project-intro', title: 'About this page', icon: 'fa-circle-info', html: intro }] }) });
    if (typeof loadCustomPages === 'function') await loadCustomPages();
    return openPage(id);
  }

  // ------------------------------------------------------------ doc
  async function showDoc(slug, rel) {
    setHash(`#projects/${slug}/doc/${encodeURIComponent(rel)}`); loading();
    let d;
    try { d = await api(`/api/projects/${encodeURIComponent(slug)}/doc?p=${encodeURIComponent(rel)}`); } catch (e) { return fail(e); }
    root().innerHTML = `${back(`#projects/${slug}`, d.project)}
      <div class="${card} p-5"><div class="flex justify-between text-xs text-gray-400 mb-3"><span>${esc(d.rel)}</span><span>${esc(fmtDate(d.mtime))}</span></div>
      <article class="${prose}">${md(d.md)}</article></div>`;
    // relative links between docs open in the hub
    const dir = d.rel.includes('/') ? d.rel.slice(0, d.rel.lastIndexOf('/') + 1) : '';
    root().querySelectorAll('article a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:|#)/i.test(href)) { if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; } return; }
      const parts = (dir + decodeURIComponent(href.split('#')[0])).split('/'), out = [];
      for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
      a.setAttribute('href', `#projects/${slug}/doc/${encodeURIComponent(out.join('/'))}`);
    });
  }

  // ------------------------------------------------------------ One Ada start
  let lastToken = null;
  async function showStart() {
    setHash('#projects/start'); loading();
    let s, devs = [];
    try { s = await api('/api/one-ada/start'); } catch (e) { s = { md: `**${e.message}**`, mtime: null }; }
    try { devs = await api('/api/devices'); } catch {}
    const devRow = (d) => `<tr class="border-b border-gray-100 dark:border-dark-border last:border-0">
      <td class="py-2 pr-3 font-medium">${esc(d.hostname)}</td><td class="py-2 pr-3"><span class="text-xs px-2 py-0.5 rounded-full ${d.status === 'approved' ? 'bg-emerald-950 text-emerald-300' : d.status === 'pending' ? 'bg-amber-950 text-amber-300' : 'bg-gray-800 text-gray-400'}">${esc(d.status)}</span></td>
      <td class="py-2 pr-3 text-xs text-gray-400 font-mono break-all">${esc(d.fingerprint)}</td><td class="py-2 pr-3 text-xs text-gray-400">${esc(fmtDate(d.decidedAt || d.requestedAt))}</td>
      <td class="py-2 text-right">${d.status === 'approved' ? `<button data-revoke="${esc(d.id)}" class="${btn} bg-gray-700 hover:bg-rose-700 text-white">Revoke</button>`
        : d.status === 'pending' ? `<a href="/devices/confirm/${esc(d.id)}" class="${btn} bg-indigo-600 text-white">Review</a>` : ''}</td></tr>`;
    root().innerHTML = `
      ${back('#projects', 'All projects')}
      <h2 class="text-xl font-semibold text-gray-900 dark:text-white"><i class="fa-solid fa-plug text-indigo-400"></i> One Ada — Start</h2>
      <div class="${card} p-5 space-y-3">
        <div class="text-sm text-gray-500 dark:text-gray-300">Step 8 of the instructions needs a single-use enrollment token (valid 30 minutes).</div>
        <div class="flex flex-wrap gap-2">
          <button id="oa-token" class="${btn} bg-indigo-600 hover:bg-indigo-500 text-white"><i class="fa-solid fa-key"></i> Generate enrollment token</button>
          <button id="oa-copy" class="${btn} bg-gray-700 hover:bg-gray-600 text-white"><i class="fa-regular fa-copy"></i> Copy setup prompt</button>
        </div>
        <div id="oa-token-out" class="${lastToken ? '' : 'hidden'}"><div class="text-xs text-gray-400">Enrollment token</div>
          <pre id="enrollment-token" class="bg-gray-100 dark:bg-black/50 rounded-lg p-3 text-sm font-mono break-all whitespace-pre-wrap">${lastToken ? esc(lastToken.token) : ''}</pre>
          <div id="oa-token-exp" class="text-xs text-gray-400">${lastToken ? 'Expires ' + esc(fmtDate(lastToken.expiresAt)) + ' · single use' : ''}</div></div>
        <div id="oa-msg" class="text-sm text-gray-400"></div>
      </div>
      <div class="${card} p-5"><div class="text-xs uppercase tracking-wide text-gray-400 mb-2">Devices</div>
        ${devs.length ? `<table class="w-full text-sm"><tbody>${devs.slice().reverse().map(devRow).join('')}</tbody></table>` : '<p class="text-sm text-gray-400">No devices have enrolled yet.</p>'}</div>
      <div class="${card} p-5"><div class="flex justify-between text-xs text-gray-400 mb-3"><span>device/START.md (from the vault)</span><span>${esc(fmtDate(s.mtime))}</span></div>
        <article id="one-ada-start-instructions" class="${prose}">${md(s.md)}</article></div>`;

    const msg = (t) => { document.getElementById('oa-msg').textContent = t; };
    document.getElementById('oa-token').onclick = async () => {
      try {
        lastToken = await api('/api/devices/enroll-token', { method: 'POST', headers: { 'X-Device-Confirm': '1' } });
        document.getElementById('enrollment-token').textContent = lastToken.token;
        document.getElementById('oa-token-exp').textContent = `Expires ${fmtDate(lastToken.expiresAt)} · single use`;
        document.getElementById('oa-token-out').classList.remove('hidden');
        msg('');
      } catch (e) { msg(e.message); }
    };
    document.getElementById('oa-copy').onclick = async () => {
      const tok = lastToken ? `\nEnrollment token for step 8 (single use, expires ${fmtDate(lastToken.expiresAt)}): ${lastToken.token}\n` : '\n(No enrollment token yet: generate one on the page when you reach step 8.)\n';
      const text = `You are setting up this machine to join Ada, Alex's assistant. Follow these instructions exactly, one step at a time. Stop and ask me whenever they say ALEX.\n${tok}\n---\n\n${s.md}`;
      try { await navigator.clipboard.writeText(text); msg('Setup prompt copied. Paste it into Claude on the new machine.'); }
      catch { msg('Copy failed: select the instructions below manually.'); }
    };
    root().querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Confirm revoke'; b.classList.add('bg-rose-700'); return; }   // two clicks, no browser dialog
        try { await api(`/api/devices/${b.dataset.revoke}/revoke`, { method: 'POST', headers: { 'X-Device-Confirm': '1' } }); showStart(); }
        catch (e) { msg(e.message); }
      };
    });
  }

  // ------------------------------------------------------------ routing
  function route() {
    const h = decodeURIComponent((location.hash || '').replace(/^#projects\/?/, ''));
    if (!location.hash.startsWith('#projects')) return showList();
    if (!h) return showList();
    if (h === 'start') return showStart();
    const m = /^([a-z0-9-]+)(?:\/doc\/(.+))?$/.exec(h);
    if (!m) return showList();
    return m[2] ? showDoc(m[1], m[2]) : showHub(m[1]);
  }

  window.AdaProjects = { show: route };
  // Page canvases swallow link clicks inside widgets, so a "#projects/…" link on a project page did
  // nothing. Catch those clicks first (capture phase) and route them here.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href^="#projects"]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); e.stopPropagation();
    history.replaceState(null, '', a.getAttribute('href'));
    if (typeof currentTab !== 'undefined' && currentTab !== 'projects' && typeof switchTab === 'function') switchTab('projects');
    else route();
  }, true);
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#projects')) return;
    if (typeof currentTab !== 'undefined' && currentTab !== 'projects' && typeof switchTab === 'function') switchTab('projects');
    else route();
  });
})();
