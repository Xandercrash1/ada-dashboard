const fs = require('fs');
const path = require('path');

const FEEDBACK_FILE = path.join(__dirname, '../data/feedback.json');
const ERROR_LOG = path.join(process.env.HOME, '.pm2/logs/ada-dashboard-error.log');
const CURSOR_FILE = path.join(__dirname, '../data/.bug-crawler-cursor');

async function run() {
  console.log('[Crawler] Waking up...');
  
  if (!fs.existsSync(ERROR_LOG)) {
    console.log('[Crawler] No error log found.');
    return;
  }

  const stat = fs.statSync(ERROR_LOG);
  let cursor = 0;
  if (fs.existsSync(CURSOR_FILE)) {
    cursor = parseInt(fs.readFileSync(CURSOR_FILE, 'utf8'), 10);
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
  fs.writeFileSync(CURSOR_FILE, stat.size.toString());

  if (!newLogs) return;

  // We have new logs. Ask Ollama to check if there's a real crash or error here.
  console.log('[Crawler] Found new logs. Sending to Ollama for analysis...');
  
  const prompt = `You are an autonomous bug crawler. Analyze the following recent server error logs.
You MUST reply with ONLY a JSON object.
If there is no real error (e.g. just a benign warning or empty log), reply with {"has_error": false}.
If there is a real crash, exception, or significant bug, reply with:
{
  "has_error": true,
  "title": "A short, descriptive title of the bug",
  "body": "A detailed explanation of the crash, the stack trace summary, and potential causes.",
  "urgency": "normal" // or "high", "critical"
}

Logs:
\`\`\`
${newLogs.slice(-2000)}
\`\`\`
`;

  try {
    const res = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        format: 'json',
        prompt: prompt,
        stream: false,
        options: {
          num_thread: 1, // Restrict to 1 CPU thread to prevent CPU spiking
          num_ctx: 2048  // Restrict context window to keep RAM usage low
        }
      })
    });
    
    const data = await res.json();
    let text = data.response.trim();
    const ticket = JSON.parse(text);
    if (!ticket.has_error) {
      console.log('[Crawler] Model determined there are no actionable errors.');
      return;
    }
    
    // Write ticket
    const feedback = fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) : [];
    
    feedback.unshift({
      id: 'fb-' + Date.now(),
      type: 'bug',
      title: ticket.title || 'Automated Bug Report',
      body: ticket.body || 'The crawler detected an anomaly but failed to format the description.',
      urgency: ticket.urgency || 'normal',
      status: 'new',
      createdAt: new Date().toISOString(),
      processedBy: 'crawler-llama3.2',
      notes: 'Generated autonomously via limited-resource background crawl.'
    });
    
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2));
    console.log('[Crawler] Successfully filed bug ticket:', ticket.title);
    
  } catch (err) {
    console.error('[Crawler] Failed to process logs through Ollama:', err.message);
  }
}

run();
