#!/usr/bin/env python3
"""检查 main.js 引用的 DOM id 是否都存在于 index.html。

重构后曾出现「引用了已删除元素」的问题，这个检查防止再次发生。
"""
import os
import re
import sys

# 以脚本所在位置为基准，保证在任何机器上都能直接运行
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main():
    src = open(f"{BASE}/js/main.js", encoding="utf-8").read()
    ui = open(f"{BASE}/js/cloudtts-ui.js", encoding="utf-8").read()
    html = open(f"{BASE}/index.html", encoding="utf-8").read()

    html_ids = set(re.findall(r'id="([a-zA-Z0-9\-_]+)"', html))

    problems = []
    for name, code in [("main.js", src), ("cloudtts-ui.js", ui)]:
        ids = set(re.findall(r"\$\('#([a-zA-Z0-9\-_]+)'\)", code))
        missing = sorted(i for i in ids if i not in html_ids)
        if missing:
            print(f"── {name} 引用了不存在的 id ──")
            for m in missing:
                idx = code.find(f"$('#{m}')")
                line = code[:idx].count("\n") + 1
                print(f"   #{m}   ({name}:{line})")
            problems.extend(missing)

    print()
    if problems:
        print(f"✗ 共 {len(problems)} 个缺失引用")
        return 1
    print("✓ 所有 DOM 引用都存在")
    return 0


if __name__ == "__main__":
    sys.exit(main())
