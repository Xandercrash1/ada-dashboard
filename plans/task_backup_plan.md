# Execution Plan: Automated Task Backups

## Objective
Implement a robust, automated task backup system for the Ubuntu VPS host, ensuring daily compressed backups of application databases/state files are securely stored and rotated.

## Components
1. **Backup Script (`/home/ubuntu/dashboard/scripts/backup.sh`)**:
   - Compresses critical data (databases, configs, task states).
   - Generates timestamped archives (e.g., `backup_YYYY-MM-DD.tar.gz`).
   - Cleans up backups older than retention period (e.g., 30 days).

2. **Cron Automation**:
   - Schedule daily execution at 2:00 AM via crontab.
   - Log output to `/home/ubuntu/dashboard/logs/backup.log`.

3. **Verification & Monitoring**:
   - Weekly test-restore verification script or log check.
   - Health check notification on backup failure.

## Steps for Implementation
1. Create script directory and `backup.sh`.
2. Make script executable (`chmod +x`).
3. Configure crontab entry.
4. Run manual test backup and verify archive integrity.
