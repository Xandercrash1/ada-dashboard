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

  const task = {
    type,
    name,
    project,
    priority: typeof priority === 'string' && priority ? priority : 'Low',
    notes,
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

module.exports = { normalizeTask, VALID_TYPES };
