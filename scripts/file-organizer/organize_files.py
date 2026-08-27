"""Sort files in a folder into subfolders by type (Images, Documents, Videos, Audio, Archives, Other).

Usage:
    python3 organize_files.py <folder> [--dry-run]
"""

import argparse
import shutil
import sys
from pathlib import Path

CATEGORIES = {
    "Images": {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".heic"},
    "Documents": {".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".odt", ".xls", ".xlsx", ".csv", ".ppt", ".pptx"},
    "Videos": {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv"},
    "Audio": {".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"},
    "Archives": {".zip", ".rar", ".7z", ".tar", ".gz"},
}


def category_for(path: Path) -> str:
    ext = path.suffix.lower()
    for category, extensions in CATEGORIES.items():
        if ext in extensions:
            return category
    return "Other"


def unique_destination(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem, suffix, parent = dest.stem, dest.suffix, dest.parent
    counter = 1
    while True:
        candidate = parent / f"{stem} ({counter}){suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def organize(folder: Path, dry_run: bool) -> int:
    moved = 0
    for item in sorted(folder.iterdir()):
        if item.is_dir() or item.name.startswith("."):
            continue
        category = category_for(item)
        target_dir = folder / category
        destination = unique_destination(target_dir / item.name)

        print(f"{item.name}  ->  {category}/{destination.name}")
        if not dry_run:
            target_dir.mkdir(exist_ok=True)
            shutil.move(str(item), str(destination))
        moved += 1
    return moved


def main() -> None:
    parser = argparse.ArgumentParser(description="Organize files in a folder by type.")
    parser.add_argument("folder", help="Path to the folder to organize")
    parser.add_argument("--dry-run", action="store_true", help="Show what would move without moving anything")
    args = parser.parse_args()

    folder = Path(args.folder).expanduser().resolve()
    if not folder.is_dir():
        print(f"Not a folder: {folder}", file=sys.stderr)
        sys.exit(1)

    moved = organize(folder, args.dry_run)
    verb = "Would organize" if args.dry_run else "Organized"
    print(f"\n{verb} {moved} file(s) in {folder}")


if __name__ == "__main__":
    main()
