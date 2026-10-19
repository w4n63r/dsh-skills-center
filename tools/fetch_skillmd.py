#!/usr/bin/env python3
"""Fetch raw SKILL.md for a set of skills.sh ids.

Production would use GET /api/v1/skills/{id} (Vercel OIDC) and read files[].
This prototype does the equivalent offline-safe thing: shallow-clone each
source repo once, then locate the SKILL.md whose folder or frontmatter name
matches the skill slug.

Output: samples/digest2.json
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile

IDS = [
    "mattpocock/skills/grill-me",
    "anthropics/skills/frontend-design",
    "vercel-labs/agent-skills/vercel-react-best-practices",
    "supabase/agent-skills/supabase-postgres-best-practices",
    "prisma/skills/prisma-postgres",
    "microsoft/azure-skills/azure-compliance",
    "vercel-labs/agent-browser/agent-browser",
    "heygen-com/hyperframes/hyperframes-animation",
    "leonxlnx/taste-skill/design-taste-frontend",
    "designed-by-ai/skills/design-mobile-apps",
    "larksuite/cli/lark-drive",
    "101-skills/superpowers/ai-video-generation",
]

WORK = os.path.join(tempfile.gettempdir(), "dsi-clones")


def clone(repo: str) -> str | None:
    dest = os.path.join(WORK, repo.replace("/", "__"))
    if os.path.isdir(os.path.join(dest, ".git")):
        return dest
    os.makedirs(WORK, exist_ok=True)
    r = subprocess.run(
        ["git", "clone", "--depth", "1", "--quiet", f"https://github.com/{repo}.git", dest],
        capture_output=True, text=True, timeout=180,
    )
    if r.returncode != 0:
        print(f"  ! clone failed {repo}: {r.stderr.strip()[:160]}")
        return None
    return dest


def frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    yml = text.split("---", 2)[1] if text.count("---") >= 2 else ""
    out = {}
    for line in yml.splitlines():
        m = re.match(r"^([a-zA-Z_-]+):\s*(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def locate(root: str, slug: str) -> str | None:
    cands = []
    for dirpath, _dirs, files in os.walk(root):
        if ".git" in dirpath:
            continue
        for f in files:
            if f == "SKILL.md":
                cands.append(os.path.join(dirpath, f))
    if not cands:
        return None
    for p in cands:  # folder name match
        if os.path.basename(os.path.dirname(p)).lower() == slug.lower():
            return p
    for p in cands:  # frontmatter name match
        try:
            fm = frontmatter(open(p, encoding="utf-8", errors="replace").read())
        except OSError:
            continue
        if fm.get("name", "").lower() == slug.lower():
            return p
    if len(cands) == 1:
        return cands[0]
    return None


def main() -> int:
    records = []
    for sid in IDS:
        source, slug = sid.rsplit("/", 1)[0], sid.rsplit("/", 1)[1]
        print(f"[{sid}]")
        root = clone(source)
        if not root:
            records.append({"id": sid, "error": "clone failed"})
            continue
        path = locate(root, slug)
        if not path:
            records.append({"id": sid, "error": "SKILL.md not located"})
            print("  ! SKILL.md not located")
            continue
        raw = open(path, encoding="utf-8", errors="replace").read()
        fm = frontmatter(raw)
        body = raw.split("---", 2)[2] if raw.startswith("---") and raw.count("---") >= 2 else raw
        heads = [h.strip() for h in re.findall(r"^#{1,3}\s+(.+)$", body, re.M)][:12]
        files = [
            os.path.relpath(os.path.join(dp, f), os.path.dirname(path)).replace("\\", "/")
            for dp, _d, fs in os.walk(os.path.dirname(path)) for f in fs
        ]
        records.append({
            "id": sid,
            "source": source,
            "slug": slug,
            "skill_md_path": os.path.relpath(path, root).replace("\\", "/"),
            "frontmatter": fm,
            "headings": heads,
            "body_chars": len(body),
            "files": sorted(files)[:15],
            "body_excerpt": re.sub(r"\s+", " ", body)[:2200],
        })
        print(f"  ok  {os.path.relpath(path, root)}  fm={list(fm)}  body={len(body)}c  files={len(files)}")

    with open("samples/digest2.json", "w", encoding="utf-8") as fh:
        json.dump(records, fh, ensure_ascii=False, indent=2)
    ok = sum(1 for r in records if "error" not in r)
    print(f"\nwrote samples/digest2.json  ok={ok}/{len(records)}")
    if os.path.isdir(WORK):
        shutil.rmtree(WORK, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
