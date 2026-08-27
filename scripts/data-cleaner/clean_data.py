"""Clean a messy CSV file: trim whitespace, normalize headers, drop exact
duplicate rows, standardize date-like columns to YYYY-MM-DD, and report a
summary of what changed.

Usage:
    python3 clean_data.py messy.csv --output cleaned.csv
"""

import argparse
import csv
import re
from datetime import datetime

DATE_FORMATS = ["%m/%d/%Y", "%m-%d-%Y", "%Y/%m/%d", "%d %b %Y", "%B %d, %Y"]


def normalize_header(name: str) -> str:
    name = name.strip().lower()
    name = re.sub(r"[^a-z0-9]+", "_", name)
    return name.strip("_")


def try_parse_date(value: str):
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(value.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def clean_rows(rows: list, headers: list) -> tuple:
    date_like_columns = set()
    for col_index, header in enumerate(headers):
        sample_values = [row[col_index].strip() for row in rows if row[col_index].strip()][:10]
        if sample_values and all(try_parse_date(v) for v in sample_values):
            date_like_columns.add(col_index)

    cleaned = []
    seen = set()
    duplicates_dropped = 0
    dates_normalized = 0

    for row in rows:
        trimmed = [cell.strip() for cell in row]
        for col_index in date_like_columns:
            parsed = try_parse_date(trimmed[col_index])
            if parsed and parsed != trimmed[col_index]:
                trimmed[col_index] = parsed
                dates_normalized += 1

        key = tuple(trimmed)
        if key in seen:
            duplicates_dropped += 1
            continue
        seen.add(key)
        cleaned.append(trimmed)

    return cleaned, duplicates_dropped, dates_normalized, date_like_columns


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean a messy CSV file.")
    parser.add_argument("input", help="Path to the messy input CSV")
    parser.add_argument("--output", default="cleaned.csv", help="Path to write the cleaned CSV")
    args = parser.parse_args()

    with open(args.input, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        raw_headers = next(reader)
        rows = list(reader)

    headers = [normalize_header(h) for h in raw_headers]
    cleaned, duplicates_dropped, dates_normalized, date_cols = clean_rows(rows, headers)

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(cleaned)

    print(f"Rows in:  {len(rows)}")
    print(f"Rows out: {len(cleaned)}")
    print(f"Duplicate rows dropped: {duplicates_dropped}")
    print(f"Date values normalized: {dates_normalized} (column(s): {[headers[i] for i in date_cols] or 'none detected'})")
    print(f"Headers normalized: {list(zip(raw_headers, headers))}")
    print(f"\nSaved cleaned file to {args.output}")


if __name__ == "__main__":
    main()
