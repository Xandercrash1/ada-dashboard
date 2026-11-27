'use strict';

/**
 * todo-validate.js — shared input validation for task create/update, used
 * identically by the HTTP API (server.js) and the CLI (todo-cli.js), per
 * contract §5: "Reuse the same validation as the API — do not write a
 * second, laxer parser."
 *
 * Contract §1.3: validate on write and reject with a clear error rather
 * than crashing (the Python engine's KeyError/ValueError on bad frequency
 * or date strings) or silently dropping the row.
 */

const engine = require('./todo-engine');

const VALID_TYPES = ['recurring', 'scheduled', 'backlog'];

/**
 * normalizeTask(raw, existing) — merges `raw` (new/patch fields) onto
 * `existing` (the current stored task, or null for a create), validates
 * the result, and returns { errors: [...] } or { task: {...} }.
 * `task` never includes id/createdAt/updatedAt/sourceFile — the caller
 * (server.js / todo-cli.js) owns those.
 */
const { DEVICES } = require('./item-devices');

function normalizeTask(raw, existing) {
  const errors = [];
  raw = raw || {};
  existing = existing || null;

  const pick = (key, fallback) => (raw[key] !== undefined ? raw[key] : (existing ? existing[key] : fallback));

  const type = pick('type', undefined);
  if (!VALID_TYPES.includes(type)) {
    errors.push(`type must be one of ${VALID_TYPES.join(', ')} (got ${JSON.stringify(type)})`);
    return { errors };
  }

  const name = typeof pick('name', '') === 'string' ? pick('name', '').trim() : '';
  if (!name) errors.push('name is required and must be a non-empty string');

  const project = typeof pick('project', '') === 'string' ? pick('project', '').trim() : '';
  if (!project) errors.push('project is required and must be a non-empty string');

  const priority = pick('priority', 'Low');
  if (typeof priority !== 'string' || !priority) errors.push('priority must be a non-empty string');

  const notesRaw = pick('notes', '');
  const notes = typeof notesRaw === 'string' ? notesRaw : '';

  // User tags (fb-1790204578669): usernames a task belongs to. Admin sees
  // every task; a pages user sees only tasks carrying their own tag. Format
  // is checked here; WHO may be tagged is the server's call (known users).
  const tagsRaw = pick('tags', []) ?? [];   // tasks saved before tags existed have no field at all (fb-1794356458080)
  let tags = [];
  if (tagsRaw !== null && !Array.isArray(tagsRaw)) errors.push('tags must be an array of usernames');
  else tags = [...new Set((tagsRaw || []).map(x => String(x).trim().toLowerCase()).filter(Boolean))];
  if (tags.some(x => !/^[a-z][a-z0-9_-]{1,31}$/.test(x))) errors.push('tags must be usernames (lowercase letters, digits, - or _)');
  if (tags.length > 20) errors.push('a task can carry at most 20 user tags');

  // Device (Alex, 2026-11-25): the one device an item needs (blank = the VPS or Alex's phone can do it). Session starts
  // on a device pull only their own items. Matching DEVICE-SETUP.md's Devices table.
  const deviceRaw = pick('device', null);
  const device = deviceRaw === null || deviceRaw === undefined || deviceRaw === '' ? null : String(deviceRaw).trim().toLowerCase();
  if (device !== null && !DEVICES.includes(device)) errors.push(`device must be one of ${DEVICES.join(', ')} (or empty)`);

  // Waits for (Alex, 2026-11-26): this task can't be done until another task is checked off (src/waits-for.js).
  // releaseBusinessDays sits on the task being waited on: when it's checked off, waiters come back that many weekdays later.
  const waitsRaw = pick('waitsFor', null);
  const waitsFor = waitsRaw === null || waitsRaw === undefined || waitsRaw === '' ? null : String(waitsRaw).trim();
  if (waitsFor !== null && !/^task-[A-Za-z0-9-]{1,60}$/.test(waitsFor)) errors.push('waitsFor must be a task id (like "task-123abc") or empty');
  else if (waitsFor !== null && existing && existing.id === waitsFor) errors.push('a task cannot wait for itself');
  const relRaw = pick('releaseBusinessDays', null);
  let releaseBusinessDays = null;
  if (relRaw !== null && relRaw !== undefined && relRaw !== '') {
    const n = typeof relRaw === 'string' && /^\d+$/.test(relRaw.trim()) ? Number(relRaw) : relRaw;
    if (!Number.isInteger(n) || n < 0 || n > 60) errors.push('releaseBusinessDays must be a whole number from 0 to 60 (or empty)');
    else releaseBusinessDays = n;
  }

  const task = {
    type,
    name,
    project,
    device,
    waitsFor,
    releaseBusinessDays,
    priority: typeof priority === 'string' && priority ? priority : 'Low',
    notes,
    tags,
    // Type-specific fields default to null/undefined below and are filled
    // in per branch — kept explicit so PATCHing a task from one type's
    // shape never leaves stale fields from another type behind.
    frequency: null,
    skippable: null,
    nextDue: null,
    dueTime: null,
    endDate: null,
    dueDate: null,
    added: null
  };

  if (type === 'recurring') {
    const frequency = pick('frequency', undefined);
    if (typeof frequency !== 'string' || !engine.isValidFrequency(frequency)) {
      errors.push(`Unparseable frequency: ${JSON.stringify(frequency)} — must exact-match a supported form (e.g. "Daily", "Weekdays", "Weekly (Wed)", "Every 2 Weeks (Sun)", "Monthly (31st)", "Yearly")`);
    }
    const nextDue = pick('nextDue', undefined);
    if (!engine.isValidDate(nextDue)) {
      errors.push(`nextDue must be a valid "YYYY-MM-DD" date (got ${JSON.stringify(nextDue)})`);
    }
    const dueTimeRaw = pick('dueTime', null);
    const dueTime = dueTimeRaw === null || dueTimeRaw === undefined ? null : String(dueTimeRaw);

    const endDateRaw = pick('endDate', null);
    let endDate = null;
    if (endDateRaw !== null && endDateRaw !== undefined && endDateRaw !== '') {
      if (!engine.isValidDate(endDateRaw)) {
        errors.push(`endDate must be a valid "YYYY-MM-DD" date or null (got ${JSON.stringify(endDateRaw)})`);
      } else {
        endDate = endDateRaw;
      }
    }

    let skippable;
    if (raw.skippable !== undefined) {
      if (typeof raw.skippable !== 'boolean') {
        errors.push('skippable must be a boolean');
        skippable = null;
      } else {
        skippable = raw.skippable;
      }
    } else if (existing && typeof existing.skippable === 'boolean') {
      skippable = existing.skippable;
    } else {
      // Resolution rule at creation with no explicit value (spec §2.4's
      // "otherwise" branch): true only for Daily/Weekdays.
      skippable = frequency === 'Daily' || frequency === 'Weekdays';
    }

    Object.assign(task, { frequency, nextDue, dueTime, endDate, skippable });
    // lastCompleted is only ever set by /complete — never accepted from raw input on create/edit.
    task.lastCompleted = existing ? (existing.lastCompleted || null) : null;
  } else if (type === 'scheduled') {
    const dueDate = pick('dueDate', undefined);
    if (!engine.isValidDate(dueDate)) {
      errors.push(`dueDate must be a valid "YYYY-MM-DD" date (got ${JSON.stringify(dueDate)})`);
    }
    const dueTimeRaw = pick('dueTime', null);
    const dueTime = dueTimeRaw === null || dueTimeRaw === undefined ? null : String(dueTimeRaw);
    Object.assign(task, { dueDate, dueTime });
  } else if (type === 'backlog') {
    // NOTE (contract §2 clarification, 2026-08-26): `added` is a provenance
    // date, not a due date, and an EMPTY `added` is meaningful — it sorts
    // first in the backlog-guarantee tie-break (spec §4.7), which is real
    // (if awkward) Python behavior the importer preserves for legacy rows
    // missing the `Added` column. So this must NOT re-default an existing
    // task's empty `added` to today on an unrelated PATCH — only a brand
    // NEW task with no `added` supplied gets "added today". Getting this
    // wrong here previously overwrote legacy empty `added` values.
    let added;
    if (raw.added !== undefined) {
      added = raw.added === null ? '' : String(raw.added);
    } else if (existing) {
      added = existing.added || ''; // preserve exactly, including legacy empty-string rows
    } else {
      added = engine.todayString(); // creation with no added given
    }
    task.added = added;
  }

  if (errors.length) return { errors };
  return { task };
}

module.exports = { normalizeTask, VALID_TYPES, DEVICES };
