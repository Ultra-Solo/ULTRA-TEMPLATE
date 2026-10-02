import json
import os
import re
import select
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from wsgiref.simple_server import WSGIRequestHandler, make_server

import pytest

from api_py.main import (
    SystemClock,
    ThreadingWSGIServer,
    _QuietHandler,
    build_app,
    join_seconds,
    run,
)


def test_a_refused_configuration_is_one_json_line_naming_the_variable(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("PORT", "eighty")
    assert run() == 2
    line = json.loads(capsys.readouterr().out)
    assert (line["level"], line["msg"]) == ("error", "invalid configuration")
    assert "PORT" in line["error"]


def test_the_clock_writes_utc_to_the_millisecond_as_every_task_service_does() -> None:
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", SystemClock().now())


def test_a_shutdown_timeout_longer_than_threads_can_wait_is_waited_as_long_as_they_can() -> None:
    assert join_seconds(1500) == 1.5
    assert join_seconds(9_223_369_200_000) == min(9_223_369_200, threading.TIMEOUT_MAX)


def test_shutdown_waits_for_requests_in_flight_until_the_timeout_and_no_longer() -> None:
    server = ThreadingWSGIServer(("127.0.0.1", 0), WSGIRequestHandler)
    release = threading.Event()
    try:
        server.track(threading.Thread(target=release.wait, daemon=True))
        # A request still running when the timeout passes is abandoned, and says so.
        assert server.finish_requests(0.05) is False
        release.set()
        assert server.finish_requests(1) is True
    finally:
        release.set()
        server.server_close()
    # Daemon threads: one still blocked on a body that never arrives does not keep the process alive.
    assert ThreadingWSGIServer.daemon_threads is True


def test_log_lines_from_threads_at_once_are_whole_lines() -> None:
    # Through a real pipe, as the service's stdout is: pytest's captured stdout hides the interleaving.
    script = """
import threading
from api_py.main import log

def write():
    for n in range(200):
        log({"level": "info", "msg": "request", "n": n, "pad": "x" * 64})

threads = [threading.Thread(target=write) for _ in range(16)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
"""
    src = str(Path(__file__).resolve().parents[1] / "src")
    env = {**os.environ, "PYTHONPATH": src}
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=True, env=env).stdout  # noqa: S603 - this test's own script
    lines = out.splitlines()
    assert len(lines) == 16 * 200
    for line in lines:
        json.loads(line)


@contextmanager
def _slow_server(headers_timeout: float, request_timeout: float) -> Iterator[int]:
    """A real server on a loopback port, its deadlines shortened so a slow-trickle test runs quickly.

    `_QuietHandler`'s deadlines are class attributes read fresh per connection (`setup`), so changing
    them here affects every connection this server accepts, and nothing else: restored before this
    context manager returns.
    """
    saved = (_QuietHandler.headers_timeout, _QuietHandler.request_timeout, _QuietHandler.timeout)
    _QuietHandler.headers_timeout = headers_timeout
    _QuietHandler.request_timeout = request_timeout
    _QuietHandler.timeout = request_timeout
    server = make_server("127.0.0.1", 0, build_app(), server_class=ThreadingWSGIServer, handler_class=_QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)
        _QuietHandler.headers_timeout, _QuietHandler.request_timeout, _QuietHandler.timeout = saved


def _trickle(port: int, parts: list[bytes], interval_s: float) -> bytes:
    """Sends `parts` one at a time, `interval_s` apart, and returns whatever the server answered."""
    with closing(socket.create_connection(("127.0.0.1", port), timeout=5)) as sock:
        sock.settimeout(5)
        response = bytearray()
        try:
            for index, part in enumerate(parts):
                if index > 0:
                    time.sleep(interval_s)
                sock.sendall(part)
                # Continuously try to read any response the server may have sent (e.g., 408 on timeout)
                # while sending parts. This works around Windows' ConnectionAbortedError when the
                # server closes after sending a response but before the client finishes sending.
                deadline = time.monotonic() + 0.5  # Allow up to 0.5s for server to respond
                while time.monotonic() < deadline:
                    ready = select.select([sock], [], [], 0.01)
                    if not ready[0]:
                        continue
                    chunk = sock.recv(4096)
                    if not chunk:
                        return bytes(response)
                    response.extend(chunk)
                    # If we got a response, the server likely closed; stop sending more parts
                    if response:
                        return bytes(response)
            # Final read attempt after all parts sent
            deadline = time.monotonic() + 0.5
            while time.monotonic() < deadline:
                ready = select.select([sock], [], [], 0.01)
                if not ready[0]:
                    continue
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response.extend(chunk)
        except (TimeoutError, BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # The server closed the connection once the deadline passed, mid-send or mid-receive.
            pass
        return bytes(response)


def test_a_request_that_arrives_before_either_deadline_is_answered_normally() -> None:
    # Control: the same server and the same request, sent at once, is unaffected by the short deadlines.
    header = b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    with _slow_server(headers_timeout=0.3, request_timeout=0.6) as port:
        response = _trickle(port, [header], interval_s=0)
    assert response.startswith(b"HTTP/1.0 200")


def test_headers_slower_than_the_headers_deadline_close_the_connection_without_a_response() -> None:
    # ADR-0021: a client that trickles bytes must not hold the connection open past the deadline by
    # periodically sending data, which a bare inactivity timeout (reset on every byte) would allow.
    header_parts = [b"GET /healthz HTTP/1.1\r\n", b"Host: localhost\r\nConnection: close\r\n", b"\r\n"]
    with _slow_server(headers_timeout=0.2, request_timeout=5) as port:
        started = time.monotonic()
        response = _trickle(port, header_parts, interval_s=0.3)
        elapsed = time.monotonic() - started
    # Closed close to the header deadline, not held open for the whole slow trickle (2 * 0.3s).
    assert elapsed < 1.0
    assert response == b""


def test_a_body_slower_than_the_request_deadline_is_answered_408_not_left_open() -> None:
    body = b'{"title":"slow"}'
    head = (
        b"POST /api/tasks HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
        b"Content-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n"
    )
    parts = [head + body[:1], body[1:2], body[2:]]
    with _slow_server(headers_timeout=5, request_timeout=0.3) as port:
        started = time.monotonic()
        response = _trickle(port, parts, interval_s=0.2)
        elapsed = time.monotonic() - started
    # Closed close to the request deadline, not held open for the whole slow trickle (2 * 0.2s).
    assert elapsed < 1.0
    assert response.startswith(b"HTTP/1.0 408")
