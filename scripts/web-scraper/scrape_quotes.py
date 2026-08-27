"""Scrape quotes (text, author, tags) from quotes.toscrape.com into a CSV file.

A sandbox site built for scraping practice, used here as a stand-in for any
paginated listing site (products, prices, leads, etc.) a client wants pulled
into a spreadsheet.

Usage:
    python3 scrape_quotes.py --pages 3 --output quotes.csv
"""

import argparse
import csv
import time
import urllib.request
from html.parser import HTMLParser

BASE_URL = "http://quotes.toscrape.com/page/{}/"


class QuoteParser(HTMLParser):
    """Pulls quote text, author, and tags out of one page's HTML."""

    def __init__(self):
        super().__init__()
        self.quotes = []
        self._current = None
        self._section = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "")

        if tag == "div" and "quote" in classes.split():
            self._current = {"text": "", "author": "", "tags": []}
        elif tag == "span" and "text" in classes.split():
            self._section = "text"
        elif tag == "small" and "author" in classes.split():
            self._section = "author"
        elif tag == "a" and "tag" in classes.split():
            self._section = "tag"

    def handle_data(self, data):
        if self._current is None or self._section is None:
            return
        if self._section == "tag":
            self._current["tags"].append(data.strip())
        else:
            self._current[self._section] += data.strip()

    def handle_endtag(self, tag):
        if tag == "div" and self._current is not None and self._section is None:
            self.quotes.append(self._current)
            self._current = None
        if tag in ("span", "small", "a"):
            self._section = None


def fetch_page(page_num: int) -> str:
    request = urllib.request.Request(
        BASE_URL.format(page_num), headers={"User-Agent": "Mozilla/5.0 (portfolio-demo-scraper)"}
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode("utf-8")


def scrape(pages: int) -> list:
    all_quotes = []
    for page_num in range(1, pages + 1):
        html = fetch_page(page_num)
        parser = QuoteParser()
        parser.feed(html)
        if not parser.quotes:
            print(f"Page {page_num}: no quotes found, stopping (likely past the last page).")
            break
        print(f"Page {page_num}: {len(parser.quotes)} quote(s)")
        all_quotes.extend(parser.quotes)
        time.sleep(0.5)
    return all_quotes


def write_csv(quotes: list, output_path: str) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["text", "author", "tags"])
        writer.writeheader()
        for quote in quotes:
            writer.writerow({**quote, "tags": ", ".join(quote["tags"])})


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape quotes.toscrape.com into a CSV.")
    parser.add_argument("--pages", type=int, default=3, help="Number of pages to scrape")
    parser.add_argument("--output", default="quotes.csv", help="Output CSV path")
    args = parser.parse_args()

    quotes = scrape(args.pages)
    write_csv(quotes, args.output)
    print(f"\nSaved {len(quotes)} quote(s) to {args.output}")


if __name__ == "__main__":
    main()
