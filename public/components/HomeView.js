// The Home tab (Alex, 2026-11-04): one fixed page for every account, replacing the widget grid.
// Today is per user and Admin is admin only. Both rest on the server's role wall, not on this
// file: /api/todo filters to the user's own tasks, and /api/agenda, /api/system and /api/feedback
// answer 403 for a pages account, so those calls are only made for admins.
const TZ = 'America/New_York';
const MAX_TASKS = 5;
const STALE_MS = 30000;
const PHOTO_MS = 30000;
const WHEEL_MS = 250;   // a trackpad fires many wheel events per swipe
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

const STYLE = `
ada-home [hidden] { display: none !important; }
ada-home { display: block; max-width: 60rem; margin: 0 auto; --h-muted: rgba(226, 232, 240, .65); --h-line: rgba(255, 255, 255, .1); --h-link: #818cf8; --h-surface: rgba(255, 255, 255, .04); --h-ok: #6ee7a8; --h-warn: #fbbf24; }
[data-theme="light"] ada-home { --h-muted: #64748b; --h-line: rgba(0, 0, 0, .1); --h-link: #4f46e5; --h-surface: rgba(0, 0, 0, .03); --h-ok: #15803d; --h-warn: #b45309; }
ada-home .h-wrap { display: grid; gap: 32px; padding-bottom: 32px; }
ada-home h1 { margin: 0; font-size: 1.75rem; line-height: 1.2; font-weight: 700; letter-spacing: -.015em; }
ada-home .h-sub { margin: 4px 0 0; color: var(--h-muted); }
ada-home .h-cols { display: grid; gap: 32px; }
@media (min-width: 760px) { ada-home .h-cols { grid-template-columns: 1fr 1fr; align-items: start; } }
ada-home section { display: grid; gap: 12px; min-width: 0; }
ada-home h2 { margin: 0; font-size: .75rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--h-muted); }
ada-home .h-sum { margin: 0; font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
ada-home .h-note { margin: 0; color: var(--h-muted); }
ada-home ul { list-style: none; margin: 0; padding: 0; }
ada-home .h-rows li { border-top: 1px solid var(--h-line); }
ada-home .h-rows li:last-child { border-bottom: 1px solid var(--h-line); }
ada-home .h-task { display: flex; align-items: center; gap: 12px; min-height: 48px; padding-block: 6px; cursor: pointer; }
ada-home .h-task input { width: 20px; height: 20px; flex: none; margin: 0; accent-color: var(--h-link); }
ada-home .h-task span { min-width: 0; overflow-wrap: anywhere; }
ada-home .h-task input:checked + span { color: var(--h-muted); text-decoration: line-through; }
ada-home .h-late { flex: none; margin-left: auto; font-size: .8125rem; color: var(--h-warn); }
ada-home .h-event { display: flex; gap: 12px; align-items: baseline; min-height: 48px; padding-block: 12px; }
ada-home .h-event time { flex: none; width: 4.5rem; color: var(--h-muted); font-size: .875rem; font-variant-numeric: tabular-nums; }
ada-home .h-event span { min-width: 0; overflow-wrap: anywhere; }
ada-home .h-link { justify-self: start; min-height: 40px; padding: 0 4px; border: 0; background: none; color: var(--h-link); font-weight: 600; text-decoration: underline; cursor: pointer; }
ada-home .h-notice-title { margin: 0; font-weight: 600; }
ada-home .h-notice { margin: 0; overflow-wrap: anywhere; }
ada-home figure { margin: 0; display: grid; gap: 6px; }
ada-home .h-photo { display: block; width: 100%; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
ada-home .h-photo img { display: block; width: auto; height: auto; max-width: 100%; max-height: 70vh; border-radius: 10px; }
ada-home .h-photo span { display: block; padding: 16px 0; text-align: left; font-weight: 600; color: var(--h-link); }
ada-home figcaption { font-size: .875rem; color: var(--h-muted); }
ada-home .h-confirm { display: grid; gap: 8px; }
ada-home .h-confirm p { margin: 0; }
ada-home .h-confirm div { display: flex; flex-wrap: wrap; gap: 8px; }
ada-home .h-confirm button { min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--h-line); background: var(--h-surface); color: inherit; font-weight: 600; cursor: pointer; }
ada-home .h-confirm button.go { background: var(--h-link); border-color: var(--h-link); color: var(--bg); }
ada-home .h-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: 8px; }
ada-home .h-tile { min-height: 56px; padding: 8px 14px; text-align: left; font-weight: 500; overflow-wrap: anywhere; border-radius: 10px; border: 1px solid var(--h-line); background: var(--h-surface); color: inherit; cursor: pointer; }
ada-home .h-tile:hover { border-color: var(--h-link); }
ada-home .h-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 0; border-block: 1px solid var(--h-line); }
ada-home .h-pill { font-size: .875rem; font-weight: 600; color: var(--h-ok); }
ada-home .h-pill.warn { color: var(--h-warn); }
ada-home .h-status .h-link { margin-left: auto; }
ada-home button:focus-visible, ada-home input:focus-visible { outline: 3px solid var(--h-link); outline-offset: 2px; }
`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
  return res.json();
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

class HomeView extends HTMLElement {
  connectedCallback() {
    if (!document.getElementById('ada-home-style')) {
      const s = el('style', '', STYLE);
      s.id = 'ada-home-style';
      document.head.append(s);
    }
    this.loadedAt = 0;
    this.tasks = null;
    this.doneIds = new Set();
    this.events = [];
    this.innerHTML = `<div class="h-wrap">
      <header><h1 data-r="hello"></h1><p class="h-sub" data-r="date"></p></header>
      <div class="h-cols">
        <section aria-labelledby="h-today"><h2 id="h-today">Today</h2>
          <p class="h-sum" data-r="sum" aria-live="polite"></p>
          <ul class="h-rows" data-r="tasks"></ul>
          <button type="button" class="h-link" data-r="all" hidden></button>
          <ul class="h-rows" data-r="events" hidden></ul>
        </section>
        <section aria-labelledby="h-house" data-r="house" hidden><h2 id="h-house">House</h2>
          <p class="h-notice-title" data-r="ntitle" hidden></p>
          <p class="h-notice" data-r="ntext" hidden></p>
          <button type="button" class="h-link" data-r="nedit" hidden>Edit announcement</button>
          <figure>
            <button type="button" class="h-photo" data-r="pick" aria-label="Add photos">
              <img data-r="img" alt="A shared house photo" hidden><span data-r="empty">Add the first photo</span>
            </button>
            <figcaption data-r="pcap" aria-live="polite" hidden></figcaption>
            <div class="h-confirm" data-r="confirm" hidden>
              <p data-r="ctext"></p>
              <div><button type="button" class="go" data-r="cgo"></button><button type="button" data-r="cno">Cancel</button></div>
            </div>
            <input type="file" data-r="file" accept="image/*" multiple hidden>
          </figure>
        </section>
      </div>
      <section aria-labelledby="h-pages"><h2 id="h-pages">Your pages</h2><div class="h-tiles" data-r="tiles"></div></section>
      <section aria-labelledby="h-admin" data-r="admin" hidden><h2 id="h-admin">Admin</h2><div class="h-status" data-r="status"></div></section>
    </div>`;
    this.r = {};
    this.querySelectorAll('[data-r]').forEach(n => { this.r[n.dataset.r] = n; });
    this.r.nedit.onclick = () => window.openAnnouncementModal();
    this.r.all.onclick = () => window.switchTab('todo');
    this.r.pick.onclick = () => this.r.file.click();
    this.r.file.onchange = () => this.confirmUpload([...this.r.file.files]);
    this.r.cno.onclick = () => this.closeConfirm();
    this.r.pick.addEventListener('wheel', e => this.wheelPhoto(e), { passive: false });
    this.startPhotoTimer();
  }

  disconnectedCallback() { clearInterval(this.photoTimer); }

  // Called each time Home is drawn. Skips the network if it just loaded.
  async show() {
    if (Date.now() - this.loadedAt < STALE_MS) return;
    this.loadedAt = Date.now();
    this.me = (window.ME || await window.__meReady) || { username: '', role: 'pages' };
    this.isAdmin = this.me.role === 'admin';
    this.drawHeader();
    this.loadWeather();
    this.loadTasks();
    this.loadHouse();
    this.loadPages();
    if (this.isAdmin) { this.loadEvents(); this.loadAdmin(); }
  }

  // The announcement editor saved: draw what it wrote without refetching.
  setAnnouncement(a) {
    if (!this.r || !a || JSON.stringify(a) === this.annKey) return;
    this.announcement = a;
    this.drawHouse();
  }

  drawHeader() {
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }), 10);
    const part = hour >= 4 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening';
    const name = this.me.username ? this.me.username[0].toUpperCase() + this.me.username.slice(1) : '';
    this.r.hello.textContent = `Good ${part}${name ? ', ' + name : ''}`;
    this.dateText = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
    this.r.date.textContent = this.dateText;
  }

  async loadWeather() {
    try {
      const w = await getJson('/api/weather');
      this.r.date.textContent = `${this.dateText} · ${w.temp_f}° and ${String(w.condition).toLowerCase()}`;
    } catch (e) { /* the date alone is fine */ }
  }

  async loadTasks() {
    try {
      const v = await getJson('/api/todo');
      const late = (v.pastDue || []).map(t => ({ ...t, late: true }));
      this.tasks = [...late, ...(v.today || [])];
      this.doneIds.clear();
      this.taskError = false;
    } catch (e) {
      this.tasks = [];
      this.taskError = true;
    }
    this.drawTasks();
    this.drawSummary();
  }

  drawTasks() {
    // Today's first: a long overdue list shouldn't push out what's due now.
    const ordered = [...this.tasks.filter(t => !t.late), ...this.tasks.filter(t => t.late)];
    this.r.tasks.replaceChildren(...ordered.slice(0, MAX_TASKS).map(t => {
      const li = el('li'), label = el('label', 'h-task'), box = el('input'), name = el('span', '', t.name);
      box.type = 'checkbox';
      box.checked = this.doneIds.has(t.id);
      box.disabled = box.checked;
      box.onchange = () => this.complete(t, box);
      label.append(box, name);
      if (t.late) label.append(el('span', 'h-late', 'Overdue'));
      li.append(label);
      return li;
    }));
    this.r.tasks.hidden = !ordered.length;
    const extra = ordered.length - MAX_TASKS;
    this.r.all.hidden = extra <= 0;
    this.r.all.textContent = `See ${plural(extra, 'more task')}`;
  }

  drawSummary() {
    if (this.taskError) { this.r.sum.textContent = 'Your tasks didn’t load. Reload the page to try again.'; return; }
    const open = this.tasks.filter(t => !this.doneIds.has(t.id));
    const late = open.filter(t => t.late).length;
    const parts = [open.length ? plural(open.length, 'task') : 'Nothing due today'];
    if (late) parts.push(`${late} overdue`);
    if (this.events.length) parts.push(plural(this.events.length, 'event'));
    this.r.sum.textContent = parts.join(' · ');
  }

  async complete(task, box) {
    box.disabled = true;
    this.doneIds.add(task.id);
    this.drawSummary();
    let ok = false;
    try { ok = (await fetch(`/api/todo/tasks/${encodeURIComponent(task.id)}/complete`, { method: 'POST' })).ok; } catch (e) { /* handled below */ }
    if (ok) return;
    this.doneIds.delete(task.id);
    box.checked = false;
    box.disabled = false;
    this.r.sum.textContent = `“${task.name}” didn’t save. Try checking it again.`;
  }

  async loadEvents() {
    try {
      const a = await getJson('/api/agenda?days=1');
      this.events = a.events || [];
    } catch (e) { this.events = []; }
    this.r.events.hidden = !this.events.length;
    this.r.events.replaceChildren(...this.events.map(ev => {
      const li = el('li', 'h-event');
      const at = ev.allDay ? 'All day' : new Date(ev.startsAt).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
      li.append(el('time', '', at), el('span', '', ev.title));
      return li;
    }));
    if (this.tasks) this.drawSummary();
  }

  async loadHouse() {
    const [doc, files] = await Promise.all([
      getJson('/api/homepage').catch(() => null),
      getJson('/api/media/files?library=default').catch(() => [])
    ]);
    this.announcement = doc && doc.announcement;
    this.photos = Array.isArray(files) ? files.filter(f => IMAGE_RE.test(f.filename)) : [];
    this.photoAt = Math.floor(Math.random() * this.photos.length);
    this.drawHouse();
  }

  drawHouse() {
    const a = this.announcement || {};
    this.annKey = JSON.stringify(a);
    const on = a.visible !== false;
    const title = on && a.title ? a.title : '', text = on && a.text ? a.text : '';
    this.r.ntitle.textContent = title; this.r.ntitle.hidden = !title;
    this.r.ntext.textContent = text; this.r.ntext.hidden = !text;
    this.r.nedit.hidden = !this.isAdmin;
    this.drawPhoto();
    this.r.house.hidden = false;
  }

  drawPhoto() {
    const photos = this.photos || [];
    this.r.img.hidden = !photos.length;
    this.r.empty.hidden = !!photos.length;
    if (photos.length) this.r.img.src = photos[this.photoAt % photos.length].path;
  }

  startPhotoTimer() {
    clearInterval(this.photoTimer);
    this.photoTimer = setInterval(() => this.nextPhoto(), PHOTO_MS);
  }

  nextPhoto() {
    if (document.hidden || !this.photos || this.photos.length < 2 || this.classList.contains('hidden')) return;
    this.photoAt = (this.photoAt + 1) % this.photos.length;
    this.drawPhoto();
  }

  // Scrolling over the photo steps through them. With one photo the page scrolls as usual.
  wheelPhoto(e) {
    if (!this.photos || this.photos.length < 2 || !e.deltaY) return;
    e.preventDefault();
    const now = Date.now();
    if (now - (this.wheelAt || 0) < WHEEL_MS) return;
    this.wheelAt = now;
    const n = this.photos.length;
    this.photoAt = (this.photoAt + (e.deltaY > 0 ? 1 : n - 1)) % n;
    this.drawPhoto();
    this.startPhotoTimer();
  }

  confirmUpload(files) {
    if (!files.length) return;
    this.r.pcap.hidden = true;
    this.r.ctext.textContent = `Everyone with an account will see ${files.length === 1 ? 'this photo' : 'these photos'}.`;
    this.r.cgo.textContent = files.length === 1 ? 'Add photo' : `Add ${files.length} photos`;
    this.r.cgo.onclick = () => { this.closeConfirm(); this.upload(files); };
    this.r.confirm.hidden = false;
  }

  closeConfirm() {
    this.r.confirm.hidden = true;
    this.r.file.value = '';
  }

  async upload(files) {
    const cap = this.r.pcap;
    cap.hidden = false;
    let added = 0, failed = 0;
    for (const file of files) {
      cap.textContent = `Adding ${files.length === 1 ? 'your photo' : `photo ${added + failed + 1} of ${files.length}`}…`;
      try {
        const base64 = await new Promise((ok, no) => {
          const rd = new FileReader();
          rd.onload = () => ok(rd.result);
          rd.onerror = no;
          rd.readAsDataURL(file);
        });
        // The timestamp keeps two phones' IMG_0001.jpg from overwriting each other.
        const res = await fetch('/api/media/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ library: 'default', filename: `${Date.now()}-${file.name}`, base64 })
        });
        if (res.ok) added++; else failed++;
      } catch (e) { failed++; }
    }
    cap.textContent = failed ? `${plural(failed, 'photo')} didn’t upload. Try a JPG or PNG, or a smaller file.` : '';
    cap.hidden = !failed;
    if (!added) return;
    const fresh = await getJson('/api/media/files?library=default').catch(() => null);
    if (Array.isArray(fresh)) {
      const known = new Set((this.photos || []).map(f => f.path));
      this.photos = fresh.filter(f => IMAGE_RE.test(f.filename));
      const first = this.photos.findIndex(f => !known.has(f.path));
      if (first >= 0) this.photoAt = first;
      this.drawPhoto();
    }
  }

  async loadPages() {
    let pages = [];
    try { pages = (await getJson('/api/pages')).pages || []; } catch (e) { /* the built-in tiles still work */ }
    const built = this.isAdmin
      ? [['todo', 'Tasks'], ['projects', 'Projects'], ['tools', 'Scripts']]
      : [['todo', 'Tasks']];
    // Project pages live on their project's hub, as in the top bar.
    const own = pages.filter(p => !p.project).map(p => [p.id, p.title]);
    this.r.tiles.replaceChildren(...[...built, ...own].map(([id, title]) => {
      const b = el('button', 'h-tile', title);
      b.type = 'button';
      b.onclick = () => window.switchTab(id);
      return b;
    }));
  }

  async loadAdmin() {
    this.r.admin.hidden = false;
    const [sys, tickets] = await Promise.all([
      getJson('/api/system').catch(() => null),
      getJson('/api/feedback').catch(() => null)
    ]);
    const facts = [];
    let pill;
    if (sys) {
      const full = v => parseFloat(v) >= 90;
      const tight = sys.disk && full(sys.disk.percent) ? 'Disk almost full' : sys.memory && full(sys.memory.percent) ? 'Memory almost full' : '';
      pill = el('span', 'h-pill' + (tight ? ' warn' : ''), tight || 'Server OK');
      if (Array.isArray(sys.tmuxSessions)) facts.push(plural(sys.tmuxSessions.length, 'session') + ' running');
    } else {
      pill = el('span', 'h-pill warn', 'Server status unavailable');
    }
    if (Array.isArray(tickets)) {
      const open = tickets.filter(t => t.status !== 'done' && t.status !== 'wont-do').length;
      facts.push(plural(open, 'open ticket'));
    }
    const go = el('button', 'h-link', 'Open server page');
    go.type = 'button';
    go.onclick = () => window.switchTab('server');
    this.r.status.replaceChildren(pill, ...facts.map(f => el('span', '', f)), go);
  }
}

customElements.define('ada-home', HomeView);
