# Homepage Live Document (fb-1787801162107)

**Status: implemented & verified on staging, 2026-08-27. Author: System Architect (Claude).**

## The idea

The Home tab's announcement banner and a new widget-card grid no longer live in
`index.html` — they render from **`data/homepage.json`**, fetched via
`GET /api/homepage` on every page load. Because `data/` is excluded from
`promote.sh`'s rsync **in both directions**, this file is a content layer that
sits entirely outside the deploy cycle:

- Any agent can rewrite the homepage by editing one JSON file with bash/file
  tools. **No server restart, no promote** — a browser refresh shows it.
- Staging and live each have their own `data/homepage.json`, so agents testing
  designs on staging can't clobber the live homepage, and vice versa.

## Schema (`data/homepage.json`)

```json
{
  "version": 1,
  "updatedAt": "ISO8601 | null",
  "updatedBy": "string | null",
  "announcement": {
    "title": "string ≤120",
    "text": "string ≤2000",
    "icon": "FontAwesome class, e.g. fa-sparkles",
    "visible": true
  },
  "widgets": [
    {
      "id": "string",
      "title": "string ≤120",
      "icon": "FontAwesome class",
      "accent": "indigo|purple|emerald|rose|amber|sky",
      "html": "trusted HTML for the card body (≤20k chars)",
      "link": { "label": "string", "tab": "home|todo|tools|server" },
      "hidden": false
    }
  ]
}
```

`link` takes either `tab` (switches dashboard tab) or `href` (opens a URL in a
new window) — so widgets can deep-link to tools and hosted projects. Max 24
widgets.

## API

- `GET /api/homepage` — sanitized doc + `path` (the absolute file path for
  *this* tree, so a designer agent gets pointed at the right file).
  Missing or corrupt file ⇒ built-in defaults (the Home tab can never 500).
- `PUT /api/homepage` — partial update (`announcement` and/or `widgets`);
  stamps `updatedAt`/`updatedBy`. Used by the banner's edit modal.

Everything passes through a whitelist sanitizer (`sanitizeHomepage` in
`src/server.js`): unknown fields dropped, strings capped, invalid widgets
skipped individually. `widget.html` is intentionally NOT stripped — it enters
only via the authenticated API or the server filesystem, the same trust level
as the agents' bash access.

## UI

- Banner now has a **pencil** button → modal editing title/text/visibility
  (a collapsed "Announcement hidden — edit" pill keeps the editor reachable
  when the banner is hidden).
- A **wand** button summons a **Homepage Designer** agent via the existing
  new-agent modal, pre-briefed (`openHomepageDesigner()` in `index.html`) with
  the schema, the exact file path, and instructions to propose widget ideas.
- Shared agent context rule 9 (in `src/server.js`) teaches *every* agent —
  both engines — about the file, so designer work can also happen from any
  session or scheduled prompt.

## Extension ideas (not built yet)

- Widget types with server-backed data (e.g. `"source": "/api/todo"` rendered
  client-side) instead of static HTML.
- A poll/SSE so open browsers repaint without a manual refresh.
- Versioned history of homepage.json for one-click undo of an agent redesign.

## Round 2 (2026-08-27): Designer role + chat bubble

Per Alex's follow-up on fb-1787801162107:

- **New `designer` agent role** ("Page Designer") — 5th role next to
  debugger/query/automator/architect. RULING: containerized to ONE page
  document at a time (currently the homepage). **Enforced, not just
  instructed**:
  - Gemini/Ollama/OpenAI engines: `executeLocalTool` denies `run_bash`
    entirely and denies `write_file` to any path except the page document.
  - Claude engine: runs WITHOUT `--dangerously-skip-permissions` (sandbox
    auto-denies), with `--disallowedTools Bash,NotebookEdit` and
    `--allowedTools "Write(//<page doc>),Edit(//<page doc>)"`. NOTE the `//`
    — permission rules treat a single `/` as settings-relative; absolute
    paths need the double slash (verified empirically: without it the
    designer was denied its own file).
  - Verified live on both engines: out-of-bounds writes denied, page-doc
    edit succeeded.
- Designer sessions **default to `antigravity-flash`** (cheap + safe since
  writes are walled); model switchable per-session like any other.
- **Designer bubble** (`#designer-bubble` in index.html): wand button on the
  banner opens a floating chat panel on the Home tab — quick-action chips
  (Banner / New widget / Stats / Undo / Ideas), model selector, text box.
  It drives a normal agent session (persisted id in localStorage key
  `ada_designer_session_home`), so the full conversation also appears under
  Server → Agents ("open in Agents tab" button included). After each
  designer turn the bubble re-fetches `/api/homepage` and repaints — edits
  appear live without a manual refresh.
- **Schema addition**: `sections: {stats: true, quickLinks: true}` — the
  designer can hide the built-in Quick Stats / Favorite Tools sections and
  replace them with widgets. Widget `html` may embed
  `<span data-home-stat="todo|jobs|cpu|bugs"></span>`, kept live by a
  5-second mirror loop (`syncHomeStatMirrors`).
- To bring the Designer to OTHER pages later: give the page a JSON document
  + renderer like the homepage, point `HOMEPAGE_FILE`-style constants at it,
  and reuse the same role with a different page doc in the walls/prompt.

## Round 3 (2026-08-27): Floating FAB + per-page rolling conversations

- The Designer now launches from a **floating bubble button** (`#designer-fab`,
  purple wand) stacked above the scheduler FAB — same visual pattern. It is
  visible only on pages listed in the client-side `DESIGNER_PAGES` registry
  (currently just `home`); the banner wand remains as a Home shortcut.
- **Page binding is now first-class**: designer sessions carry `session.page`
  (validated against the server-side `PAGE_DOCS` registry at creation, bogus
  values fall back to `home`), and BOTH write walls resolve the target
  document from that binding — a designer opened on one page can never write
  another page's document. Verified live post-refactor (Claude engine edit
  succeeded through the page-bound wall).
- **Bubble closes on tab switch** (`onDesignerTabSwitch` hook at the end of
  `switchTab`), and each page keeps its own **rolling conversation**: session
  ids are stored per page under localStorage `ada_designer_session_<page>`,
  so reopening the FAB on a page resumes that page's conversation.
- To add a page: add it to `PAGE_DOCS` (server) + `DESIGNER_PAGES` (client),
  give the page a JSON document + renderer. Everything else follows.
