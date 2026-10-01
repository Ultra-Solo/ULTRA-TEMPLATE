"""The composition root: read configuration, choose the adapters, serve until asked to stop.

This is the only module that may import from every layer, and the only one that reads the clock, the
environment or a random source. Everything below it receives what it needs.

The development server is the standard library's. ``app`` is an ordinary WSGI application, so
production deployment is ``gunicorn --pythonpath src 'api_py.main:app'`` (or waitress on Windows) with no code change.
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import socketserver
import sys
import threading
import time
from contextlib import suppress
from datetime import UTC, datetime
from types import FrameType
from typing import Any, ClassVar, cast
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from api_py.adapters.http import create_app
from api_py.adapters.memory_task_repository import MemoryTaskRepository
from api_py.adapters.request_log import with_request_log
from api_py.application.task_service import TaskService
from api_py.config import Config, ConfigError, load_config

_log_lock = threading.Lock()


def log(entry: dict[str, object]) -> None:
    """One JSON object per line, on stdout, with the time first, like api-go's slog handler.

    One write per line, under a lock: print writes the text and its newline separately, so lines from
    request threads at once interleaved into lines that were not JSON.
    """
    line = json.dumps({"time": SystemClock().now(), **entry}) + "\n"
    with _log_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


class SystemClock:
    def now(self) -> str:
        # UTC to the millisecond with a Z, as every task service writes a time.
        return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class RandomIds:
    def next(self) -> str:
        return secrets.token_hex(8)


class ThreadingWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
    """One daemon thread per connection, so one still blocked when SHUTDOWN_TIMEOUT passes does not keep
    the process alive. socketserver waits only for threads that are not daemons, so this server keeps
    its own list and waits for it in finish_requests."""

    daemon_threads = True

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._requests: list[threading.Thread] = []
        self._requests_lock = threading.Lock()

    def process_request(self, request: Any, client_address: Any) -> None:
        thread = threading.Thread(target=self.process_request_thread, args=(request, client_address), daemon=True)
        self.track(thread)

    def track(self, thread: threading.Thread) -> None:
        with self._requests_lock:
            self._requests = [t for t in self._requests if t.is_alive()] + [thread]
        thread.start()

    def finish_requests(self, timeout_s: float) -> bool:
        """Waits up to `timeout_s` for every request in flight; False if one is still running."""
        deadline = time.monotonic() + timeout_s
        with self._requests_lock:
            requests = list(self._requests)
        for thread in requests:
            thread.join(max(0.0, deadline - time.monotonic()))
        return not any(thread.is_alive() for thread in requests)


class _DeadlineInput:
    def __init__(self, stream: Any, connection: Any, deadline: Any, idle_timeout: float) -> None:
        self._stream = stream
        self._connection = connection
        self._deadline = deadline
        self._idle_timeout = idle_timeout

    def _read1(self, size: int) -> bytes:
        remaining = self._deadline() - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request receive deadline exceeded")
        self._connection.settimeout(remaining)
        try:
            return cast(bytes, self._stream.read1(size))
        finally:
            self._connection.settimeout(self._idle_timeout)

    def read(self, size: int = -1) -> bytes:
        if size == 0:
            return b""
        chunks: list[bytes] = []
        remaining = size
        while remaining != 0:
            chunk = self._read1(64 * 1024 if remaining < 0 else remaining)
            if not chunk:
                break
            chunks.append(chunk)
            if remaining > 0:
                remaining -= len(chunk)
        return b"".join(chunks)

    def readline(self, size: int = -1) -> bytes:
        chunks = bytearray()
        while size < 0 or len(chunks) < size:
            chunk = self._read1(1)
            if not chunk:
                break
            chunks.extend(chunk)
            if chunk == b"\n":
                break
        return bytes(chunks)

    def readlines(self, hint: int = -1) -> list[bytes]:
        lines = []
        total = 0
        while hint < 0 or total < hint:
            line = self.readline()
            if not line:
                break
            lines.append(line)
            total += len(line)
        return lines

    def close(self) -> None:
        # socketserver.StreamRequestHandler.finish() closes rfile once the request is handled; without
        # this the wrapper raised AttributeError on every request's teardown.
        self._stream.close()


class _QuietHandler(WSGIRequestHandler):
    """Requests are logged by the application, in the line every task service writes; the server
    reports only its own trouble."""

    headers_timeout: ClassVar[float] = 5
    request_timeout: ClassVar[float] = 15
    # Retain an inactivity bound in addition to the absolute per-phase deadlines.
    timeout: ClassVar[float] = 15

    def setup(self) -> None:
        super().setup()
        self._receive_started = time.monotonic()
        self._headers_complete = False
        self.rfile = cast(
            Any,
            _DeadlineInput(
                self.rfile,
                self.connection,
                lambda: (
                    self._receive_started + (self.request_timeout if self._headers_complete else self.headers_timeout)
                ),
                self.timeout,
            ),
        )

    def handle(self) -> None:
        with suppress(TimeoutError):
            super().handle()

    def parse_request(self) -> bool:
        try:
            return super().parse_request()
        finally:
            self._headers_complete = True

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        pass

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class names it
        log({"level": "warn", "msg": "server", "detail": format % args})


def build_app(service: TaskService | None = None) -> Any:
    """The wiring, without the server, so a production WSGI server can import it."""
    resolved = service or TaskService(repository=MemoryTaskRepository(), clock=SystemClock(), ids=RandomIds())
    return with_request_log(create_app(resolved, log), log, time.monotonic, RandomIds().next)


app = build_app()


def join_seconds(timeout_ms: float) -> float:
    """SHUTDOWN_TIMEOUT as a thread join takes it: in seconds, and no longer than threads can wait."""
    return min(timeout_ms / 1000, threading.TIMEOUT_MAX)


def serve(config: Config) -> int:
    """Serves until SIGTERM or SIGINT; 0 once every request finished, 1 if the timeout passed first."""
    server = make_server("", config.port, app, server_class=ThreadingWSGIServer, handler_class=_QuietHandler)
    stopping = threading.Event()

    def stop(_signum: int, _frame: FrameType | None) -> None:
        if stopping.is_set():
            return
        stopping.set()
        log({"level": "info", "msg": "shutting down"})
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    log({"level": "info", "msg": "listening", "port": config.port, "shutdownTimeoutMs": config.shutdown_timeout_ms})
    server.serve_forever()

    server.server_close()
    # Requests in flight may finish within the timeout, as in every task service; then they are abandoned.
    if not server.finish_requests(join_seconds(config.shutdown_timeout_ms)):
        log({"level": "warn", "msg": "shutdown timed out with requests still in flight"})
        return 1
    return 0


def run() -> int:
    try:
        config = load_config(os.environ)
    except ConfigError as err:
        log({"level": "error", "msg": "invalid configuration", "error": str(err)})
        return 2
    return serve(config)


if __name__ == "__main__":
    raise SystemExit(run())
