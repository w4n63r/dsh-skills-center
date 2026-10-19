#!/usr/bin/env python3
"""Probe skills.sh to prove out the catalog pipeline.

For each target query it harvests candidate skills from the public search API,
then fetches each skill page and extracts the raw material a Chinese-catalog
builder would need: english description, body headings, capability bullets,
install count and the weekly install series (trend).

Output: samples/digest.json  (compact, one record per skill)

Usage: python tools/probe_catalog.py [max_skills]
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request

SEARCH = "https://skills.sh/api/search"
BASE = "https://www.skills.sh"
UA = {"User-Agent": "Mozilla/5.0 (compatible; dsh-skills-center/0.1; catalog probe)"}

QUERIES = [
    "design", "testing", "postgres", "react", "nextjs", "security",
    "documentation", "mobile app", "marketing", "pdf", "excel",
    "kubernetes", "accessibility", "video editing", "database schema",
    "code review", "typescript", "presentation",
]


def get(url: str, retries: int = 2) -> str:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed {url}: {last}")


def search(query: str, limit: int = 8) -> list[dict]:
    q = urllib.parse.urlencode({"q": query, "limit": limit})
    try:
        data = json.loads(get(f"{SEARCH}?{q}"))
    except Exception as exc:  # noqa: BLE001
        print(f"  ! search failed for {query!r}: {exc}", file=sys.stderr)
        return []
    return data.get("skills") or []


def text_of(fragment: str) -> str:
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return html.unescape(re.sub(r"\s+", " ", fragment)).strip()


def extract(page: str) -> dict:
    """Pull the fields a Chinese card needs out of one skill page."""
    out: dict = {}

    # installs headline, e.g. <span>Installs</span></div><div ...>3.9M</div>
    m = re.search(r"Installs</span></div><div[^>]*>([\d.,]+[KMB]?)</div>", page)
    out["installs_text"] = m.group(1) if m else None

    # weekly install series -> trend signal
    m = re.search(r'aria-label="Weekly installs: ([\d,\s]+)"', page)
    if m:
        series = [int(x.replace(",", "")) for x in m.group(1).split(",") if x.strip()]
        out["weekly_series"] = series
        if len(series) >= 4 and series[-1]:
            first_half = sum(series[: len(series) // 2]) / max(1, len(series) // 2)
            second_half = sum(series[len(series) // 2:]) / max(1, len(series) - len(series) // 2)
            out["trend_pct"] = round((second_half - first_half) / first_half * 100, 1) if first_half else None

    # english description (JSON-escaped inside the RSC payload)
    m = re.search(r'"description":"(.{20,600}?)"', page)
    if m:
        try:
            out["description_en"] = json.loads('"' + m.group(1) + '"')
        except Exception:  # noqa: BLE001
            out["description_en"] = m.group(1)

    # body structure: headings + bullets, deduped, order preserved
    heads, bullets = [], []
    for tag in re.findall(r"<h[23][^>]*>(.*?)</h[23]>", page, re.S):
        t = text_of(tag)
        if t and t not in heads:
            heads.append(t)
    for li in re.findall(r"<li[^>]*>(.*?)</li>", page, re.S):
        t = text_of(li)
        if t and len(t) > 8 and t not in bullets:
            bullets.append(t)
    out["headings"] = heads[:12]
    out["bullets"] = bullets[:12]

    # security audit partners visible on the page
    out["audit_partners"] = sorted(
        {p for p in ("Snyk", "Socket", "Gen Agent Trust Hub", "Runlayer", "ZeroLeaks") if p in page}
    )
    return out


def main() -> int:
    cap = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    seen: dict[str, dict] = {}

    for query in QUERIES:
        print(f"[search] {query}")
        for hit in search(query):
            sid = hit.get("id")
            if not sid or sid in seen:
                continue
            seen[sid] = {
                "id": sid,
                "name": hit.get("name"),
                "source": hit.get("source"),
                "installs": hit.get("installs"),
                "found_by": query,
            }
        time.sleep(0.3)

    # diverse: at most one skill per source repo, highest installs first
    by_source: dict[str, dict] = {}
    for rec in sorted(seen.values(), key=lambda r: -(r.get("installs") or 0)):
        by_source.setdefault(rec["source"], rec)
    picked = list(by_source.values())[:cap]

    records = []
    for i, rec in enumerate(picked, 1):
        url = f"{BASE}/{rec['id']}"
        print(f"[page {i}/{len(picked)}] {rec['id']}")
        try:
            rec.update(extract(get(url)))
        except Exception as exc:  # noqa: BLE001
            rec["error"] = str(exc)
        rec["url"] = url
        records.append(rec)
        time.sleep(0.4)

    with open("samples/digest.json", "w", encoding="utf-8") as fh:
        json.dump(records, fh, ensure_ascii=False, indent=2)

    print(f"\nwrote samples/digest.json with {len(records)} records")
    for rec in records:
        print(
            f"  {rec.get('installs') or 0:>9}  trend={rec.get('trend_pct')}%  "
            f"audit={len(rec.get('audit_partners') or [])}  {rec['id']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
