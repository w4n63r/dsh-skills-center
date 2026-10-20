#!/usr/bin/env python3
"""Build data/catalog.json from the sample digests + the hand-written zh cards.

This is the local stand-in for the production pipeline (Vercel Cron -> /api/v1).
Same output schema, so the plugin code does not change when the real feed lands.

Inputs
  samples/digest.json   installs / trend_pct / description_en  (skills.sh pages)
  samples/digest2.json  SKILL.md frontmatter / body / file list  (git clone)
  samples/cards.v3.md   hand-written zh cards (介绍 / 用途 / 使用注意事项)

Output
  data/catalog.json
"""

from __future__ import annotations

import json
import math
import re

OFFICIAL_OWNERS = {
    "anthropics", "vercel-labs", "microsoft", "supabase", "prisma",
    "larksuite", "heygen-com", "designed-by-ai", "prisma",
}

FLAG_RULES = [
    ("deprecated", re.compile(r"deprecat|compatibility entry", re.I)),
    ("pointer", re.compile(r"call the skill tool|discovery stub|load `?[a-z-]{3,}`", re.I)),
    ("needs_api_key", re.compile(r"\$[A-Z][A-Z0-9_]*_API_KEY|bearer \$[A-Z_]+")),
    ("needs_external_cli", re.compile(r"npm i -g|az login|belt login|lark-cli|npx skills add", re.I)),
]


def parse_cards(path: str) -> dict[str, dict]:
    """Parse the '### NN · slug（中文名）' + '**介绍** — …' markdown into fields."""
    cards: dict[str, dict] = {}
    cur = None
    field = None
    for raw in open(path, encoding="utf-8").read().splitlines():
        line = raw.rstrip()
        m = re.match(r"^###\s+\d+\s+·\s+([a-z0-9-]+)(?:（(.+)）)?\s*$", line)
        if m:
            cur = {"slug": m.group(1), "title_zh": (m.group(2) or "").strip(), "fields": {}}
            cards[cur["slug"]] = cur
            field = None
            continue
        if cur is None:
            continue
        f = re.match(r"^\*\*(介绍|用途|使用注意事项)\*\*\s*—\s*(.*)$", line)
        if f:
            field = f.group(1)
            cur["fields"][field] = [f.group(2)] if f.group(2).strip() else []
            continue
        if re.match(r"^\*\*|^---\s*$|^#{2,3}\s", line):
            field = None
            continue
        if field and line.strip():
            cur["fields"][field].append(line)
    for c in cards.values():
        c["fields"] = {k: "\n".join(v).strip() for k, v in c["fields"].items()}
    return cards


def detect_flags(rec: dict, body: str) -> list[str]:
    flags = []
    for name, pat in FLAG_RULES:
        if pat.search(body):
            flags.append(name)
    if rec.get("body_chars", 0) < 500:
        flags.append("thin_body")
    if len(rec.get("files") or []) > 10:
        flags.append("has_references")
    return sorted(set(flags))


def main() -> int:
    page = {r["id"]: r for r in json.load(open("samples/digest.json", encoding="utf-8"))}
    docs = json.load(open("samples/digest2.json", encoding="utf-8"))
    cards = parse_cards("samples/cards.v3.md")

    rows = []
    for d in docs:
        if "error" in d:
            continue
        pid = d["id"]
        pg = page.get(pid, {})
        zh = cards.get(d["slug"], {})
        owner = d["source"].split("/")[0].lower()
        rows.append({
            "id": pid,
            "slug": d["slug"],
            "name": d["frontmatter"].get("name") or d["slug"],
            "name_zh": zh.get("title_zh", ""),
            "source": d["source"],
            "source_kind": "well-known" if "." in owner else "github",
            "official": owner in OFFICIAL_OWNERS,
            "installs": pg.get("installs"),
            "trend_pct": pg.get("trend_pct"),
            "description_en": pg.get("description_en") or "",
            "skill_md_path": d.get("skill_md_path"),
            "body_chars": d.get("body_chars"),
            "file_count": len(d.get("files") or []),
            "flags": detect_flags(d, (d.get("body_excerpt") or "") + (d["frontmatter"].get("description") or "")),
            "zh": {
                "intro": zh.get("fields", {}).get("介绍", ""),
                "usage": zh.get("fields", {}).get("用途", ""),
                "notes": zh.get("fields", {}).get("使用注意事项", ""),
            },
        })

    # four-dim score; A has no audit data locally -> neutral 0.5
    insts = [r["installs"] for r in rows if isinstance(r["installs"], int)]
    logs = [math.log10(1 + i) for i in insts]
    lo, hi = min(logs), max(logs)
    for r in rows:
        h = (math.log10(1 + r["installs"]) - lo) / (hi - lo) if hi > lo and isinstance(r["installs"], int) else 0.5
        t = max(-50.0, min(200.0, float(r["trend_pct"] or 0)))
        t = (t + 50) / 250
        c = 1.0 if r["official"] else 0.0
        a = 0.5
        r["score"] = {
            "S": round(0.45 * h + 0.20 * t + 0.20 * c + 0.15 * a, 4),
            "H": round(h, 4), "T": round(t, 4), "C": c, "A": a,
        }

    rows.sort(key=lambda r: -(r["installs"] or 0))
    out = {"version": "sample-2026-10-19", "count": len(rows), "skills": rows}
    with open("data/catalog.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    print(f"wrote data/catalog.json  count={len(rows)}")
    for r in rows:
        inst = "—" if r["installs"] is None else f"{r['installs']:>9}"
        trend = "      —" if r["trend_pct"] is None else f"{r['trend_pct']:>7}"
        print(f"  {r['score']['S']:.3f}  {r['slug']:36s} inst={inst:>9}  {trend}%  {' '.join(r['flags'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
