#!/usr/bin/env python3
"""检查 GitHub 远程仓库是否包含本地最新代码。"""
import json
import sys
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO = "justsmile3/fairy-mobile"


def api(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "check", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


def main():
    print("=== 远程仓库最近提交 ===")
    try:
        commits = api(f"https://api.github.com/repos/{REPO}/commits?per_page=6")
        for c in commits:
            msg = c["commit"]["message"].split("\n")[0]
            print(f"  {c['sha'][:8]}  {msg[:56]}")
    except Exception as e:
        print("  查询失败:", e)
        return 1

    print()
    print("=== 远程 main 分支 SHA ===")
    try:
        ref = api(f"https://api.github.com/repos/{REPO}/branches/main")
        print("  ", ref["commit"]["sha"][:12])
    except Exception as e:
        print("  查询失败:", e)

    print()
    print("=== 各次改动涉及的文件是否在远程 ===")
    try:
        tree = api(f"https://api.github.com/repos/{REPO}/git/trees/main?recursive=1")
        paths = {t["path"] for t in tree.get("tree", []) if t["type"] == "blob"}
    except Exception as e:
        print("  查询失败:", e)
        return 1

    wanted = [
        "index.html", "css/app.css", "css/mascot.css",
        "js/main.js", "js/speech-text.js", "js/chime.js", "js/hdd-bg.js",
        "js/api.js", "js/store.js", "js/search.js", "js/floating-ball.js",
        "tools/verify-apk.mjs", "tools/verify-search.mjs", "README.md",
        "android/app/src/main/java/com/fairy/mobile/FloatingBallService.java",
        "android/app/src/main/java/com/fairy/mobile/SearchClient.java",
    ]
    missing = []
    for f in wanted:
        ok = f in paths
        if not ok:
            missing.append(f)
        print(f"  {'OK  ' if ok else 'MISS'} {f}")

    print()
    print(f"远程文件总数：{len(paths)}")
    print()
    if missing:
        print(f"✗ 有 {len(missing)} 个文件不在远程")
        return 1
    print("✓ 远程包含全部期望文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
