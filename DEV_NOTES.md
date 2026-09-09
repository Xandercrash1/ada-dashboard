# Session Handover & Progress Log

## 2026-09-09 (afternoon) — PM session (Ada), ticket sweep + deploy path facts

### Shipped (all verified on staging :3001 before promote)
- **fb-1788977565816** Page refresh → blank page. Cause: `DOMContentLoaded` restored a custom-page tab before `/api/pages` had answered, so `switchTab()` hid every view and found no `view-<pageId>`. Restore now awaits `window.__customPagesReady`, falls back to `home` for a deleted page, and also restores the Server sub-tab (`ada_serverSubTab`).
- **fb-1788977734294** PM chat missing typing dots. Cause: `submitPmChat()` called `pollJobOnce(pmSessionId)` with no jobId, so the poll registry never knew about the turn. It now reads the 202/409 `jobId`, hands it to `startJobPolling()`, and shows dots from submit (`pmChatPending`) until `finalizeJob()` redraws.
- **fb-1788977823680** Ticket sort: added Recently Updated, By Type, By Status, Title A–Z.
- **fb-1787765370485** Notification stream. `data/notifications.json` ring buffer (200), `pushNotification()` helper, routes under `/api/notifications` (GET, POST, read-all, :id/read, DELETE purge-read, DELETE :id). Hooked at `finishJob()` (errors; roadblock replies via `ROADBLOCK_RE`) and `runScheduledItem()` (success / failure / gave-up / missing session). UI: bell + dropdown (desktop and mobile), toasts for events that arrive while the page is open (info/success fade, warn/error stay). Agents can POST from loopback (auth-exempt).
- **fb-1788928004000** Page theme presets. `pageTheme` on the page doc (Midnight / Glass / Minimalist / Neon / Sunset / Rosé), select in the canvas header in edit mode, applies theme+accent to every widget via the same attribute sync the inspector uses, sets `glanceTheme`, and new widgets inherit it. **Server-side:** `sanitizeHomepageWidget` was silently dropping `theme` and `size`, and `PUT /api/homepage` dropped `pageTheme`/`glanceTheme` — both fixed.

### 16:50–17:00 addendum — page builder / widget inspector sweep
Alex: the builder and widget config "still feel a bit clunky". Audited, filed 8 tickets (`fb-1788986893005` … `893205`), shipped 6 of them (`d872ac8`, `88ae845`, and the pointer-resize commit): Size dropdown now drives cols/rows; Clone/Export implemented (were undefined); Remove is undoable via toast; Escape/backdrop close both modals; Link Tab Target is a select of real tabs; hidden widgets restorable from edit mode; edit overlay always visible on touch; resize uses pointer events. **Still open:** `fb-1788986893122` touch **reorder** (HTML5 DnD has no touch fallback — needs a handle/long-press path), `fb-1788986893205` live theme preview + whether spawn should auto-open the inspector (Alex to rule), `fb-1788929000123` DocBody/Brave (Alex's browser).

### Ticket bookkeeping done on the live store
- fb-1788928003000 (widget catalog) → done (was already shipped, never closed).
- fb-1787765505344 → wont-do (duplicate of fb-1787765370485).
- **fb-1788929000123 is the single tracker for the DocBody/Brave problem**; fb-1788927445123 and fb-1788928002000 merged into it. Next step is diagnostic in Alex's own Brave with devtools — three blind fixes have already failed against code that passes Puppeteer. Do not attempt a fourth.

### Deploy path — read before deploying from anywhere
- **`deploy.sh` (Mac) is unsafe as written:** step 4 does `pm2 delete` + `pm2 start`, which drops every env var except `GEMINI_API_KEY` — that is how `OPENAI_API_KEY` got lost and had to be re-injected. Use `pm2 restart --update-env`, never delete/start, until it is fixed.
- **`~/ops/promote.sh` on the server does `git reset --hard origin/main`** (the README still describes an rsync). So GitHub `main` must be current before promoting — on 2026-09-09 it was **88 commits behind** the local tree because nothing had been pushed since 09-03. The local (Mac) checkout cannot push: its GitHub identity is a different account with READ only. The server authenticates as `Xandercrash1` and can push; this session pushed via a git bundle carried to the server.
- Staging (`~/dashboard-staging`, :3001) has its own `data/` and is the right place to runtime-test; `stage-sync.sh --force` refreshes it from live.

### Open / for the next agent
- `ROADBLOCK_RE` is a heuristic — tune it from real transcripts (server.js, next to `notifyJobOutcome`).
- Job **completions** are deliberately not notified (BubbleManager already surfaces unread agent messages); only errors, roadblocks and scheduled-run outcomes are.
- `public/BubbleManager.js` (root) is an untracked stray; the live one is `public/components/BubbleManager.js`.
- `~/ops/README.md` describes promote as rsync; the script pulls from git. One of them should change.

---

**Date:** September 8/9, 2026

## What was accomplished tonight:
1. **Manual Builder Epic (Phases 1-3):** 
   - Replaced basic edit modals with a full Widget Inspector for adjusting widget properties and raw HTML.
   - Added a Component Library (Template Spawner) directly into the Edit grid.
   - Fixed HTML5 drag-and-drop layout reordering for both the Homepage and newly spawned Custom Pages.
2. **Designer Agent Containerization & Bug Fixes:**
   - Containerized the Designer Agent specifically to the custom page JSON it is launched from.
   - Implemented `PATCH /api/agent/sessions/:id` endpoint.
   - Fixed silent failure in the model selector dropdown (Designer + PM) to properly persist model selections to the backend.
   - Re-injected the `OPENAI_API_KEY` into the PM2 environment and permanently saved the dump config.
3. **Catastrophic Save Bug Fix:**
   - Diagnosed an issue where `saveHomepageDoc()` was hardcoded to `PUT /api/homepage`, causing the layout editor to overwrite `homepage.json` with custom page data.
   - Patched `saveHomepageDoc()` to conditionally route to `/api/homepage` or `/api/pages/:id/content` depending on `currentCanvasPage`.
   - Restored the corrupted live `homepage.json` from a pristine local backup.

## Next Up (Roadmap / Backlog):
1. **Rich Text Body Widget (Notion-style)** (Ticket: fb-1788926470211)
   - Create a borderless, markdown-friendly text editor component (`<ada-doc-body>`).
2. **Document Layout Restructuring (Inline widgets & Sidebar)** (Ticket: fb-1788926475783)
   - When a body widget is added, dynamically switch the page out of Grid layout and into a Sidebar / Main Document layout.
   - Rewrite the drag-and-drop mechanics to support embedding widgets inline into the body editor.
   - *Note: This requires careful planning and a structural shift in how page JSON schema stores nested widgets.*
3. **Global Notification / Event Stream System**
   - Ticket exists for lightweight notification endpoint & polling banner for async chat events (cron failures, roadblocks).

## Handoff Notes for Next Agent:
- The backend `agent_sessions.json` and API endpoints are fully aligned for the new custom page functionality.
- The `saveHomepageDoc()` function in `index.html` relies entirely on the `currentCanvasPage` variable to determine where to save data. When tackling the Document Layout refactor, ensure this routing is maintained.
- Review the `DEV_NOTES.md` or ticket system when starting work on the Document Layout changes.
