import json
import re
import threading
from wsgiref.simple_server import WSGIRequestHandler

import pytest

from api_py.main import SystemClock, ThreadingWSGIServer, join_seconds, run


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
