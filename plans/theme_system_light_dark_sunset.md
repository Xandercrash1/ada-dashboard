# Plan: Adaptive Theme System (System / Light / Dark / Sunset)

**Author:** System Architect
**Date:** 2026-08-27
**Requested by:** Alex
**Goal:** Stop the dashboard from being permanently dark. Respect the browser/OS
`prefers-color-scheme` by default, offer a manual Light/Dark override, and add an
optional **Sunset** mode that flips automatically at local sunrise/sunset.

---

## 1. Current state (why it's "perpetual darkmode")

- **Stack:** Tailwind via CDN (`<script src="https://cdn.tailwindcss.com">`) with an
  inline `tailwind.config` in both `public/index.html` and `public/login.html`.
- `darkMode: 'class'` is configured **but the `dark` class is never applied** — it is
  vestigial. The UI is dark because:
  1. `body { background-color: #090d16; color: #f8fafc }` is hardcoded in `<style>`.
  2. A custom color palette `colors.dark = { bg:#090d16, card:#0f172a, border:#1e293b,
     accent:#334155 }` is used through **~236 utility usages**:
     `bg-dark-bg` (63), `bg-dark-card` (47), `border-dark-border` (117), `dark-accent` (9).
  3. Built-in light-on-dark text tokens: `text-white` (108), `text-gray-400` (78),
     `text-gray-300` (37), `text-gray-500` (34), `text-gray-200` (14), `text-gray-100/600`,
     plus `bg-black` / `bg-black/95` / `bg-black/80` (13, terminal panes).
- **No** settings UI, theme toggle, or server-side preference storage exists.
  `localStorage` is already used for minor UI state (`ada_todo_collapsed`).

**Consequence:** there is no light theme to switch *to*. This plan builds one.

---

## 2. Design decision — the key trick

Point the custom `dark.*` palette at **CSS custom properties** instead of literal hex,
then flip those variables per theme. Tailwind's CDN JIT happily accepts
`var(--x)` as a color value, so `bg-dark-card` compiles to
`background-color: var(--card)` — meaning **all ~236 `dark-*` usages become
theme-aware with zero markup changes.**

Only the built-in Tailwind tokens (`text-white`, `text-gray-*`, `bg-black*`) can't be
re-pointed through config cleanly, so they get a small, surgical CSS override layer
scoped to `[data-theme="light"]` (higher specificity than a bare utility class, so it wins).

Theme is selected on `<html data-theme="...">`. Four user-facing modes stored in
`localStorage` under key `ada_theme`:

| Mode          | Behavior                                                        |
|---------------|-----------------------------------------------------------------|
| `system` (default) | Follow `matchMedia('(prefers-color-scheme: dark)')`, live. |
| `light`       | Force light.                                                    |
| `dark`        | Force dark.                                                     |
| `sunset`      | Dark between local sunset→sunrise, light during the day.        |

`data-theme` is always resolved to a concrete `light` or `dark` before paint.

---

## 3. Implementation

### 3.1 Tailwind config — re-point the `dark` palette (both HTML files)

Replace the literal hex in `colors.dark` with variables:

```js
dark: {
  bg:     'var(--bg)',
  card:   'var(--card)',
  border: 'var(--border)',
  accent: 'var(--accent)'
}
```

Leave `brand.*` untouched (accent color is fine in both themes).

### 3.2 Theme variables + light overrides — in the `<style>` block (both files)

Replace the hardcoded `body` background/color with variable-driven values and add the
palette definitions:

```css
:root, [data-theme="dark"] {
  --bg:     #090d16;
  --card:   #0f172a;
  --border: #1e293b;
  --accent: #334155;
  --text:   #f8fafc;
  --scroll-track: #0f172a;
  --scroll-thumb: #334155;
}
[data-theme="light"] {
  --bg:     #f1f5f9;  /* slate-100 */
  --card:   #ffffff;
  --border: #e2e8f0;  /* slate-200 */
  --accent: #cbd5e1;  /* slate-300 */
  --text:   #0f172a;  /* slate-900 */
  --scroll-track: #e2e8f0;
  --scroll-thumb: #94a3b8;
}
body { background-color: var(--bg); color: var(--text); }
.custom-scrollbar::-webkit-scrollbar-track { background: var(--scroll-track); }
.custom-scrollbar::-webkit-scrollbar-thumb { background: var(--scroll-thumb); }

/* Surgical overrides for built-in tokens that assume a dark bg.
   Scoped to light theme; the [data-theme] prefix out-specifies bare utilities. */
[data-theme="light"] .text-white       { color: #0f172a; }
[data-theme="light"] .text-gray-100    { color: #1e293b; }
[data-theme="light"] .text-gray-200    { color: #334155; }
[data-theme="light"] .text-gray-300    { color: #475569; }
[data-theme="light"] .text-gray-400    { color: #64748b; }
[data-theme="light"] .text-gray-500    { color: #64748b; }
[data-theme="light"] .text-gray-600    { color: #94a3b8; }
[data-theme="light"] .placeholder-gray-500::placeholder { color: #94a3b8; }
```

**Terminal / code panes** (`bg-black`, `bg-black/95`, `bg-black/80`, and the
`text-cyan-300` / `text-green` mono output) — **keep dark in both themes** (standard
convention; a light terminal looks wrong and would need re-coloring all the mono text).
So do **not** override `bg-black*`. Verify contrast on the ~13 occurrences; if any
non-terminal element uses `bg-black`, give it a `bg-dark-card` class instead.

### 3.3 No-flash (FOUC) resolver — FIRST script in `<head>`, before Tailwind (both files)

Must run before paint so the page never flashes dark then light:

```html
<script>
(function () {
  function computeSunset(now, lat, lng) {
    // Minimal NOAA sunrise/sunset. Returns {sunrise, sunset} as Date (today, local).
    // Uses SunCalc-style solar calc. Full body in §3.6.
    return window.__adaSolar(now, lat, lng);
  }
  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    if (mode === 'sunset') {
      var loc = JSON.parse(localStorage.getItem('ada_geo') || 'null');
      if (loc) {
        var s = computeSunset(new Date(), loc.lat, loc.lng);
        var t = new Date();
        return (t >= s.sunrise && t < s.sunset) ? 'light' : 'dark';
      }
      // No location yet → fall back to system until geo is captured.
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  var mode = localStorage.getItem('ada_theme') || 'system';
  document.documentElement.setAttribute('data-theme', resolve(mode));
  window.__adaThemeMode = mode;
})();
</script>
```

Add `<meta name="color-scheme" content="light dark">` in `<head>` so native form
controls / scrollbars match.

### 3.4 Theme controller — runtime script (near end of `<body>`, index.html)

Handles live changes and re-evaluation:

```js
const ThemeCtl = {
  mql: matchMedia('(prefers-color-scheme: dark)'),
  timer: null,
  get mode() { return localStorage.getItem('ada_theme') || 'system'; },
  set(mode) { localStorage.setItem('ada_theme', mode); this.apply(); this.render(); },
  apply() {
    const mode = this.mode;
    let t;
    if (mode === 'light' || mode === 'dark') t = mode;
    else if (mode === 'sunset') t = this.bySunset();
    else t = this.mql.matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    this.schedule(mode);
  },
  bySunset() {
    const loc = JSON.parse(localStorage.getItem('ada_geo') || 'null');
    if (!loc) { this.captureGeo(); return this.mql.matches ? 'dark' : 'light'; }
    const s = window.__adaSolar(new Date(), loc.lat, loc.lng), t = new Date();
    return (t >= s.sunrise && t < s.sunset) ? 'light' : 'dark';
  },
  captureGeo() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(p => {
      localStorage.setItem('ada_geo',
        JSON.stringify({ lat: p.coords.latitude, lng: p.coords.longitude }));
      this.apply();
    }, () => {/* denied → stays on system fallback */}, { timeout: 8000 });
  },
  schedule(mode) {
    clearTimeout(this.timer);
    if (mode === 'sunset') // re-check at next 5-min boundary to catch the crossing
      this.timer = setTimeout(() => this.apply(), 5 * 60 * 1000);
  },
  render() { /* update toggle UI active state (§3.5) */ },
  init() {
    this.mql.addEventListener('change', () => { if (this.mode === 'system') this.apply(); });
    this.apply(); this.render();
  }
};
document.addEventListener('DOMContentLoaded', () => ThemeCtl.init());
```

### 3.5 Toggle UI — top nav header (index.html)

Add a 4-way segmented control (icons: `fa-desktop` System, `fa-sun` Light,
`fa-moon` Dark, `fa-mountain-sun` Sunset) to the desktop header bar (the
`bg-dark-card border-b` nav around line 58) and mirror a compact version into the
mobile layout. Each button calls `ThemeCtl.set('<mode>')`; `render()` highlights the
active one with `bg-dark-accent`. Login page (`login.html`) does **not** need the
toggle — it only needs the resolver (§3.3) so it matches whatever the user last chose.

### 3.6 Solar calc helper `window.__adaSolar` (shared, both files)

Embed a compact, dependency-free sunrise/sunset function (NOAA algorithm, ~40 lines)
exposed as `window.__adaSolar(date, lat, lng) → { sunrise: Date, sunset: Date }`.
Define it **inside the head resolver script** (§3.3) so it's available before paint.
Reference implementation: SunCalc `getTimes()` reduced to just sunrise/sunset, or the
NOAA solar equations. No external network call — works offline and needs no API key.

---

## 4. Location handling for Sunset mode

Priority order, each falling back to the next:
1. **Cached** `ada_geo` in localStorage (from a prior grant).
2. **`navigator.geolocation`** — requested lazily only when the user first picks
   Sunset mode (never on load). One-time prompt; result cached.
3. **Denied / unavailable** → fall back to `prefers-color-scheme` and surface a small
   inline note: "Sunset mode needs location; using system theme instead."

Do **not** hardcode the server's coordinates — the browser may be anywhere. No
server round-trip is required for any of this.

---

## 5. Files to change

| File | Changes |
|------|---------|
| `public/index.html` | §3.1 config, §3.2 styles, §3.3 head resolver + `__adaSolar`, §3.4 controller, §3.5 toggle UI, `color-scheme` meta |
| `public/login.html` | §3.1 config, §3.2 styles, §3.3 head resolver + `__adaSolar`, `color-scheme` meta (no toggle) |

**Optional refactor (recommended if this grows):** extract §3.3+§3.4+§3.6 into
`public/theme.js` and include it in both pages to avoid duplicating the solar calc.
Deferred for v1 to keep the diff self-contained per file.

No server (`src/server.js`) changes required — theme is a pure client concern.

---

## 6. Test / verification checklist (on staging, port 3001)

1. **System match:** set OS to Light → dashboard loads light; switch OS to Dark →
   flips live without reload (System mode).
2. **No FOUC:** hard-reload in each mode; confirm no dark→light flash.
3. **Manual override:** Light and Dark buttons force and persist across reloads.
4. **Sunset:** grant location → verify correct light/dark for current local time;
   temporarily fake by editing `ada_geo` to a far-east/west longitude to force the
   opposite; confirm the 5-min re-check flips it. Deny location → falls back to system
   with the note.
5. **Legibility sweep (light):** walk every tab (Overview, Todo, Server/Agent, Tools,
   Telemetry, Feedback) — confirm no white-on-white text, readable borders, inputs,
   selects, chips. Pay attention to the 108 `text-white` and terminal panes.
6. **Login page** honors the last-chosen theme.
7. Mobile layout toggle works and doesn't overflow the header.

---

## 7. Rollout

1. Implement on the working tree, restart staging (port 3001).
2. Run the §6 checklist on staging.
3. **Promotion:** the implementing agent CANNOT run `promote.sh`. Report exactly what
   was verified on staging and ask **Alex** to run: `bash ~/ops/promote.sh`.

## 8. Risks & mitigations

- **Missed a hardcoded dark token** → light-mode contrast bug. *Mitigation:* the §6.5
  full-tab sweep; grep for any remaining literal `#0[0-9a-f]{5}` in inline styles.
- **Tailwind CDN JIT rejecting `var()` colors** → very unlikely (documented support);
  if it ever does, fall back to defining `.bg-dark-card{background:var(--card)}` etc.
  directly in the `<style>` block instead of via config.
- **Sunset edge cases** (polar day/night, DST) → NOAA calc handles DST via local Date;
  polar extremes are acceptable to ignore (rare users); System mode is unaffected.
- **Third-party embeds** assuming dark → none present; all UI is first-party.
```