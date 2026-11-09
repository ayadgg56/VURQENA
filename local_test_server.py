#!/usr/bin/env python3
"""Local preview server that serves a test-only copy of the Phoenix HTML."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MOCK = Path(__file__).with_name('supabase-mock.js')
PRODUCTION_URL = 'https://vslyxdkyozhmyazvrpdj.supabase.co'

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/__test__/index.html':
            html = (ROOT / 'index (9).html').read_text(encoding='utf-8')
            html, sdk_count = re.subn(
                r'<script src="https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js@2"></script>',
                '<script src="/__test__/supabase-mock.js"></script>', html, count=1)
            html, config_count = re.subn(
                r"window\.PHOENIX_SUPABASE_CONFIG=\{url:'https://vslyxdkyozhmyazvrpdj\.supabase\.co',anonKey:'[^']+'\};",
                "window.PHOENIX_SUPABASE_CONFIG={url:'http://supabase-mock.local',anonKey:'local-only-test-key'};",
                html, count=1)
            html = html.replace('src="./supabase-compat.js"', 'src="/supabase-compat.js"', 1)
            if sdk_count != 1 or config_count != 1 or PRODUCTION_URL in html:
                self.send_error(500, 'Refusing to serve test page: production config was not safely replaced')
                return
            body = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/__test__/supabase-mock.js':
            body = MOCK.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        print('[local-test-server] ' + fmt % args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Phoenix local test preview: http://{args.host}:{args.port}/__test__/index.html')
    print('Backend mode: in-memory Supabase mock only; production Supabase is blocked.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
