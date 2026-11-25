'use strict';
/*
 * device-reach.js — which device can reach which over SSH (Alex, 2026-11-25). A session on a device picks up its own
 * items plus those for every device it reaches (CLAUDE.md § Session start): `todo-cli.js today --device adaone`
 * includes AdaTwo's items. Kept in data/device-reach.json: { "adaone": ["adatwo"], ... }.
 *
 * "Set up SSH from <from> to <to>" tasks (autoKind 'device-reach', autoKey '<from>><to>') add the pair when Alex
 * checks them off. ensureSetupTasks() keeps one such task for each pair in PENDING that isn't reachable yet.
 */
const fs = require('fs');
const path = require('path');
const { DEVICES } = require('./item-devices');

const KIND = 'device-reach';
const RULE = 'device-reach';
const DEFAULT = { adaone: ['adatwo'] };              // the known link (Alex confirmed 2026-11-25)
const PENDING = [['mac', 'adatwo']];                 // links Alex wants set up: each gets a task until it's done
const LABEL = { mac: 'the Mac', adaone: 'AdaOne', adatwo: 'AdaTwo' };

function fileOf(dataDir) { return path.join(dataDir, 'device-reach.json'); }
function read(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    const out = {};
    for (const [from, tos] of Object.entries(raw || {})) {
      if (from === '_asked') { out._asked = Array.isArray(tos) ? tos.map(String) : []; continue; }
      if (!DEVICES.includes(from) || !Array.isArray(tos)) continue;
      out[from] = [...new Set(tos.filter((t) => DEVICES.includes(t) && t !== from))];
    }
    return out;
  } catch (e) { return JSON.parse(JSON.stringify(DEFAULT)); }
}
function write(dataDir, map) {
  const f = fileOf(dataDir); const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n'); fs.renameSync(tmp, f);
}
// The devices whose items a session on `device` picks up: itself, plus every device it reaches.
function reachable(dataDir, device) { return device ? [device, ...((DEVICES.includes(device) && read(dataDir)[device]) || [])] : []; }
function add(dataDir, from, to) {
  if (!DEVICES.includes(from) || !DEVICES.includes(to) || from === to) return false;
  const map = read(dataDir);
  if ((map[from] || []).includes(to)) return false;
  map[from] = [...(map[from] || []), to]; write(dataDir, map); return true;
}

// Rule: Alex checked off "Set up SSH from X to Y" -> X reaches Y from now on.
function rule(dataDir) {
  return (task) => {
    if (task.autoKind !== KIND || !/^[a-z0-9]+>[a-z0-9]+$/.test(task.autoKey || '')) return undefined;
    const [from, to] = task.autoKey.split('>');
    if (add(dataDir, from, to)) console.log(`[device-reach] ${from} now reaches ${to} over SSH`);
    return undefined;
  };
}

// One open setup task per pending pair that isn't reachable yet (safe to run every tick).
function ensureSetupTasks({ dataDir, store, upsertAutoTask, engine }) {
  store.withLock(() => {
    const map = read(dataDir); let tasks = store.readTasks(); let changed = false;
    const asked = new Set(map._asked || []);   // a setup task is made once; if Alex deletes it, it stays gone
    for (const [from, to] of PENDING) {
      const key = `${from}>${to}`;
      if ((map[from] || []).includes(to) || asked.has(key) || tasks.some((t) => t.autoKind === KIND && t.autoKey === key)) continue;
      tasks = upsertAutoTask(tasks, KIND, key, {
        type: 'backlog', name: `Set up SSH from ${LABEL[from]} to ${LABEL[to]}`, project: 'One Ada', device: from, added: engine.todayString(),
        notes: `Give ${LABEL[from]} an SSH key that AdaTwo accepts, the way AdaOne has one (\`Devices/adaone/notes.md\`: \`ssh adatwo\`, its own key, host key checked). Checking this off tells the dashboard that ${LABEL[from]} reaches ${LABEL[to]}, so sessions there also pick up ${LABEL[to]}'s items.`,
        tags: [], owner: 'alex', sharedWith: [],
      }, { source: `automation:${RULE}`, now: new Date() });
      changed = true; asked.add(key);
    }
    if (changed) { store.writeTasks(tasks); write(dataDir, { ...read(dataDir), _asked: [...asked] }); }
  });
}

module.exports = { KIND, RULE, read, reachable, add, rule, ensureSetupTasks, DEFAULT, PENDING };
