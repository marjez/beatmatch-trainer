"""
browser_test.py — run a headless-browser test against the app and collect JSON.

Serves a directory, opens a test page in headless Chrome/Chromium, and waits for
the page to POST its findings back to /result. Works on macOS and Linux.

Every real bug in this project was found this way rather than by reading code:
clipping in the mix, GC stalls freezing the fader, requestAnimationFrame adding
latency, full-track decoding blowing iOS memory. Reach for it before theorising.

Usage:
    python3 tools/harness/browser_test.py <dir-to-serve> <page.html> [--timeout 90]

The page should finish with:
    fetch('/result', {method:'POST', body: JSON.stringify(findings)})
"""

import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
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


def serve(directory: Path, port: int, out: Path):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(directory), **k)

        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            out.write_bytes(self.rfile.read(n))
            self.send_response(204)
            self.end_headers()

    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), H)
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

    port = 8900
    # ignore_cleanup_errors: the browser is still flushing its profile as we exit
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        out = Path(tmp) / "result.json"
        httpd = serve(directory, port, out)
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
        print(json.dumps(json.loads(out.read_text()), indent=1))


if __name__ == "__main__":
    main()
