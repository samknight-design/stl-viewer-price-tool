"""
No-cache dev server for 3D Print Price Calculator.
Sends Cache-Control: no-cache on every response so ES module
sub-imports are always freshly fetched after file changes.
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8744

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # Allow ES module imports from CDN (Three.js)
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the original access log
        super().log_message(fmt, *args)

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    # A plain socketserver.TCPServer handles one connection at a time,
    # blocking on it fully -- a single stalled/incomplete client request
    # (or a lingering keep-alive connection) hangs the server for every
    # other client. Threading each request in its own thread means one
    # stuck connection can't take down the whole dev server.
    daemon_threads = True
    allow_reuse_address = True

with ThreadingHTTPServer(('', PORT), NoCacheHandler) as httpd:
    print(f'No-cache dev server running at http://localhost:{PORT}')
    httpd.serve_forever()
