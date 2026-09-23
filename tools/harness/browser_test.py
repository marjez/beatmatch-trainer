"""
browser_test.py — run a headless-browser test against the app and collect JSON.

Serves a directory, opens a test page in headless Chrome/Chromium, and waits for
the page to POST its findings back to /result. Works on macOS and Linux.

Every real bug in this project was found this way rather than by reading code:
clipping in the mix, GC stalls freezing the fader, requestAnimationFrame adding
latency, full-track decoding blowing iOS memory. Reach for it before theorising.

Usage:
    python3 tools/harness/browser_test.py <dir-to-serve> <page.html> [--timeout=90] [--mount=/crate=DIR]

The page should finish with:
    fetch('/result', {method:'POST', body: JSON.stringify(findings)})
"""

import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

BROWSERS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
]


def find_browser():
    for b in BROWSERS:
        if os.path.isabs(b):
            if os.path.exists(b):
                return b
        elif shutil.which(b):
            return shutil.which(b)
    return None


def serve(directory: Path, port: int, out: Path, mounts=None, bind="127.0.0.1"):
    mounts = mounts or {}

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(directory), **k)

        def log_message(self, *a):
            pass

        def translate_path(self, path):
            clean = path.split("?", 1)[0].split("#", 1)[0]
            for prefix, root in mounts.items():
                if clean.startswith(f"/{prefix}/"):
                    rel = clean[len(prefix) + 2:]
                    target = (root / urllib.parse.unquote(rel)).resolve()
                    if root not in target.parents and target != root:
                        return str(root / "__outside_mount__")     # confine to the mount
                    return str(target)
            return super().translate_path(path)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def do_GET(self):
            # Range support: the demo crate fetches a byte window of each track
            # rather than the whole file, and the app refuses a 200 answer to a
            # ranged request (the grid it ships is rebased to the slice). Without
            # this the ranged path could not be tested at all.
            rng = self.headers.get("Range")
            path = self.translate_path(self.path)
            if not rng or not os.path.isfile(path):
                return super().do_GET()
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if not m:
                return super().do_GET()
            size = os.path.getsize(path)
            start = int(m.group(1)) if m.group(1) else 0
            end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            with open(path, "rb") as f:
                f.seek(start)
                body = f.read(end - start + 1)
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            out.write_bytes(self.rfile.read(n))
            self.send_response(204)
            self.end_headers()

    # Threaded: the app, its service worker and a test all fetch at once, and a
    # 10 MB audio file on a single-threaded server stalls everything behind it.
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    httpd = socketserver.ThreadingTCPServer((bind, port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    timeout = 90
    for a in sys.argv[1:]:
        if a.startswith("--timeout"):
            timeout = int(a.split("=")[1]) if "=" in a else timeout

    if len(args) < 2:
        print(__doc__)
        sys.exit(1)

    directory, page = Path(args[0]).resolve(), args[1]
    browser = find_browser()
    if not browser:
        print("No Chrome/Chromium found. On Ubuntu: sudo apt install chromium-browser")
        sys.exit(2)

    # --mount=/prefix=DIR serves a second directory under /prefix/ so a test can
    # load the real app and a synthetic crate from one origin.
    mounts = {}
    for a in sys.argv[1:]:
        if a.startswith("--mount="):
            prefix, _, path = a[len("--mount="):].partition("=")
            mounts[prefix.strip("/")] = Path(path).resolve()

    port = 8900
    # ignore_cleanup_errors: the browser is still flushing its profile as we exit
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        out = Path(tmp) / "result.json"
        httpd = serve(directory, port, out, mounts)
        proc = subprocess.Popen(
            [browser, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--autoplay-policy=no-user-gesture-required",
             f"--user-data-dir={tmp}/profile",
             f"http://127.0.0.1:{port}/{page}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + timeout
        while time.time() < deadline and not out.exists():
            time.sleep(0.5)
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()
        if not out.exists():
            print(f"No result within {timeout}s — the page probably threw before posting.")
            sys.exit(3)

        result = json.loads(out.read_text())
        print(json.dumps(result, indent=1))

        # A green exit used to mean "the page posted something", not "the page
        # passed": a test could report verdict FAIL with a populated failures
        # list and this still exited 0. Audited and found: the reveal's colour
        # band was wrong in a mutation, rounds.html caught it, and the run was
        # reported as a pass.
        problems = []
        if isinstance(result, dict):
            if result.get("fatal"):
                problems.append(f"fatal: {result['fatal']}")
            for f in result.get("failures") or []:
                problems.append(str(f))
            if result.get("jsErrors"):
                problems.append(f"jsErrors: {result['jsErrors']}")
            # A page with no failures list and no opt-out is a measurement dump
            # that can never fail — which is how press-to-sound regressed by
            # 90 ms with the suite green.
            if "failures" not in result and not result.get("measurementOnly"):
                problems.append("page posted no 'failures' list and did not set measurementOnly")
        if problems:
            print("\nFAIL:", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
