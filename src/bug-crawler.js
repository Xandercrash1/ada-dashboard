const fs = require('fs');
const path = require('path');
const gemini = require('./gemini-client');

// 2026-10-06 (Auto Ticket Processing): analysis moved from local Ollama
// llama3.2:3b to Gemini Flash (Alex: the local model isn't smart enough).
// gemini-client handles retries and the 3.8 -> 3.6 -> flash-lite chain.
// The cursor now advances only after a successful analysis, so a night when
// Gemini is unreachable is retried the next night instead of silently lost.

const FEEDBACK_FILE = path.join(__dirname, '../data/feedback.json');
const ERROR_LOG = process.env.CRAWLER_ERROR_LOG || path.join(process.env.HOME, '.pm2/logs/ada-dashboard-error.log');
const CURSOR_FILE = path.join(__dirname, '../data/.bug-crawler-cursor');
const MAX_LOG_CHARS = 12000; // newest part of the new log lines sent for analysis

async function run() {
  console.log(`[Crawler] Waking up... ${new Date().toISOString()}`);

  if (!fs.existsSync(ERROR_LOG)) {
    console.log('[Crawler] No error log found.');
    return;
  }

  const stat = fs.statSync(ERROR_LOG);
  let cursor = 0;
  if (fs.existsSync(CURSOR_FILE)) {
    cursor = parseInt(fs.readFileSync(CURSOR_FILE, 'utf8'), 10) || 0;
  }

  if (cursor > stat.size) cursor = 0; // Log rotated
  if (cursor === stat.size) {
    console.log('[Crawler] No new errors since last run.');
    return;
  }

  // Read only the new portion of the log
  const fd = fs.openSync(ERROR_LOG, 'r');
  const buffer = Buffer.alloc(stat.size - cursor);
  fs.readSync(fd, buffer, 0, buffer.length, cursor);
  fs.closeSync(fd);

  const newLogs = buffer.toString('utf8').trim();
  const advanceCursor = () => fs.writeFileSync(CURSOR_FILE, stat.size.toString());

  if (!newLogs) { advanceCursor(); return; }

  console.log(`[Crawler] Found ${newLogs.length} chars of new logs. Sending to Gemini for analysis...`);

  const prompt = `You are an autonomous bug crawler for a Node.js dashboard (Express, pm2). Analyze the following recent server error log lines.
Reply with ONLY a JSON object.
If there is no real error (benign warnings, expected 401s, noise), reply with {"has_error": false}.
If there is a real crash, unhandled exception, or significant bug, reply with:
{
  "has_error": true,
  "title": "A short, descriptive title of the bug",
  "body": "What failed, the stack trace summary (file:line where visible), how often it appears, and likely causes.",
  "urgency": "normal" | "high" | "critical"
}
If several distinct bugs appear, report the most serious one and list the others briefly at the end of "body".

Logs:
\`\`\`
${newLogs.slice(-MAX_LOG_CHARS)}
\`\`\`
`;

  let result;
  try {
    result = await gemini.generate({ prompt, json: true });
  } catch (err) {
    // Cursor NOT advanced: these lines are analysed again on the next run.
    console.error('[Crawler] Gemini analysis failed; will retry these logs next run:', err.message);
    process.exitCode = 1;
    return;
  }

  let ticket;
  try {
    ticket = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (err) {
    console.error(`[Crawler] ${result.model} returned unparseable JSON; will retry next run:`, result.text.slice(0, 200));
    process.exitCode = 1;
    return;
  }

  if (!ticket.has_error) {
    advanceCursor();
    console.log(`[Crawler] ${result.model}: no actionable errors.`);
    return;
  }

  const feedback = fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) : [];
  const now = new Date().toISOString();
  feedback.unshift({
    id: 'fb-' + Date.now(),
    type: 'bug',
    title: ticket.title || 'Automated Bug Report',
    body: ticket.body || 'The crawler detected an anomaly but failed to format the description.',
    urgency: ticket.urgency || 'normal',
    status: 'new',
    createdAt: now,
    updatedAt: now,
    processedBy: `crawler-${result.model}`,
    notes: 'Agent-made: generated autonomously by the nightly bug crawler from the dashboard error log. Verify before acting.'
  });
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2));
  advanceCursor();
  console.log(`[Crawler] ${result.model} filed bug ticket:`, ticket.title);
}

run();
