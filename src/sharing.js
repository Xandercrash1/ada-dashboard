// "Shared with" lists for pages, tasks and builder projects (Plan — Roles § Sharing).
// A list holds usernames and/or roles ('@303', '@guest'). Admins see everything;
// anyone else sees what they made plus what is shared with them by name or role.
// Only the creator or an admin can change the list (Alex, 2026-11-10): someone an
// item was shared with can use it but can't share it on.
const ROLE_TARGETS = ['@303', '@guest'];
const USER_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX = 30;

const ownerOf = (item) => (item && item.owner) || 'alex';

// The stored list, plus the older forms: `shared: true` (pages) and `share: true`
// (builder projects) meant every 303 account; `tags` on tasks were usernames.
function listOf(item) {
  if (!item) return [];
  const out = Array.isArray(item.sharedWith) ? item.sharedWith.filter(x => typeof x === 'string') : [];
  if (item.shared === true || item.share === true) out.push('@303');
  if (Array.isArray(item.tags)) out.push(...item.tags.filter(x => typeof x === 'string'));
  const own = ownerOf(item);
  return [...new Set(out)].filter(x => x !== own);
}

function isAdminUser(user) { return !user || user.role === 'admin'; }

function canSee(user, item) {
  if (!item) return false;
  if (isAdminUser(user)) return true;
  if (ownerOf(item) === user.username) return true;
  const l = listOf(item);
  return l.includes(user.username) || l.includes('@' + user.role);
}

function canShare(user, item) { return !!item && (isAdminUser(user) || ownerOf(item) === user.username); }

// Checks a requested list. `people` = usernames that can be named (enabled accounts);
// names already on the item stay allowed, so a disabled account doesn't block a save.
function clean(raw, { people, item }) {
  if (!Array.isArray(raw)) return { error: 'sharedWith must be a list' };
  const prev = listOf(item);
  const known = new Set(people);
  const out = [];
  for (const v of raw) {
    const x = String(v || '').trim().toLowerCase();
    if (!x) continue;
    if (ROLE_TARGETS.includes(x) || (USER_RE.test(x) && (known.has(x) || prev.includes(x)))) { if (!out.includes(x)) out.push(x); continue; }
    return { error: `Can't share with "${String(v).slice(0, 40)}".` };
  }
  const own = item ? ownerOf(item) : null;
  const list = out.filter(x => x !== own);
  if (list.length > MAX) return { error: `Share with at most ${MAX} people or roles.` };
  return { list };
}

const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// Applies a requested list to an existing item in place. Returns null when fine,
// or { status, error }. An unchanged list is fine for anyone who can edit the item.
// The older fields are folded into sharedWith on the first change.
function change(user, item, raw, people) {
  if (raw === undefined) return null;
  const r = clean(raw, { people, item });
  if (r.error) return { status: 400, error: r.error };
  if (same(r.list, listOf(item))) return null;
  if (!canShare(user, item)) return { status: 403, error: 'Only the person who made this can share it.' };
  item.sharedWith = r.list;
  delete item.shared; delete item.share;
  if (Array.isArray(item.tags)) item.tags = [];
  return null;
}

function view(item) { return { owner: ownerOf(item), sharedWith: listOf(item) }; }

module.exports = { ROLE_TARGETS, ownerOf, listOf, canSee, canShare, clean, change, view };
