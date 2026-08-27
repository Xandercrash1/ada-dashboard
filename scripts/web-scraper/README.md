# Web Scraper → CSV

Scrapes a paginated listing site and saves the results (text, author, tags) to a CSV file, ready to open in Excel/Google Sheets. Built against `quotes.toscrape.com` — a public sandbox site made for scraping practice — as a stand-in for any real paginated page a client wants pulled into a spreadsheet (product listings, prices, directory entries, leads, etc.).

**No installation required** — pure Python 3 standard library (`urllib` + `html.parser`), no `pip install` needed.

## Usage

```
python3 scrape_quotes.py --pages 3 --output quotes.csv
```

## Example gig pitch

> "Need data from a website turned into a spreadsheet — product prices, directory listings, contact info, whatever's publicly on the page? I'll write a script that pulls it all into a clean CSV automatically, no manual copy-pasting."

## Notes for real client sites

- Always check the target site's Terms of Service / `robots.txt` before scraping for a client — some sites explicitly disallow it.
- On macOS, if a target site is `https://` and you hit `CERTIFICATE_VERIFY_FAILED`, run **Install Certificates.command** (comes with the python.org installer, usually in `/Applications/Python 3.x/`) to fix local root certificates.
- Real sites vary in HTML structure — this script's parser is written specifically for quotes.toscrape.com's markup and would need adjusting per target site (that adjustment work is itself part of the billable gig).
