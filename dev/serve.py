#!/usr/bin/env python3
"""開発サーバー。GitHub Pages のサブパス配信を再現するため /ruby-factory/ にマウントし、キャッシュを無効にする。

使い方: python3 dev/serve.py [port]   → http://localhost:8940/ruby-factory/
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOUNT = "/ruby-factory"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".rb": "text/plain; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        if path == MOUNT:
            path = MOUNT + "/"
        if not path.startswith(MOUNT + "/"):
            return os.path.join(ROOT, "__not_found__")
        return super().translate_path(path[len(MOUNT):])

    def do_GET(self):
        if self.path.split("?")[0] == MOUNT:
            self.send_response(301)
            self.send_header("Location", MOUNT + "/")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8940
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
