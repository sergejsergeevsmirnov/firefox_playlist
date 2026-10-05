#!/usr/bin/env python3
# Local HTTP bridge for the "Видеоочередь" Firefox extension.
# Runs an HTTP server on 127.0.0.1:8765 that:
#   GET  /status            -> {"ok": true}
#   POST /download {url,id} -> downloads via yt-dlp, returns {"ok":true,"url":...}
#   POST /cleanup  {id}     -> deletes cached file(s)
#   GET  /<file>            -> serves a cached video with Range support
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = 8765
CACHE_DIR = os.path.join(tempfile.gettempdir(), 'video-queue-cache')
FORMAT = 'best[ext=mp4][acodec!=none]/best[acodec!=none]/best'
# Fallback yt-dlp (bundled Python) only when no standalone yt-dlp.exe is present.
FALLBACK_PYTHON = r'C:\Users\Admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'


def app_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def ytdlp_cmd():
    exe = os.path.join(app_dir(), 'yt-dlp.exe')
    if os.path.isfile(exe):
        return [exe]
    return [FALLBACK_PYTHON, '-m', 'yt_dlp']


def proxy_value():
    cfg = os.path.join(app_dir(), 'config.json')
    try:
        with open(cfg, 'r', encoding='utf-8') as f:
            value = json.load(f).get('proxy')
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        pass
    return 'http://127.0.0.1:2080'

os.makedirs(CACHE_DIR, exist_ok=True)


def log(message):
    try:
        with open(os.path.join(tempfile.gettempdir(), 'video-queue-host.log'), 'a', encoding='utf-8') as f:
            f.write(message + '\n')
    except OSError:
        pass


def run_download(url, vid):
    if not url or not vid:
        return {'ok': False, 'error': 'missing url/id'}
    # Remove any stale partial file so yt-dlp never resumes with a wrong range.
    for name in list(os.listdir(CACHE_DIR)):
        if name.startswith(vid + '.'):
            try:
                os.remove(os.path.join(CACHE_DIR, name))
            except OSError:
                pass
    outtmpl = os.path.join(CACHE_DIR, vid + '.%(ext)s')
    cmd = ytdlp_cmd() + ['-f', FORMAT, '-o', outtmpl,
           '--extractor-args', 'youtube:player_client=android,web',
           '--no-playlist', '--no-warnings', '--no-progress', '--no-part',
           '--no-continue', '--retries', '3', '--fragment-retries', '3',
           '--socket-timeout', '30']
    proxy = proxy_value()
    if proxy:
        cmd += ['--proxy', proxy]
    cmd.append(url)
    last_error = 'yt-dlp failed'
    for attempt in range(2):
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired:
            return {'ok': False, 'error': 'загрузка превысила лимит времени'}
        except OSError as exc:
            return {'ok': False, 'error': f'не удалось запустить yt-dlp: {exc}'}
        if proc.returncode == 0:
            for name in sorted(os.listdir(CACHE_DIR), reverse=True):
                if name.startswith(vid + '.') and not name.endswith('.part'):
                    return {'ok': True, 'url': f'http://127.0.0.1:{PORT}/{name}', 'file': name}
            return {'ok': False, 'error': 'файл не найден после загрузки'}
        last_error = (proc.stderr or proc.stdout or 'yt-dlp failed').strip()[-500:]
        time.sleep(2)
    return {'ok': False, 'error': last_error}


def run_cleanup(vid):
    removed = 0
    for name in os.listdir(CACHE_DIR):
        if not vid or name.startswith(vid + '.'):
            try:
                os.remove(os.path.join(CACHE_DIR, name))
                removed += 1
            except OSError:
                pass
    return {'ok': True, 'removed': removed}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/status':
            self._json(200, {'ok': True, 'cache': CACHE_DIR})
            return
        name = parsed.path.lstrip('/')
        if not name or '/' in name or '\\' in name or name.startswith('.'):
            self.send_error(404)
            return
        path = os.path.join(CACHE_DIR, name)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        ctype = 'video/mp4' if name.endswith('.mp4') else 'application/octet-stream'
        rng = self.headers.get('Range')
        if rng and rng.startswith('bytes='):
            try:
                spec = rng[6:].split(',')[0].strip()
                start_s, _, end_s = spec.partition('-')
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else size - 1
                end = min(end, size - 1)
            except ValueError:
                self.send_error(400)
                return
            if start >= size or start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self._stream(path, start, end - start + 1)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(size))
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self._stream(path, 0, size)

    def _stream(self, path, start, length):
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        try:
            body = json.loads(raw.decode('utf-8')) if raw else {}
        except Exception:
            body = {}
        if parsed.path == '/download':
            url = str(body.get('url', ''))
            vid = str(body.get('id', ''))
            if not url or not vid:
                self._json(400, {'ok': False, 'error': 'missing url/id'})
                return
            log(f'download start id={vid} url={url[:120]}')
            result = run_download(url, vid)
            log(f'download end id={vid} ok={result.get("ok")} err={result.get("error","")[:200]}')
            self._json(200 if result.get('ok') else 500, result)
            return
        if parsed.path == '/cleanup':
            vid = str(body.get('id', ''))
            self._json(200, run_cleanup(vid))
            return
        self._json(404, {'ok': False, 'error': 'unknown endpoint'})

    def log_message(self, *_args):
        pass


class _Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    log(f'host started pid={os.getpid()}')
    server = _Server(('127.0.0.1', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
