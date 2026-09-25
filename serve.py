#!/usr/bin/env python3
"""Serves web/ and puts every traded Pokémon into PK3/ at the project root.

run.bat used to start `python -m http.server -d web`, which serves the page but has
nowhere to put a file. A browser cannot write into the project folder on its own: it
either asks the user to point at a folder, or it goes through a server. This is that
server, so a Pokémon that arrives from the Switch lands in PK3/ without anyone
pressing anything.

    python3 serve.py [port]        # 8000 by default, 127.0.0.1 only

GET  /api/pk3           -> {"folder": "...", "ready": true}   (how the page finds it)
POST /api/pk3/<name>    -> writes the body to PK3/<name>      (how a trade is saved)

Nothing here reaches the network: the socket is bound to the loopback address, and the
page only ever talks to it from the same machine.
"""

import http.server
import json
import re
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
PK3 = ROOT / "PK3"
ENDPOINT = "/api/pk3"

# Windows and macOS refuse these in a file name; a name made only of them would leave
# nothing behind, which is what the fallback is for.
FORBIDDEN = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
MAX_BYTES = 1024 * 1024


def safe_name(raw):
    name = FORBIDDEN.sub("", raw or "").strip().strip(".")
    if not name:
        name = "pokemon"
    if not name.lower().endswith(".pk3"):
        name += ".pk3"
    return name[:120]


def free_path(name):
    """Two Pokémon can share a name, and neither should overwrite the other."""
    path = PK3 / name
    if not path.exists():
        return path
    stem, suffix = name[:-4], name[-4:]
    for n in range(2, 1000):
        candidate = PK3 / f"{stem}-{n}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"too many files named like {name}")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def reply(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path.rstrip("/") == ENDPOINT:
            self.reply(200, {"folder": str(PK3), "ready": True})
            return
        super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith(ENDPOINT + "/"):
            self.reply(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BYTES:
            self.reply(400, {"error": f"a .pk3 is between 1 and {MAX_BYTES} bytes"})
            return
        data = self.rfile.read(length)
        try:
            PK3.mkdir(parents=True, exist_ok=True)
            target = free_path(safe_name(urllib.parse.unquote(path[len(ENDPOINT) + 1:].split("?")[0])))
            target.write_bytes(data)
        except OSError as error:
            self.reply(500, {"error": str(error)})
            return
        print(f"  saved {target.relative_to(ROOT)}  ({len(data)} bytes)", flush=True)
        self.reply(200, {"file": target.name, "folder": str(PK3)})

    def log_message(self, fmt, *args):
        # Saves already announce themselves; this is the static traffic underneath.
        if ENDPOINT not in (args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    if not WEB.is_dir():
        sys.exit(f"no web/ folder next to {Path(__file__).name}")

    PK3.mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("GB-Link Switch LDN")
    print(f"  page       http://127.0.0.1:{port}/")
    print(f"  .pk3 files {PK3}")
    print("  Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
