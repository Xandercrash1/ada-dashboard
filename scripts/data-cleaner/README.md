# Spreadsheet / CSV Data Cleaner

Cleans a messy CSV export: trims stray whitespace, normalizes column headers (e.g. `" Order Date"` → `order_date`), drops exact duplicate rows, auto-detects and standardizes date columns to `YYYY-MM-DD`, and prints a summary of exactly what changed.

**No installation required** — pure Python 3 standard library (`csv`, `datetime`), no `pip install` needed.

## Usage

```
python3 clean_data.py messy.csv --output cleaned.csv
```

## Example gig pitch

> "Got a spreadsheet export full of inconsistent formatting, duplicate rows, or mismatched date formats? I'll write a script that cleans it up automatically and gives you a clear before/after summary — no manual find-and-replace."

## Demo

`sample_messy_data.csv` → run the script → `sample_cleaned_output.csv`. Example run went from 5 messy rows (inconsistent header spacing, mixed whitespace, 2 exact duplicates) down to 3 clean rows with normalized headers and ISO dates.
