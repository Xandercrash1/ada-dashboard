#!/usr/bin/env bash
set -euo pipefail

echo "========================================="
echo " Deploying Ada Operations Dashboard      "
echo " Target: my-server (158.69.211.140)      "
echo "========================================="

echo "[1/5] Checking whether the server changed since our last deploy..."
# CONTENT-based, not mtime-based (rewritten 2026-08-26). The mtime version raised
# a false positive every time ~/ops/promote.sh rsynced the live tree — promoting
# staging rewrites mtimes without the Mac having changed at all, which would have
# permanently blocked deploys from here.
#
# The real question is not "which file is newer" but "did anything change the
# server since WE last put code there". So deploy.sh records the checksums it
# deployed, and compares against those.
STAMP_FILE=/home/ubuntu/dashboard/.last-deployed-md5
REMOTE_NOW=$(ssh my-server "md5sum /home/ubuntu/dashboard/src/server.js /home/ubuntu/dashboard/public/index.html 2>/dev/null | awk '{print \$1}' | tr '\n' ' '" || echo "")
REMOTE_RECORDED=$(ssh my-server "cat $STAMP_FILE 2>/dev/null" || echo "")

if [ -n "$REMOTE_RECORDED" ] && [ -n "$REMOTE_NOW" ] && [ "$REMOTE_RECORDED" != "$REMOTE_NOW" ]; then
  echo ""
  echo "!!! REFUSING TO DEPLOY: the server's code differs from what this script last deployed. !!!"
  echo "Something changed it on the server — an agent, a promote, or a manual edit."
  echo "Deploying now would discard that. Pull and reconcile first:"
  echo "  rsync -avz -e \"ssh -i /Users/alex/.ssh/vps_agent_key\" ubuntu@158.69.211.140:/home/ubuntu/dashboard/src/server.js /Users/alex/Documents/Ada/Antigravity/dashboard/src/server.js.from-vps"
  echo ""
  echo "(If you have ALREADY reconciled and mean to overwrite, re-run with: ALLOW_OVERWRITE=1 ./deploy.sh)"
  [ "${ALLOW_OVERWRITE:-0}" = "1" ] || exit 1
  echo "ALLOW_OVERWRITE=1 set — proceeding deliberately."
fi

echo "[2/5] Syncing application files to VPS (excluding data/ — the live databases stay put)..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude 'data/' \
  -e "ssh -i /Users/alex/.ssh/vps_agent_key" \
  "/Users/alex/Documents/Ada/Antigravity/dashboard/" \
  ubuntu@158.69.211.140:/home/ubuntu/dashboard/

echo "[3/5] Ensuring PM2 is installed on server..."
ssh my-server 'which pm2 || sudo npm install -g pm2'

echo "[4/5] Installing dependencies & launching PM2 on server..."
ssh my-server 'bash -s' << 'REMOTE_EXEC'
cd /home/ubuntu/dashboard
npm install --production

# Restart or start under PM2
pm2 delete ada-dashboard 2>/dev/null || true
pm2 start src/server.js --name "ada-dashboard"
pm2 save
REMOTE_EXEC

echo "[5/5] Verifying live endpoint on server..."
ssh my-server 'curl -s http://localhost:3000/api/system' | head -c 300

echo ""
echo "========================================="
echo " Dashboard Deployment Successful!        "
echo " Server URL: http://158.69.211.140:3000   "
echo "========================================="

# Record what we just deployed, so the next run can tell "server changed" from
# "server merely re-stamped". Written LAST, only on success.
ssh my-server "md5sum /home/ubuntu/dashboard/src/server.js /home/ubuntu/dashboard/public/index.html | awk '{print \$1}' | tr '\n' ' ' > /home/ubuntu/dashboard/.last-deployed-md5"
echo "[deploy] recorded deployed checksums"
