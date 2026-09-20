"""
shell_check.py — does the service worker precache everything the app needs?

A shell file missing from sw.js's SHELL list loads fine online and 404s the
first time the phone is offline. Also checks that sw.js's CACHE and app.js's
APP_BUILD agree, since one is bumped by hand alongside the other.

    python3 tools/harness/shell_check.py
"""

import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
html = (root / "index.html").read_text()
sw = (root / "sw.js").read_text()
app = (root / "js/app.js").read_text()
css = (root / "css/app.css").read_text()
manifest = (root / "manifest.webmanifest").read_text()

shell = set(re.findall(r"'\./([^']+)'", sw.split("const SHELL")[1].split("];")[0]))
shell.discard("")

needed = set()
needed.update(re.findall(r'href="([^"h][^"]*)"', html))          # local hrefs
needed.update(re.findall(r'src="([^"h][^"]*)"', html))
needed.update(re.findall(r'"src":\s*"([^"]+)"', manifest))
needed.update("js/" + m for m in re.findall(r"import\('\./([^']+)'\)", app))   # dynamic imports, relative to js/
needed.update("js/" + m for m in re.findall(r"from '\./([^']+)'", app))
needed.update(re.findall(r"url\(([^)h][^)]*)\)", css))
needed = {n for n in needed if not n.startswith(("data:", "#"))}
needed.add("index.html")

status = 0
missing = sorted(needed - shell)
extra = sorted(shell - needed - {"manifest.webmanifest"})
for m in missing:
    print(f"MISSING from SHELL: {m}")
    status = 1
for f in sorted(shell):
    if not (root / f).exists():
        print(f"SHELL lists a file that doesn't exist: {f}")
        status = 1
for e in extra:
    if not (root / e).exists():
        print(f"SHELL extra entry missing on disk: {e}")
        status = 1

cache = re.search(r"const CACHE = '([^']+)'", sw).group(1)
build = re.search(r"const APP_BUILD = '([^']+)'", app).group(1)
if cache != build:
    print(f"sw.js CACHE {cache!r} != app.js APP_BUILD {build!r}")
    status = 1
print(f"shell: {len(shell)} entries, build {build}, {'OK' if status == 0 else 'PROBLEMS'}")
sys.exit(status)
