# File & Folder Organizer

Sorts every file in a folder into subfolders by type — Images, Documents, Videos, Audio, Archives, and Other. Handles name collisions automatically (never overwrites a file).

**No installation required** — pure Python 3 standard library, runs on macOS/Windows/Linux out of the box.

## Usage

```
python3 organize_files.py /path/to/messy-folder --dry-run   # preview only, nothing moves
python3 organize_files.py /path/to/messy-folder             # actually organizes
```

## Example gig pitch

> "Downloads folder (or desktop, or old external drive) turned into chaos? I'll write you a script that automatically sorts everything into clean, labeled folders by file type — safe dry-run preview included so you see exactly what will move before anything happens."

## Demo

See `demo/` — a small set of sample files sorted by running the script (before/after visible via git history or by re-running with `--dry-run`).
