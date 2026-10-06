#!/usr/bin/env node
'use strict';

/**
 * forum-cli.js — Claude's side of the VPS-native forums (see forum.js). Operates directly on the
 * store, NOT over HTTP (same contract as todo-cli.js), so it needs no login.
 *
 * A polling session's loop (about once a minute):
 *   pending --json   →  answer each thread  →  reply <slug> <nn> --body "…"  →  notify
 *
 *   forum-cli.js list [--project <slug>] [--json]        forums with counts, or one forum's threads
 *   forum-cli.js show <slug> <nn> [--json]               one thread in full
 *   forum-cli.js new <slug> --title T [--severity S] [--scope X] [--body B] [--author claude|alex] [--json]
 *   forum-cli.js reply <slug> <nn> --body B [--if-pending] [--json]   reply as [Claude]  (--body - reads stdin).
 *       --if-pending (USE IT IN THE POLLING LOOP): refuse with exit 3 unless the thread is still waiting on Claude,
 *       so two live sessions never double-answer one post.
 *   forum-cli.js close <slug> <nn> [--note N] [--json]   /  reopen <slug> <nn> [--note N]
 *   forum-cli.js pending [--project <slug>] [--json]     open threads whose last post is Alex's, all forums
 *   forum-cli.js notify [--dry-run] [--json]             ONE email summarising what Claude answered since the last notify
 *
 * `--json` on every command (the caller is usually an AI agent). Env FORUM_DATA_DIR points the CLI at another store.
 */
const fs = require('fs');
const forum = require('./forum');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next !== '-')) args[a.slice(2)] = true;
      else { args[a.slice(2)] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, ...pos] = args._;
const json = !!args.json;

function out(data, plain) {
  if (json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else plain(data);
}
function fail(message, code = 1) {
  if (json) process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
  else process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}
const need = (v, what) => { if (v === undefined || v === true || v === '') fail(`missing ${what}`, 2); return v; };
const pad = (n) => String(n).padStart(2, '0');
const readBody = () => {
  const b = need(args.body, '--body');
  return b === '-' ? fs.readFileSync(0, 'utf8') : b;
};
const printThread = (t) => {
  console.log(`# ${pad(t.nn)} — ${t.title}   [${t.slug}]\nSeverity: ${t.severity} · Scope: ${t.scope || '-'} · ${t.status}${t.pending ? ' · WAITING ON CLAUDE' : ''}\n`);
  console.log(`(${t.author}, ${t.openedAt}) ${t.body}\n`);
  for (const p of t.posts) console.log(`* ${p.author === 'claude' ? '[Claude]' : '(Alex)'} ${p.ts}: ${p.body.replace(/\n/g, '\n    ')}\n`);
  if (t.status === 'closed') console.log(`CLOSED ${t.closedAt}${t.closeNote ? ' — ' + t.closeNote : ''}`);
};

async function main() {
  if (cmd === 'list') {
    if (args.project) {
      const ts = forum.listThreads(String(args.project));
      out(ts, (r) => r.length ? r.forEach((t) => console.log(`${pad(t.nn)}  ${t.status.padEnd(6)}  ${t.severity.padEnd(11)}  last:${t.lastAuthor}${t.pending ? '  PENDING' : ''}  ${t.title}`)) : console.log('No threads.'));
    } else {
      const fs_ = forum.listForums();
      out(fs_, (r) => r.length ? r.forEach((f) => console.log(`${f.slug}  ${f.open} open · ${f.closed} closed · ${f.pending} pending`)) : console.log('No forums yet.'));
    }
  } else if (cmd === 'show') {
    const t = forum.readThread(need(pos[0], '<slug>'), need(pos[1], '<nn>'));
    if (!t) fail('no such thread');
    out(t, printThread);
  } else if (cmd === 'new') {
    const t = forum.createThread(need(pos[0], '<slug>'), { title: args.title, severity: args.severity, scope: args.scope === true ? '' : args.scope,
      body: args.body === '-' ? fs.readFileSync(0, 'utf8') : (args.body === true ? '' : args.body), author: args.author || 'claude' });
    out(t, (x) => console.log(`Created ${x.slug} thread ${pad(x.nn)}: ${x.title}`));
  } else if (cmd === 'reply') {
    const slug = need(pos[0], '<slug>'), nn = need(pos[1], '<nn>');
    const ev = args['if-pending'] ? forum.answerIfPending(slug, nn, readBody()) : forum.addPost(slug, nn, 'claude', readBody());
    out({ ok: true, slug, nn: Number(nn), id: ev.id, ts: ev.ts }, () => console.log(`Replied to ${slug} ${pad(nn)} (${ev.id}).`));
  } else if (cmd === 'close' || cmd === 'reopen') {
    const slug = need(pos[0], '<slug>'), nn = need(pos[1], '<nn>');
    const ev = (cmd === 'close' ? forum.closeThread : forum.reopenThread)(slug, nn, 'claude', args.note === true ? '' : args.note || '');
    out({ ok: true, slug, nn: Number(nn), type: ev.type }, () => console.log(`${cmd === 'close' ? 'Closed' : 'Reopened'} ${slug} ${pad(nn)}.`));
  } else if (cmd === 'pending') {
    const p = forum.pending(args.project === true ? undefined : args.project);
    out(p, (r) => r.length ? r.forEach((t) => console.log(`${t.slug} ${pad(t.nn)}  ${t.title}  (waiting since ${t.waitingSince})\n  ${t.unanswered.map((x) => x.body).join('\n  ---\n  ').replace(/\n/g, '\n  ')}\n`)) : console.log('Nothing pending.'));
  } else if (cmd === 'notify') {
    const state = forum.readNotify();
    const groups = forum.claudeSince(state.lastNotifiedAt);
    if (!groups.length) return out({ ok: true, sent: false, reason: 'nothing new' }, () => console.log('Nothing new to notify.'));
    const base = forum.baseUrl(), live = forum.isLiveTree();
    const total = groups.reduce((n, g) => n + g.replies.length, 0);
    const lines = [`Claude answered ${total} repl${total === 1 ? 'y' : 'ies'} in ${groups.length} forum thread${groups.length === 1 ? '' : 's'}:`, ''];
    for (const g of groups) {
      lines.push(`* [${g.slug}] ${pad(g.nn)} — ${g.title} (${g.replies.length} new)`);
      const last = g.replies[g.replies.length - 1].body.replace(/\s+/g, ' ');
      lines.push(`  "${last.length > 200 ? last.slice(0, 200) + '…' : last}"`);
      lines.push(`  ${base}/forum/open/${g.slug}?t=${g.nn}`, '');
    }
    lines.push('Links open the forum after your dashboard login.');
    const subject = `${live ? '' : '[STAGING] '}Ada: Claude answered ${total} forum repl${total === 1 ? 'y' : 'ies'}`;
    const through = groups.flatMap((g) => g.replies.map((r) => r.ts)).sort().pop();
    if (args['dry-run']) return out({ ok: true, sent: false, dryRun: true, subject, text: lines.join('\n') }, () => console.log(subject + '\n\n' + lines.join('\n')));
    const r = await require('./mailer').sendMail({ subject, text: lines.join('\n') });
    if (!r.ok) return fail(r.error || 'mail failed (nothing marked as notified)');
    forum.writeNotify({ lastNotifiedAt: through, sentAt: new Date().toISOString(), mailId: r.id || null, threads: groups.length, replies: total });
    out({ ok: true, sent: true, threads: groups.length, replies: total, mailId: r.id || null, lastNotifiedAt: through }, () => console.log(`Notified: ${total} repl${total === 1 ? 'y' : 'ies'} in ${groups.length} thread(s).`));
  } else {
    process.stderr.write('usage: forum-cli.js list|show|new|reply|close|reopen|pending|notify … [--json]  (see the header of this file)\n');
    process.exit(2);
  }
}

main().catch((e) => fail(e.message, e.status && e.status < 500 ? 3 : 1));
