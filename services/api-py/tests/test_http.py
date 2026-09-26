"""The transport, called as a WSGI server calls it: no socket, no port, no process."""

from __future__ import annotations

import io
import json
from typing import Any, get_args

import pytest

from api_py.adapters.http import MAX_BODY_BYTES, STATUS_BY_CODE, create_app
from api_py.adapters.memory_task_repository import MemoryTaskRepository
from api_py.application.task_service import TaskService
from api_py.domain.task import DomainErrorCode

NOW = "2026-01-02T03:04:05Z"


class FixedClock:
    def now(self) -> str:
        return NOW


class CountingIds:
    def __init__(self) -> None:
        self.issued = 0

    def next(self) -> str:
        self.issued += 1
        return f"t{self.issued}"


class Client:
    def __init__(self) -> None:
        self.logged: list[dict[str, object]] = []
        self.service = TaskService(repository=MemoryTaskRepository(), clock=FixedClock(), ids=CountingIds())
        self.app = create_app(self.service, self.logged.append)

    def request(self, method: str, path: str, body: object | None = None, raw: bytes | None = None) -> tuple[int, Any]:
        payload = raw if raw is not None else (b"" if body is None else json.dumps(body).encode())
        environ: dict[str, Any] = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "RAW_URI": path,
            "CONTENT_LENGTH": str(len(payload)),
            "wsgi.input": io.BytesIO(payload),
        }
        captured: dict[str, Any] = {}

        def start_response(status: str, headers: list[tuple[str, str]]) -> None:
            captured["status"] = int(status.split(" ", 1)[0])
            captured["headers"] = dict(headers)

        chunks = b"".join(self.app(environ, start_response))
        assert captured["headers"]["content-type"] == "application/json"
        self.headers: dict[str, str] = captured["headers"]
        return captured["status"], json.loads(chunks)


def test_every_domain_error_code_has_a_status() -> None:
    # The build fails when a new code is added without deciding what it means on the wire.
    assert set(STATUS_BY_CODE) == set(get_args(DomainErrorCode))


def test_health_and_the_task_lifecycle() -> None:
    client = Client()
    assert client.request("GET", "/healthz") == (200, {"status": "ok"})
    assert client.request("GET", "/api/tasks") == (200, [])

    status, created = client.request("POST", "/api/tasks", {"title": "Write the README"})
    assert status == 201
    assert created == {"id": "t1", "title": "Write the README", "status": "todo", "createdAt": NOW, "updatedAt": NOW}

    assert client.request("GET", "/api/tasks/t1")[1] == created
    assert client.request("GET", "/api/tasks")[1] == [created]

    status, moved = client.request("PATCH", "/api/tasks/t1/status", {"status": "in_progress"})
    assert (status, moved["status"]) == (200, "in_progress")


@pytest.mark.parametrize(
    ("method", "path", "body", "expected"),
    [
        ("POST", "/api/tasks", {"title": "  "}, 422),
        ("POST", "/api/tasks", {"title": "x" * 201}, 422),
        ("POST", "/api/tasks", {"title": "ok", "extra": 1}, 400),
        ("POST", "/api/tasks", {"title": 7}, 400),
        ("GET", "/api/tasks/missing", None, 404),
        ("GET", "/api/nope", None, 404),
        ("DELETE", "/api/tasks", None, 405),
        ("DELETE", "/healthz", None, 405),
        ("POST", "/api/tasks/t1/status", {"status": "done"}, 405),
    ],
)
def test_refusals_carry_the_status_the_other_services_use(
    method: str, path: str, body: object | None, expected: int
) -> None:
    client = Client()
    status, payload = client.request(method, path, body)
    assert status == expected
    assert isinstance(payload["error"], str) and payload["error"] != ""


def test_transition_refusals() -> None:
    client = Client()
    client.request("POST", "/api/tasks", {"title": "Write the README"})
    assert client.request("PATCH", "/api/tasks/t1/status", {"status": "done"})[0] == 409
    assert client.request("PATCH", "/api/tasks/t1/status", {"status": "archived"})[0] == 422
    assert client.request("PATCH", "/api/tasks/nope/status", {"status": "in_progress"})[0] == 404


def test_a_malformed_or_oversized_body_is_refused_before_it_is_parsed() -> None:
    client = Client()
    assert client.request("POST", "/api/tasks", raw=b"not json")[0] == 400
    assert client.request("POST", "/api/tasks", raw=b"[1,2,3]")[0] == 400

    oversized: dict[str, Any] = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/api/tasks",
        "CONTENT_LENGTH": str(MAX_BODY_BYTES + 1),
        "wsgi.input": io.BytesIO(b"{}"),
    }
    captured: dict[str, Any] = {}
    body = b"".join(client.app(oversized, lambda status, _headers: captured.__setitem__("status", status)))
    assert captured["status"].startswith("400")
    assert "documented fields" in json.loads(body)["error"]


def test_head_is_answered_like_get_and_carries_no_body() -> None:
    client = Client()
    environ: dict[str, Any] = {"REQUEST_METHOD": "HEAD", "PATH_INFO": "/healthz", "wsgi.input": io.BytesIO(b"")}
    captured: dict[str, Any] = {}
    body = b"".join(client.app(environ, lambda status, _headers: captured.__setitem__("status", status)))
    assert captured["status"].startswith("200")
    assert body == b""


def test_an_empty_body_is_malformed_not_an_empty_object() -> None:
    # api-go and api-ts answer 400; reading it as {} would answer 422 about a missing title.
    client = Client()
    assert client.request("POST", "/api/tasks", raw=b"")[0] == 400
    client.request("POST", "/api/tasks", {"title": "Write the README"})
    assert client.request("PATCH", "/api/tasks/t1/status", raw=b"")[0] == 400


def test_a_malformed_escape_in_an_id_is_refused() -> None:
    assert Client().request("GET", "/api/tasks/%zz")[0] == 400


def test_an_oversized_body_is_drained_before_the_refusal() -> None:
    # Refusing without reading leaves the client mid-upload, and it sees a reset connection
    # instead of the 400. The body is read up to a bound, then the answer goes out.
    client = Client()
    stream = io.BytesIO(b"x" * (MAX_BODY_BYTES + 10))
    environ: dict[str, Any] = {
        "REQUEST_METHOD": "POST",
        "PATH_INFO": "/api/tasks",
        "CONTENT_LENGTH": str(MAX_BODY_BYTES + 10),
        "wsgi.input": stream,
    }
    captured: dict[str, Any] = {}
    b"".join(client.app(environ, lambda status, _headers: captured.__setitem__("status", status)))
    assert captured["status"].startswith("400")
    assert stream.tell() == MAX_BODY_BYTES + 10


def test_an_id_keeps_its_percent_encoding_while_routing() -> None:
    client = Client()
    client.service.repository.save(client.service.create("Write the README"))
    # RAW_URI carries the encoded slash; the route matches, then the segment is decoded.
    assert client.request("GET", "/api/tasks/t%201%2F2")[0] == 404
    assert client.request("GET", "/api/tasks/t1")[0] == 200


def test_an_unexpected_failure_is_logged_and_never_returned() -> None:
    client = Client()

    def explode() -> tuple:  # type: ignore[type-arg]
        raise RuntimeError("secret detail")

    client.service.repository.list = explode  # type: ignore[method-assign]
    status, payload = client.request("GET", "/api/tasks")
    assert (status, payload) == (500, {"error": "internal error"})
    assert "secret detail" not in json.dumps(payload)
    assert any("secret detail" in str(entry.get("error", "")) for entry in client.logged)


@pytest.mark.parametrize(
    ("method", "path", "allow"),
    [
        ("POST", "/healthz", "GET, HEAD"),
        ("DELETE", "/api/tasks", "GET, HEAD, POST"),
        ("PUT", "/api/tasks/t1", "GET, HEAD"),
        ("GET", "/api/tasks/t1/status", "PATCH"),
    ],
)
def test_a_wrong_method_names_the_methods_the_path_allows(method: str, path: str, allow: str) -> None:
    client = Client()
    status, _ = client.request(method, path)
    assert (status, client.headers.get("allow")) == (405, allow)
