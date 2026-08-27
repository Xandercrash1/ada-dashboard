# Ada Operations Hub — Full Stack Dashboard

The Ada Operations Hub is a production Node.js + Express web dashboard running on the remote Ubuntu VPS (`158.69.211.140`), proxied on ports 80 and 443 via Caddy.

---

## 1. Architecture & Core Modules

```
/home/ubuntu/dashboard/
├── data/
│   ├── tasks.json             # Tasks database
│   └── agent_sessions.json    # Agent conversation history & state
├── plans/                     # Shared cross-agent execution plans (.md)
├── public/
│   └── index.html             # Responsive Single Page Application (Tailwind + JS)
├── scripts/
│   ├── web-scraper/           # Paginated Python quote scraper
│   ├── data-cleaner/          # CSV data normalizer
│   └── file-organizer/        # Extension-based directory organizer
├── src/
│   └── server.js              # Express REST API, Telemetry, and Agent Engine
├── deploy.sh                  # One-click deployment script from local Mac
└── package.json               # Node.js dependencies (express, cors)
```

---

## 2. REST API Endpoints

### System & Telemetry
* `GET /api/system`: Hardware telemetry (RAM, CPU load averages, NVMe disk usage, uptime, active tmux sessions).

### Tasks & Daily Planner
* `GET /api/tasks`: Get all tasks.
* `POST /api/tasks`: Create task (`{ title, category, priority, status, dueDate, notes }`).
* `PUT /api/tasks/:id`: Update task.
* `DELETE /api/tasks/:id`: Delete task.

### Automation & Scripts
* `GET /api/scripts`: Get script registry.
* `POST /api/scripts/run`: Execute script (`{ id, customArgs }`).

### Interactive Terminal Console
* `POST /api/terminal/exec`: Execute bash command directly on host (`{ command }`).

### AI Agent Control Center
* `GET /api/agent/sessions`: Get list of active agent sessions.
* `POST /api/agent/sessions`: Create new agent session (`{ name, role, model }`).
* `GET /api/agent/sessions/:id`: Get session details & messages.
* `DELETE /api/agent/sessions/:id`: Delete session.
* `POST /api/agent/sessions/:id/chat`: Send message to agent (`{ prompt }`). Executes multi-turn tool calling loop (`run_bash`, `read_file`, `write_file`, `list_directory`).
* `POST /api/agent/sessions/:id/clear`: Clear conversation history.

---

## 3. How to Deploy Updates from Mac

```bash
cd /Users/alex/Documents/Ada/Antigravity/dashboard
./deploy.sh
```
