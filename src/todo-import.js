#!/usr/bin/env node
'use strict';

/**
 * todo-import.js — one-shot importer, run by a human/dispatcher on the Mac,
 * that parses the vault markdown and emits a todo_tasks.json-shaped array.
 *
 * Contract §6. Mirrors vault_todo.py's read_table (spec §1.1) and
 * parse_registry (spec §1.3) exactly, restricted to Personal + Meta rows
 * (Work is explicitly out of scope and skipped).
 *
 * 🛑 READ-ONLY. This script must NEVER write anywhere under ~/Documents/Ada.
 * Output goes ONLY to a path given on the command line, and that is
 * asserted in code (assertOutputPathSafe), not left as a comment.
 *
 * Usage:
 *   node todo-import.js <output-path> [--ada-root PATH] [--json]
 */

const fs = require('fs');
const path = require('path');
const engine = require('./todo-engine');

// --- read_table port (spec §1.1) -------------------------------------------

function readTable(filePath) {
  if (!fs.existsSync(filePath)) return { title: '', headers: [], rows: [] };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let title = '';
  let headers = null;
  const rows = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (s.startsWith('#') && headers === null) { title = s; continue; }
    if (!s.startsWith('|')) continue; // prose, bullets, fences — all invisible, silently skipped
    const cells = s.replace(/^\|+|\|+$/g, '').split('|').map(c => c.trim());
    if (headers === null) { headers = cells; continue; }
    // Separator row: ALL non-empty cells match [-: ]+ (a row of entirely
    // empty cells is ALSO a separator, since `all()` over an empty
    // collection is true in Python — ported faithfully).
    if (cells.filter(c => c !== '').every(c => /^[-: ]+$/.test(c))) continue;
    const padded = cells.slice(0, headers.length);
    while (padded.length < headers.length) padded.push('');
    const row = {};
    headers.forEach((h, i) => { row[h] = padded[i]; });
    rows.push(row);
  }
  return { title, headers: headers || [], rows };
}

// --- parse_registry port (spec §1.3) ----------------------------------------
// Reads ONLY the first table whose header row's first cell is exactly
// "Vault", and BREAKS at the first non-| line after entering it — a
// dedicated scan, not readTable, because readTable would misread a second
// table's header row in the same file as a data row.

function parseRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return [];
  const lines = fs.readFileSync(registryPath, 'utf8').split('\n');
  let inTable = false;
  const rows = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!inTable) {
      if (!s.startsWith('|')) continue;
      const cells = s.replace(/^\|+|\|+$/g, '').split('|').map(c => c.trim());
      if (cells[0] === 'Vault') inTable = true;
      continue;
    }
    if (!s.startsWith('|')) break; // break at first non-| line after entering the table
    const cells = s.replace(/^\|+|\|+$/g, '').split('|').map(c => c.trim());
    if (cells.filter(c => c !== '').every(c => /^[-: ]+$/.test(c))) continue; // separator row
    if (cells.length < 4) continue; // rows with <4 cells skipped
    rows.push({ Vault: cells[0], Project: cells[1], Path: cells[2], 'Task Files': cells[3] });
  }
  return rows;
}

// --- Safety: the one and only place this script is allowed to write -------

function assertOutputPathSafe(outputPath, adaRoot) {
  const resolvedOut = path.resolve(outputPath);
  const resolvedAda = path.resolve(adaRoot);
  if (resolvedOut === resolvedAda || resolvedOut.startsWith(resolvedAda + path.sep)) {
    throw new Error(`REFUSING TO WRITE: output path "${resolvedOut}" is inside the Ada vault (${resolvedAda}). This importer must write only outside ~/Documents/Ada.`);
  }
}

// --- Row -> task conversion --------------------------------------------------

function priorityOf(row) {
  return Object.prototype.hasOwnProperty.call(row, 'Priority') ? row['Priority'] : 'Low';
}

function baseTask(project, type, name, priority, sourceFile, nowIso) {
  return {
    id: engine.generateId(),
    project,
    type,
    name,
    priority,
    frequency: null,
    skippable: null,
    nextDue: null,
    dueTime: null,
    endDate: null,
    dueDate: null,
    added: null,
    notes: '',
    lastCompleted: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    sourceFile
  };
}

function convertRecurring(row, project, sourceFile, nowIso, skipped) {
  const name = (row['Task'] || '').trim();
  if (!name) { skipped.push({ sourceFile, reason: 'missing/blank Task name', row }); return null; }

  const frequency = row['Frequency'] || '';
  if (!engine.isValidFrequency(frequency)) {
    skipped.push({ sourceFile, name, reason: `unparseable frequency: ${JSON.stringify(frequency)}` });
    return null;
  }

  const nextDueParts = engine.parseDueParts(row['Next Due'] || '');
  if (!nextDueParts.date) {
    skipped.push({ sourceFile, name, reason: `unparseable/missing Next Due: ${JSON.stringify(row['Next Due'] || '')}` });
    return null;
  }

  const task = baseTask(project, 'recurring', name, priorityOf(row), sourceFile, nowIso);
  task.frequency = frequency;
  task.skippable = engine.resolveSkippable(row['Skippable'] || '', frequency);
  task.nextDue = nextDueParts.date;
  task.dueTime = nextDueParts.time;

  const endDateRaw = (row['End Date'] || '').trim();
  if (endDateRaw && endDateRaw !== '—' /* em dash "none" sentinel */) {
    const parsed = engine.parseDueParts(endDateRaw);
    task.endDate = parsed.date; // null if unparseable — silently no end date, matches Python's silent-drop-on-parse-failure for this field
  }

  const lastCompletedRaw = row['Last Completed'] || '';
  const lc = engine.parseDueParts(lastCompletedRaw);
  task.lastCompleted = lc.date;

  return task;
}

function convertScheduled(row, project, sourceFile, nowIso, skipped) {
  const name = (row['Task'] || '').trim();
  if (!name) { skipped.push({ sourceFile, reason: 'missing/blank Task name', row }); return null; }

  const dueParts = engine.parseDueParts(row['Due Date'] || '');
  if (!dueParts.date) {
    skipped.push({ sourceFile, name, reason: `unparseable/missing Due Date: ${JSON.stringify(row['Due Date'] || '')}` });
    return null;
  }

  const notes = row['Notes'] || '';
  let dueTime = dueParts.time;
  if (!dueTime) {
    // Notes "by H(:MM)am/pm" fallback — Scheduled only, looser than parse_date (spec §3.2).
    dueTime = engine.parseTimeFromNotes(notes);
  }

  const task = baseTask(project, 'scheduled', name, priorityOf(row), sourceFile, nowIso);
  task.dueDate = dueParts.date;
  task.dueTime = dueTime;
  task.notes = notes;
  return task;
}

function convertBacklog(row, project, sourceFile, nowIso, skipped) {
  const name = (row['Task'] || '').trim();
  if (!name) { skipped.push({ sourceFile, reason: 'missing/blank Task name', row }); return null; }

  const task = baseTask(project, 'backlog', name, priorityOf(row), sourceFile, nowIso);
  // Added is a raw string, undated rows are legal, no validation — spec §1.4 mess #1
  // (a missing Added column already sorts first in the tie-break, which is the
  // documented, if awkward, existing behavior).
  task.added = Object.prototype.hasOwnProperty.call(row, 'Added') ? (row['Added'] || '') : '';
  return task;
}

// --- Main import ------------------------------------------------------------

function runImport(adaRoot) {
  const nowIso = new Date().toISOString();
  const registryPath = path.join(adaRoot, 'TODO', 'registry.md');
  const registryRows = parseRegistry(registryPath);

  const tasks = [];
  const skipped = [];
  const filesNotFound = [];
  const unregisteredVaults = [];
  const byProject = {};
  const byType = { recurring: 0, scheduled: 0, backlog: 0 };
  let workRowsSkipped = 0;

  for (const row of registryRows) {
    const vault = row.Vault;
    if (vault === 'Work') { workRowsSkipped++; continue; } // contract §6 — Work rows explicitly excluded

    if (vault !== 'Personal' && vault !== 'Meta') {
      unregisteredVaults.push({ vault, project: row.Project });
      continue;
    }

    const vaultSubdir = vault === 'Personal' ? "Alex's Vault" : ''; // Meta -> Ada root itself
    const relDir = (row.Path || '').replace(/\/+$/, '');
    const fullDir = vaultSubdir ? path.join(adaRoot, vaultSubdir, relDir) : path.join(adaRoot, relDir);
    const taskFiles = (row['Task Files'] || '').split(',').map(s => s.trim()).filter(Boolean);

    for (const fname of taskFiles) {
      const fullPath = path.join(fullDir, fname);
      const relSourceParts = [vaultSubdir, relDir, fname].filter(Boolean);
      const sourceFile = relSourceParts.join('/').split(path.sep).join('/');

      if (!fs.existsSync(fullPath)) {
        filesNotFound.push(sourceFile); // NOT an error — "rows may precede their task files" (registry.md)
        continue;
      }

      const sourceType = fname.replace(/\.md$/, '');
      const { rows } = readTable(fullPath);

      for (const row2 of rows) {
        let task = null;
        if (sourceType === 'Recurring') task = convertRecurring(row2, row.Project, sourceFile, nowIso, skipped);
        else if (sourceType === 'Scheduled') task = convertScheduled(row2, row.Project, sourceFile, nowIso, skipped);
        else if (sourceType === 'Backlog') task = convertBacklog(row2, row.Project, sourceFile, nowIso, skipped);
        else { skipped.push({ sourceFile, reason: `unrecognized task-file type "${fname}" — dispatch is by filename only (Recurring/Scheduled/Backlog)`, }); continue; }

        if (task) {
          tasks.push(task);
          byProject[row.Project] = (byProject[row.Project] || 0) + 1;
          byType[task.type] = (byType[task.type] || 0) + 1;
        }
      }
    }
  }

  return { tasks, report: { byProject, byType, totalTasks: tasks.length, skipped, filesNotFound, unregisteredVaults, workRowsSkipped } };
}

function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter(a => !a.startsWith('--'));
  const outputPath = positional[0];
  const jsonOut = argv.includes('--json');
  const adaRootIdx = argv.indexOf('--ada-root');
  const adaRoot = adaRootIdx !== -1 ? argv[adaRootIdx + 1] : path.resolve(__dirname, '..', '..', '..');

  if (!outputPath) {
    process.stderr.write('Usage: node todo-import.js <output-path> [--ada-root PATH] [--json]\n');
    process.exit(1);
  }

  assertOutputPathSafe(outputPath, adaRoot);

  const { tasks, report } = runImport(adaRoot);

  // The ONLY write in this entire script, and only after the safety assertion above.
  fs.writeFileSync(outputPath, JSON.stringify(tasks, null, 2));

  if (jsonOut) {
    process.stdout.write(JSON.stringify({ outputPath, ...report }, null, 2) + '\n');
    return;
  }

  console.log(`Imported ${report.totalTasks} tasks -> ${outputPath}`);
  console.log(`By type: recurring=${report.byType.recurring} scheduled=${report.byType.scheduled} backlog=${report.byType.backlog}`);
  console.log('By project:');
  for (const [proj, count] of Object.entries(report.byProject).sort()) {
    console.log(`  ${proj}: ${count}`);
  }
  if (report.workRowsSkipped) console.log(`Work registry rows skipped (out of scope): ${report.workRowsSkipped}`);
  if (report.unregisteredVaults.length) {
    console.log(`Unknown vault names skipped: ${report.unregisteredVaults.map(v => `${v.vault} (${v.project})`).join(', ')}`);
  }
  if (report.filesNotFound.length) {
    console.log(`\nRegistered task files not found (not errors — normal for empty projects): ${report.filesNotFound.length}`);
    for (const f of report.filesNotFound) console.log(`  - ${f}`);
  }
  if (report.skipped.length) {
    console.log(`\nSkipped rows (${report.skipped.length}) — could not parse:`);
    for (const s of report.skipped) console.log(`  - [${s.sourceFile}] ${s.name ? `"${s.name}": ` : ''}${s.reason}`);
  } else {
    console.log('\nNo rows skipped.');
  }
}

if (require.main === module) main();

module.exports = { readTable, parseRegistry, runImport, assertOutputPathSafe };
