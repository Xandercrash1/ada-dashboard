# Ada Operations Server Architecture Plan

## Current Setup
- Host: Ubuntu 26.04 LTS (158.69.211.140)
- Reverse Proxy: Caddy (:80 & :443 -> :3000)
- Process Manager: PM2 ('ada-dashboard')
- Multi-Agent Runtime: Google Antigravity & Claude Code
- Shared Plans Directory: /home/ubuntu/dashboard/plans/
