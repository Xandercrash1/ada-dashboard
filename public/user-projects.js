/*
 * user-projects.js — the "New project" button on the Projects tab and the splash pages and
 * documents it makes (server side: src/user-projects.js). Text is edited in place and saves itself.
 * A site Ada builds shows in a sandboxed frame: the server's CSP keeps it away from the dashboard.
 * Deep link: #projects/mine/<id>.
 */
(function () {
  'use strict';
  const card = 'rounded-xl border border-gray-200 dark:border-dark-border bg-white dark:bg-dark-card';
  const btnBase = 'px-3 py-2 rounded-lg text-sm font-medium transition-colors';
  const primary = `${btnBase} bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50`;
  const quiet = `${btnBase} border border-gray-300 dark:border-dark-border text-gray-700 dark:text-gray-200 hover:border-indigo-500 disabled:opacity-50`;
  const input = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-dark-border bg-white dark:bg-black/20 text-gray-900 dark:text-gray-100';
  const note = 'text-sm text-gray-500 dark:text-gray-400';

  const pendingDrafts = new Map();   // project id -> description, drafted when its page opens

  async function api(url, method, body) {
    const r = await fetch(url, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || 'That didn\'t work. Try again.');
    return b;
  }
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { if (k === 'class') e.className = v; else if (k === 'data') Object.assign(e.dataset, v); else e[k] = v; });
    kids.forEach((k) => { if (k != null) e.append(k); });
    return e;
  }
  const readFile = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
  const imageUrl = (p) => `/api/user-projects/${encodeURIComponent(p.id)}/image?v=${encodeURIComponent(p.updatedAt)}`;

  // ------------------------------------------------------------ new project box
  let dialog;
  let dialogProject = null;
  function buildDialog() {
    dialog = el('dialog', { id: 'up-dialog', class: `${card} p-5 text-gray-900 dark:text-gray-100 w-[min(30rem,calc(100vw-32px))]` });
    dialog.innerHTML = `
      <form id="up-form" method="dialog" class="grid gap-4">
        <h3 id="up-title" class="text-lg font-semibold">New project</h3>
        <div class="grid gap-1"><label for="up-name" class="${note}">Name</label><input id="up-name" class="${input}" maxlength="120" autocomplete="off"></div>
        <fieldset class="grid gap-2"><legend class="${note} mb-2">Start with</legend>
          <label class="flex gap-3 p-3 rounded-lg border border-gray-300 dark:border-dark-border cursor-pointer"><input type="radio" name="up-kind" id="up-kind-splash" value="splash" checked class="mt-1"><span><span class="block font-medium">Splash page</span><span class="${note}">A website built from your description, with its own tabs and design.</span></span></label>
          <label class="flex gap-3 p-3 rounded-lg border border-gray-300 dark:border-dark-border cursor-pointer"><input type="radio" name="up-kind" id="up-kind-doc" value="doc" class="mt-1"><span><span class="block font-medium">Document</span><span class="${note}">One page you can start writing in.</span></span></label>
        </fieldset>
        <div id="up-splash-fields" class="grid gap-4">
          <div class="grid gap-1"><label for="up-about" class="${note}">What should it do? The more detail, the better. Needed only if Ada builds it.</label><textarea id="up-about" class="${input}" rows="4" maxlength="4000" placeholder="Example: A site for our backyard garden. What to plant when, whose turn it is to water (Sam on weekends, Jo the rest), and a harvest log."></textarea></div>
          <div class="grid gap-1"><label for="up-photo" class="${note}">Add a photo, if you have one</label><input id="up-photo" type="file" accept="image/*" class="${note}"></div>
        </div>
        <p class="${note}">Only you can see it until you share it.</p>
        <p id="up-error" class="text-sm text-rose-500" role="alert" hidden></p>
        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" id="up-cancel" class="${quiet}">Cancel</button>
          <button type="button" id="up-blank" class="${quiet}">Start blank</button>
          <button type="submit" id="up-create" class="${primary}">Build it for me</button>
        </div>
      </form>`;
    document.body.append(el('style', { textContent: '#up-dialog [hidden] { display: none !important; } #up-dialog::backdrop { background: rgba(0, 0, 0, .5); }' }));
    document.body.append(dialog);
    const q = (s) => dialog.querySelector(s);
    const sync = () => {
      const doc = q('#up-kind-doc').checked;
      q('#up-splash-fields').hidden = doc;
      q('#up-blank').hidden = doc;
      q('#up-create').textContent = doc ? 'Create document' : 'Build it for me';
    };
    q('#up-kind-splash').onchange = sync;
    q('#up-kind-doc').onchange = sync;
    q('#up-cancel').onclick = () => dialog.close();
    q('#up-blank').onclick = () => createFromDialog(false);
    q('#up-form').addEventListener('submit', (e) => { e.preventDefault(); createFromDialog(true); });
    dialog.sync = sync;
  }
  function openNew(project) {
    if (!dialog) buildDialog();
    dialogProject = project || null;
    dialog.querySelector('#up-title').textContent = project ? `New page for ${project.name}` : 'New project';
    dialog.querySelector('#up-form').reset();
    dialog.querySelector('#up-error').hidden = true;
    dialog.sync();
    dialog.showModal();
    dialog.querySelector('#up-name').focus();
  }
  async function createFromDialog(wantDraft) {
    const q = (s) => dialog.querySelector(s);
    const say = (m) => { q('#up-error').textContent = m; q('#up-error').hidden = false; };
    const name = q('#up-name').value.trim();
    const kind = q('#up-kind-doc').checked ? 'doc' : 'splash';
    const about = q('#up-about').value.trim();
    if (!name) { say('Give the project a name.'); q('#up-name').focus(); return; }
    if (kind === 'splash' && wantDraft && !about) { say('Tell Ada what it should do, or choose Start blank.'); q('#up-about').focus(); return; }
    q('#up-create').disabled = q('#up-blank').disabled = true;
    try {
      const p = await api('/api/user-projects', 'POST', { name, kind, text: kind === 'splash' ? about : '', ...(dialogProject ? { project: dialogProject.slug } : {}) });
      const photo = q('#up-photo').files[0];
      let photoError = '';
      if (kind === 'splash' && photo) {
        try { await api(`/api/user-projects/${p.id}/image`, 'POST', { base64: await readFile(photo) }); }
        catch (e) { photoError = e.message; }
      }
      if (kind === 'splash' && wantDraft) pendingDrafts.set(p.id, about);
      if (photoError) sessionStorage.setItem('up-photo-error', photoError);
      dialog.close();
      location.hash = `#projects/mine/${p.id}`;
    } catch (e) { say(e.message); }
    finally { q('#up-create').disabled = q('#up-blank').disabled = false; }
  }

  // ------------------------------------------------------------ list
  async function renderList(host) {
    const add = el('button', { type: 'button', id: 'up-new', class: primary }, 'New project');
    add.onclick = () => openNew();
    const body = el('div', { class: 'grid gap-5' });
    host.replaceChildren(el('div', { class: 'grid gap-3' }, el('div', null, add), body));
    let all;
    try { all = await api('/api/user-projects'); }
    catch (e) { body.replaceChildren(el('p', { class: 'text-sm text-rose-500' }, e.message)); return; }
    const row = (p) => {
      const kind = p.kind === 'splash' ? 'Splash page' : 'Document';
      const who = p.mine ? (p.share ? 'Shared with everyone' : 'Only you') : `Shared by ${p.owner}`;
      return el('a', { href: `#projects/mine/${encodeURIComponent(p.id)}`, class: 'block px-4 py-3 border-b border-gray-100 dark:border-dark-border last:border-0 hover:bg-gray-50 dark:hover:bg-white/5' },
        el('div', { class: 'font-medium text-gray-900 dark:text-gray-100 break-words' }, p.name),
        el('div', { class: 'text-xs text-gray-400 mt-0.5' }, `${kind} · ${who}`));
    };
    const group = (title, list) => el('div', { class: 'grid gap-2' },
      el('h3', { class: 'text-xs uppercase tracking-wide text-gray-400' }, title),
      el('div', { class: `${card} overflow-hidden` }, ...list.map(row)));
    const mine = all.filter((p) => p.mine && !p.project);   // pages of a vault project are listed on its hub
    const shared = all.filter((p) => !p.mine);
    const parts = [];
    if (mine.length) parts.push(group('Your projects', mine));
    else parts.push(el('p', { class: note }, 'Nothing here yet. Choose New project to make your first one.'));
    if (shared.length) parts.push(group('Shared with you', shared));
    body.replaceChildren(...parts);
  }

  // ------------------------------------------------------------ one project
  async function show(root, id) {
    root.innerHTML = '<div class="text-gray-400 text-sm p-4"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
    let p;
    try { p = await api(`/api/user-projects/${encodeURIComponent(id)}`); }
    catch (e) {
      root.replaceChildren(el('div', { class: `${card} p-4 text-rose-400 text-sm` }, e.message), el('a', { href: '#projects', class: 'text-indigo-400 text-sm' }, '← All projects'));
      return;
    }
    activeFrame = null;
    const page = el('div', { class: 'grid gap-5' });
    const state = { p, saveTimer: null, undo: null, flash: sessionStorage.getItem('up-photo-error') || '' };
    sessionStorage.removeItem('up-photo-error');
    root.replaceChildren(el('a', { href: p.project ? `#projects/${encodeURIComponent(p.project)}` : '#projects', class: 'text-indigo-400 hover:text-indigo-300 text-sm' }, el('i', { class: 'fa-solid fa-arrow-left' }), p.project ? ` ${p.projectName}` : ' All projects'), page);
    draw(page, state);
    if (pendingDrafts.has(id)) {
      const about = pendingDrafts.get(id);
      pendingDrafts.delete(id);
      runAda(page, state, `/api/user-projects/${id}/draft`, { about });
    } else if (p.job && p.job.state === 'writing') { state.busy = true; draw(page, state); poll(page, state); }
    else if (p.job) { state.flash = p.job.error; draw(page, state); }
  }

  function setSaved(state, msg, bad) {
    if (!state.saved) return;
    state.saved.textContent = msg;
    state.saved.className = `text-xs ${bad ? 'text-rose-500' : 'text-gray-400'}`;
  }
  function saveSoon(state, fields) {
    Object.assign(state.p, fields);
    state.dirty = Object.assign(state.dirty || {}, fields);
    setSaved(state, 'Saving…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => flush(state), 700);
  }
  async function flush(state) {
    clearTimeout(state.saveTimer);
    const fields = state.dirty;
    if (!fields) return;
    state.dirty = null;
    try { const fresh = await api(`/api/user-projects/${state.p.id}`, 'PATCH', fields); state.p.updatedAt = fresh.updatedAt; setSaved(state, 'Saved'); }
    catch (e) { state.dirty = Object.assign(fields, state.dirty || {}); setSaved(state, `Not saved: ${e.message}`, true); }
  }
  // Text pasted from elsewhere comes in as plain text, so a page keeps one look.
  function plainPaste(e) {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  }
  function editable(tag, cls, value, hint, onChange, canEdit, id) {
    const e = el(tag, { class: `${cls} empty:before:content-[attr(data-hint)] empty:before:text-gray-400 outline-none rounded hover:outline-1 focus:ring-2 focus:ring-indigo-500 break-words`, textContent: value, data: { hint } });
    if (id) e.id = id;
    if (canEdit) {
      e.contentEditable = 'true';
      e.setAttribute('role', 'textbox');
      e.setAttribute('aria-label', hint);
      e.addEventListener('paste', plainPaste);
      e.addEventListener('input', () => onChange(e.textContent));
    }
    return e;
  }

  async function runAda(page, state, url, body) {
    await flush(state);
    state.flash = '';
    state.busy = true;
    draw(page, state);
    try { state.p = await api(url, 'POST', body); poll(page, state); }
    catch (e) { state.flash = e.message; state.busy = false; draw(page, state); }
  }
  // Building takes a minute or two and carries on if the person leaves this page.
  async function poll(page, state) {
    await new Promise((ok) => setTimeout(ok, 3000));
    if (!page.isConnected) return;
    let fresh;
    try { fresh = await api(`/api/user-projects/${state.p.id}`); }
    catch (e) { state.flash = e.message; state.busy = false; draw(page, state); return; }
    if (fresh.job && fresh.job.state === 'writing') { poll(page, state); return; }
    state.p = fresh;
    state.flash = fresh.job ? fresh.job.error : '';
    state.busy = false;
    draw(page, state);
  }

  function shareBar(page, state) {
    const p = state.p;
    if (!p.mine) return el('p', { class: note }, `Shared by ${p.owner}. You can read this.`);
    const sel = el('select', { id: 'up-share', class: `${input} w-auto` }, el('option', { value: 'no' }, 'Only you'), el('option', { value: 'yes' }, 'Everyone with an account'));
    sel.value = p.share ? 'yes' : 'no';
    sel.onchange = () => saveSoon(state, { share: sel.value === 'yes' });
    state.saved = el('span', { class: 'text-xs text-gray-400', role: 'status' });
    const del = el('button', { type: 'button', id: 'up-delete', class: 'text-sm text-rose-500 hover:underline min-h-10' }, 'Delete project');
    del.onclick = () => {
      const row = el('div', { class: 'flex flex-wrap items-center gap-2 basis-full' },
        el('span', { class: 'text-sm' }, `Delete ${p.name}? This can't be undone.`));
      const yes = el('button', { type: 'button', id: 'up-delete-yes', class: `${btnBase} bg-rose-600 hover:bg-rose-500 text-white` }, 'Delete');
      const no = el('button', { type: 'button', class: quiet }, 'Keep it');
      yes.onclick = async () => { try { clearTimeout(state.saveTimer); state.dirty = null; await api(`/api/user-projects/${p.id}`, 'DELETE'); location.hash = '#projects'; } catch (e) { setSaved(state, e.message, true); } };
      no.onclick = () => row.remove();
      row.append(yes, no);
      del.parentElement.append(row);
    };
    return el('div', { class: 'flex flex-wrap items-center gap-x-4 gap-y-2 pt-4 border-t border-gray-200 dark:border-dark-border' },
      el('label', { class: `flex items-center gap-2 ${note}` }, 'Who can see this', sel), state.saved, el('span', { class: 'flex-1' }), del);
  }

  function draw(page, state) {
    const p = state.p;
    const parts = [];
    if (state.busy) {
      parts.push(el('div', { class: 'grid gap-1', role: 'status' },
        el('p', { class: 'text-lg' }, el('i', { class: 'fa-solid fa-spinner fa-spin text-indigo-400' }), ' Ada is building your site…'),
        el('p', { class: note }, 'This usually takes a minute or two. You can leave this page and come back.')));
    } else {
      if (state.flash) parts.push(el('p', { class: 'text-sm text-rose-500', role: 'alert' }, state.flash));
      if (p.kind === 'splash' && (p.hasSite || p.drafts)) { if (p.mine && p.drafts) state.editing = true; parts.push(...siteParts(page, state)); }
      else parts.push(el('div', { class: 'grid gap-5 max-w-3xl' }, ...(p.kind === 'splash' ? splashParts(page, state) : docParts(state))));
    }
    parts.push(shareBar(page, state));
    page.replaceChildren(...parts);
  }

  function photoControls(page, state, label) {
    const p = state.p;
    const file = el('input', { type: 'file', accept: 'image/*', id: 'up-pic-file', hidden: true });
    const pick = el('button', { type: 'button', id: 'up-pic', class: quiet }, label);
    pick.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      pick.disabled = true;
      try {
        await flush(state);
        const fresh = await api(`/api/user-projects/${p.id}/image`, 'POST', { base64: await readFile(f) });
        state.p = Object.assign(p, { hasImage: fresh.hasImage, updatedAt: fresh.updatedAt });
        state.flash = '';
      } catch (e) { state.flash = e.message; }
      draw(page, state);
    };
    return [pick, file];
  }

  // What a site asks for from inside its frame. Only this project, only as the signed-in person.
  let activeFrame = null;
  window.addEventListener('message', async (e) => {
    const a = activeFrame;
    if (!a || e.source !== a.frame.contentWindow || !e.data) return;
    if (e.data.adaText) {
      if (!a.state.p.mine || !a.state.editing) return;
      try { const fresh = await api(`/api/user-projects/${a.id}/text`, 'POST', { old: e.data.old, value: e.data.value, nth: e.data.nth }); a.state.p.drafts = fresh.drafts; a.state.p.updatedAt = fresh.updatedAt; a.onSaved('Changed. Press Save when you\'re done.'); }
      catch (err) { a.onSaved(err.message, true); }
      return;
    }
    if (e.data.ada === undefined) return;
    const { op, args } = e.data;
    const base = `/api/user-projects/${a.id}`;
    const list = args && args.list ? `${base}/data/${encodeURIComponent(args.list)}` : '';
    let result, error;
    try {
      if (op === 'all') result = await api(list);
      else if (op === 'add') result = await api(list, 'POST', args.value);
      else if (op === 'update') result = await api(`${list}/${encodeURIComponent(args.entry)}`, 'PATCH', args.value);
      else if (op === 'remove') result = await api(`${list}/${encodeURIComponent(args.entry)}`, 'DELETE');
      else if (op === 'savePhoto') result = (await api(`${base}/photos`, 'POST', { base64: args.base64 })).id;
      else if (op === 'photoUrl') result = (await api(`${base}/photos/${encodeURIComponent(args.photo)}`)).url;
      else if (op === 'lookupFood') result = await api(`/api/food-lookup?q=${encodeURIComponent(args.q || '')}${args.brands ? '&brands=1' : ''}`);
      else error = 'Not available.';
    } catch (err) { error = err.message; }
    e.source.postMessage({ adaReply: e.data.ada, result, error }, '*');
  });

  function siteParts(page, state) {
    const p = state.p;
    const editing = p.mine && state.editing;
    const src = `/api/user-projects/${encodeURIComponent(p.id)}/site?${editing ? 'edit=1&' : ''}v=${encodeURIComponent(p.updatedAt)}`;
    const frame = el('iframe', { id: 'up-site', title: p.name, class: 'w-full h-[80vh] rounded-xl border border-gray-200 dark:border-dark-border bg-white' });
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    frame.src = src;
    const status = el('p', { class: note, id: 'up-edit-status', role: 'status' });
    activeFrame = { frame, id: p.id, state, onSaved: (m, bad) => { status.textContent = m; status.className = `text-sm ${bad ? 'text-rose-500' : 'text-gray-500 dark:text-gray-400'}`; } };
    const full = el('button', { type: 'button', id: 'up-full', class: 'text-sm text-indigo-500 hover:underline min-h-10' }, 'Full screen');
    full.onclick = () => { if (frame.requestFullscreen) frame.requestFullscreen(); };
    const title = p.mine ? editable('h2', 'text-xl font-semibold text-gray-900 dark:text-white', p.name, 'Project name', (v) => { if (v.trim()) saveSoon(state, { name: v }); }, true, 'up-title')
      : el('h2', { id: 'up-title', class: 'text-xl font-semibold text-gray-900 dark:text-white break-words' }, p.name);
    const right = el('div', { class: 'flex flex-wrap items-center gap-3' }, full);
    if (p.mine && !editing) {
      const edit = el('button', { type: 'button', id: 'up-edit', class: primary }, 'Edit page');
      edit.onclick = () => { state.editing = true; state.chat = []; draw(page, state); };
      right.append(edit);
    }
    const out = [el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, title, right), frame];
    if (!editing) return out;

    const finish = (action) => async () => {
      try { state.p = await api(`/api/user-projects/${p.id}/${action}`, 'POST', {}); state.editing = false; state.flash = ''; state.chat = []; }
      catch (e) { state.flash = e.message; }
      draw(page, state);
    };
    const save = el('button', { type: 'button', id: 'up-save', class: primary, disabled: !p.drafts && !!p.hasSite }, 'Save');
    save.onclick = finish('save');
    const discard = el('button', { type: 'button', id: 'up-discard', class: quiet }, p.hasSite ? 'Discard changes' : 'Discard');
    discard.onclick = finish('discard');
    const undo = el('button', { type: 'button', id: 'up-undo', class: quiet, disabled: !p.drafts }, 'Undo last change');
    undo.onclick = async () => {
      try { state.p = await api(`/api/user-projects/${p.id}/undo`, 'POST', {}); state.flash = ''; if (!state.p.drafts && !state.p.hasSite) state.editing = false; }
      catch (e) { state.flash = e.message; }
      draw(page, state);
    };
    const historyBox = el('div', { id: 'up-history', class: 'grid gap-1' });
    historyBox.hidden = true;
    const history = el('button', { type: 'button', id: 'up-history-btn', class: quiet, disabled: !p.versions }, 'History');
    history.onclick = async () => {
      if (!historyBox.hidden) { historyBox.hidden = true; frame.src = src; status.textContent = ''; return; }
      let list;
      try { list = await api(`/api/user-projects/${p.id}/versions`); }
      catch (e) { status.textContent = e.message; return; }
      const row = (v, i) => {
        const when = new Date(v.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        const look = el('button', { type: 'button', class: quiet }, 'Preview');
        look.onclick = () => { frame.src = `/api/user-projects/${encodeURIComponent(p.id)}/site?version=${encodeURIComponent(v.name)}`; status.textContent = `Showing the version from ${when}. Close History to go back to your working copy.`; };
        const back = el('button', { type: 'button', class: quiet }, 'Go back to this');
        back.onclick = async () => {
          try { state.p = await api(`/api/user-projects/${p.id}/versions/${encodeURIComponent(v.name)}/restore`, 'POST', {}); state.flash = `Back to the version from ${when}. Press Save to keep it, or Undo to change your mind.`; }
          catch (e) { state.flash = e.message; }
          draw(page, state);
        };
        return el('div', { class: 'flex flex-wrap items-center justify-between gap-2 py-1 border-b border-gray-200 dark:border-dark-border last:border-0' },
          el('span', { class: 'text-sm' }, `${when}${i === 0 ? ' (last saved)' : ''}`), el('div', { class: 'flex flex-wrap gap-2' }, look, back));
      };
      historyBox.replaceChildren(el('p', { class: note }, 'The last 20 saved versions. Things people added to the page, such as list entries and photos, stay as they are.'), ...list.map(row));
      historyBox.hidden = false;
    };
    const ask = el('textarea', { id: 'up-ask', class: input, rows: 2, maxLength: 2000, placeholder: 'Add a page for costs, or make the colours warmer' });
    const go = el('button', { type: 'button', id: 'up-ask-go', class: primary }, 'Send');
    const send = () => {
      const want = ask.value.trim();
      if (!want) { ask.focus(); return; }
      state.chat = (state.chat || []).concat(want);
      runAda(page, state, `/api/user-projects/${p.id}/revise`, { request: want });
    };
    go.onclick = send;
    ask.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    const log = (state.chat || []).length ? el('ul', { class: 'grid gap-1 text-sm text-gray-600 dark:text-gray-300', id: 'up-chat' }, ...state.chat.map((c) => el('li', { class: 'break-words' }, `You asked: ${c}`))) : null;
    out.push(el('div', { class: 'grid gap-3 p-4 rounded-xl bg-gray-100 dark:bg-white/5' },
      el('p', { class: note }, 'Click any text on the page to change it, or ask Ada below. Nobody else sees your changes until you save.'),
      status, log,
      el('div', { class: 'flex flex-wrap items-end gap-2' },
        el('div', { class: 'grid gap-1 flex-1 min-w-[12rem]' }, el('label', { htmlFor: 'up-ask', class: note }, 'Ask Ada to change something'), ask), go),
      el('div', { class: 'flex flex-wrap gap-2' }, save, discard, undo, history, ...photoControls(page, state, p.hasImage ? 'Change photo' : 'Add a photo')),
      historyBox));
    return out;
  }

  function splashParts(page, state) {
    const p = state.p;
    const out = [];
    if (p.hasImage) out.push(el('img', { src: imageUrl(p), alt: `Photo for ${p.name}`, class: 'block max-w-full max-h-[60vh] rounded-xl' }));
    out.push(editable('h2', 'text-3xl font-bold text-gray-900 dark:text-white', p.name, 'Project name', (v) => { if (v.trim()) saveSoon(state, { name: v }); }, p.mine, 'up-title'));
    out.push(editable('p', 'text-lg text-gray-800 dark:text-gray-200', p.text, 'Add a short description', (v) => saveSoon(state, { text: v }), p.mine, 'up-text'));

    if (p.blocks.length) {
      out.push(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, ...p.blocks.map((b, i) => {
        const change = () => saveSoon(state, { blocks: p.blocks });
        const remove = el('button', { type: 'button', class: 'justify-self-start text-xs text-gray-400 hover:text-rose-500 min-h-8' }, 'Remove section');
        remove.onclick = () => { p.blocks.splice(i, 1); saveSoon(state, { blocks: p.blocks }); draw(page, state); };
        return el('div', { class: 'grid gap-1 content-start min-w-0' },
          editable('h3', 'font-semibold text-gray-900 dark:text-gray-100', b.title, 'Section heading', (v) => { b.title = v; change(); }, p.mine),
          editable('p', 'text-gray-600 dark:text-gray-300', b.body, 'Write something here', (v) => { b.body = v; change(); }, p.mine),
          p.mine ? remove : null);
      })));
    }
    if (p.links.length) {
      out.push(el('div', { class: 'flex flex-wrap gap-2' }, ...p.links.map((l, i) => {
        const a = el('a', { href: l.url, target: '_blank', rel: 'noopener', class: quiet }, l.label);
        if (!p.mine) return a;
        const x = el('button', { type: 'button', class: 'text-xs text-gray-400 hover:text-rose-500 px-1 min-h-8', title: `Remove ${l.label}`, ariaLabel: `Remove ${l.label}` }, '×');
        x.onclick = () => { p.links.splice(i, 1); saveSoon(state, { links: p.links }); draw(page, state); };
        return el('span', { class: 'inline-flex items-center' }, a, x);
      })));
    }
    if (!p.mine) return out;

    const box = el('div', { class: 'grid gap-3 p-4 rounded-xl bg-gray-100 dark:bg-white/5' });
    const go = el('button', { type: 'button', id: 'up-draft', class: primary }, 'Build it for me');
    go.onclick = () => {
      const about = (document.getElementById('up-text').textContent || '').trim();
      if (!about) { document.getElementById('up-text').focus(); return; }
      runAda(page, state, `/api/user-projects/${p.id}/draft`, { about });
    };
    box.append(el('p', { class: note }, 'Want Ada to build a full site instead? Describe it above, then press Build it for me. It replaces this page, and you can undo it.'), el('div', null, go));
    out.push(box);

    const addSection = el('button', { type: 'button', id: 'up-add-section', class: quiet }, 'Add a section');
    addSection.onclick = () => { p.blocks.push({ title: '', body: '' }); saveSoon(state, { blocks: p.blocks }); draw(page, state); };
    const label = el('input', { id: 'up-link-label', class: input, maxLength: 100, autocomplete: 'off' });
    const url = el('input', { id: 'up-link-url', class: input, type: 'url', placeholder: 'https://', autocomplete: 'off' });
    const addLink = el('button', { type: 'button', id: 'up-link-add', class: quiet }, 'Add link');
    addLink.onclick = () => {
      const l = label.value.trim();
      const u = url.value.trim();
      if (!l) { label.focus(); return; }
      if (!/^https?:\/\/\S+$/i.test(u)) { url.focus(); return; }
      p.links.push({ label: l, url: u });
      saveSoon(state, { links: p.links });
      draw(page, state);
    };
    out.push(el('div', { class: 'flex flex-wrap gap-2' }, addSection, ...photoControls(page, state, p.hasImage ? 'Change photo' : 'Add a photo')));
    out.push(el('details', { id: 'up-links' },
      el('summary', { class: 'cursor-pointer text-sm font-medium text-indigo-500 min-h-10 flex items-center' }, 'Add a link to another site'),
      el('div', { class: 'flex flex-wrap items-end gap-2 pt-2' },
        el('div', { class: 'grid gap-1 flex-1 min-w-[10rem]' }, el('label', { htmlFor: 'up-link-label', class: note }, 'Button text'), label),
        el('div', { class: 'grid gap-1 flex-1 min-w-[10rem]' }, el('label', { htmlFor: 'up-link-url', class: note }, 'Web address'), url),
        addLink)));
    return out;
  }

  function docParts(state) {
    const p = state.p;
    const body = el('div', { id: 'up-doc', class: 'min-h-[40vh] outline-none focus:ring-2 focus:ring-indigo-500 rounded p-1 prose dark:prose-invert max-w-none break-words empty:before:content-[attr(data-hint)] empty:before:text-gray-400', data: { hint: p.mine ? 'Start writing' : '' } });
    body.innerHTML = p.html;   // cleaned by the server when it was saved
    const out = [editable('h2', 'text-3xl font-bold text-gray-900 dark:text-white', p.name, 'Document name', (v) => { if (v.trim()) saveSoon(state, { name: v }); }, p.mine, 'up-title')];
    if (p.mine) {
      body.contentEditable = 'true';
      body.setAttribute('role', 'textbox');
      body.setAttribute('aria-label', 'Document text');
      body.addEventListener('paste', plainPaste);
      body.addEventListener('input', () => saveSoon(state, { html: body.innerHTML }));
      const tool = (label, id, cmd, val) => {
        const b = el('button', { type: 'button', id: `up-tool-${id}`, class: 'px-3 min-h-10 rounded text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10' }, label);
        b.onmousedown = (e) => e.preventDefault();
        b.onclick = () => { body.focus(); document.execCommand(cmd, false, val); saveSoon(state, { html: body.innerHTML }); };
        return b;
      };
      out.push(el('div', { class: 'flex flex-wrap gap-1 border-b border-gray-200 dark:border-dark-border pb-1', role: 'toolbar', ariaLabel: 'Formatting' },
        tool('Heading', 'h', 'formatBlock', 'h2'), tool('Text', 'p', 'formatBlock', 'p'), tool('Bold', 'b', 'bold'), tool('List', 'ul', 'insertUnorderedList')));
    }
    out.push(body);
    return out;
  }

  // The pages made for one vault project, with the button to add another.
  async function renderProjectPages(host, project) {
    const add = el('button', { type: 'button', id: 'up-new-page', class: primary }, 'New page');
    add.onclick = () => openNew(project);
    const head = el('div', { class: 'flex items-center justify-between gap-3' }, el('div', { class: 'text-xs uppercase tracking-wide text-gray-400' }, 'Pages Ada built'), add);
    const body = el('div', { class: 'mt-2 grid gap-1 text-sm' });
    host.replaceChildren(head, body);
    try {
      const pages = (await api('/api/user-projects')).filter((p) => p.mine && p.project === project.slug);
      if (pages.length) body.replaceChildren(...pages.map((p) => el('a', { href: `#projects/mine/${encodeURIComponent(p.id)}`, class: 'text-indigo-400 hover:text-indigo-300 break-words' }, p.name)));
      else body.replaceChildren(el('p', { class: note }, 'Nothing yet. Describe a page and Ada builds it knowing about this project.'));
      return pages;
    } catch (e) { body.replaceChildren(el('p', { class: 'text-sm text-rose-500' }, e.message)); }
  }

  window.AdaUserProjects = { renderList, renderProjectPages, show };
})();
