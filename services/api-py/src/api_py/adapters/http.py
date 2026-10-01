"""The HTTP transport: decode the request, call a use case, map the outcome to a response.

It holds no business rules, and the API it serves matches api-go and api-ts route for route. It is a
plain WSGI application, so the same object runs under the development server in main.py and under a
production server such as gunicorn or waitress with no code change.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from typing import Any, Final, NoReturn
from urllib.parse import unquote

from api_py.application.task_service import TaskService
from api_py.domain.task import DomainError, DomainErrorCode, Task, parse_status

# A request body larger than this is refused before it is parsed.
MAX_BODY_BYTES: Final = 1024 * 1024
# How much of a refused body is still read, so the client can receive the 400 instead of a reset
# connection.
MAX_DRAIN_BYTES: Final = 8 * MAX_BODY_BYTES

STATUS_BY_CODE: Final[dict[DomainErrorCode, int]] = {
    "EMPTY_TITLE": 422,
    "TITLE_TOO_LONG": 422,
    "UNKNOWN_STATUS": 422,
    "INVALID_TRANSITION": 409,
    "NOT_FOUND": 404,
}

REASON: Final[dict[int, str]] = {
    200: "OK",
    201: "Created",
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict",
    422: "Unprocessable Content",
    500: "Internal Server Error",
}

_TASK_PATH = re.compile(r"^/api/tasks/([^/]+)(/status)?$")
_MALFORMED_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")

StartResponse = Callable[[str, list[tuple[str, str]]], Any]
WSGIApplication = Callable[[dict[str, Any], StartResponse], Iterable[bytes]]
Log = Callable[[dict[str, object]], None]


class BadRequestError(Exception):
    """A request the transport cannot read. The message is written for the client."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message: Final = message


class RequestTimeoutError(Exception):
    """The client stopped sending the body before it was complete."""


class MethodNotAllowedError(Exception):
    """A method the path does not take; `allow` names the ones it does, as a 405 must."""

    def __init__(self, allow: str) -> None:
        super().__init__(allow)
        self.allow: Final = allow


def as_json(task: Task) -> dict[str, str]:
    """The wire shape, which is camelCase in every one of the three services."""
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "createdAt": task.created_at,
        "updatedAt": task.updated_at,
    }


def create_app(service: TaskService, log: Log) -> WSGIApplication:
    def app(environ: dict[str, Any], start_response: StartResponse) -> Iterable[bytes]:
        headers: list[tuple[str, str]] = []
        try:
            status, body = _route(service, environ)
        except RequestTimeoutError:
            status, body = 408, {"error": "request body not received in time"}
        except MethodNotAllowedError as err:
            status, body = 405, {"error": "method not allowed"}
            headers.append(("allow", err.allow))
        except DomainError as err:
            status, body = STATUS_BY_CODE[err.code], {"error": err.message}
        except BadRequestError as err:
            status, body = 400, {"error": err.message}
        except Exception as err:  # noqa: BLE001 - the boundary: nothing escapes as a stack trace
            # The detail is logged and never returned to the client.
            log(
                {
                    "level": "error",
                    "msg": "request failed",
                    "method": environ.get("REQUEST_METHOD"),
                    "path": environ.get("PATH_INFO"),
                    "error": str(err),
                }
            )
            status, body = 500, {"error": "internal error"}

        payload = json.dumps(body).encode()
        start_response(
            f"{status} {REASON[status]}",
            [("content-type", "application/json"), ("content-length", str(len(payload))), *headers],
        )
        # A HEAD response describes the GET response and carries no body; WSGI servers send whatever
        # the application returns, so leaving it out is this code's job.
        return [b""] if environ.get("REQUEST_METHOD") == "HEAD" else [payload]

    return app


def _route(service: TaskService, environ: dict[str, Any]) -> tuple[int, object]:
    # HEAD is answered wherever GET is, as HTTP requires.
    method = environ.get("REQUEST_METHOD", "GET")
    method = "GET" if method == "HEAD" else method
    path = _path(environ)

    if path == "/healthz":
        return (200, {"status": "ok"}) if method == "GET" else _not_allowed("GET, HEAD")

    if path == "/api/tasks":
        if method == "GET":
            return 200, [as_json(task) for task in service.list()]
        if method == "POST":
            body = _read_object(environ, ["title"])
            return 201, as_json(service.create(_optional_string(body, "title")))
        return _not_allowed("GET, HEAD, POST")

    match = _TASK_PATH.match(path)
    if match is None:
        return 404, {"error": "not found"}

    if _MALFORMED_ESCAPE.search(match.group(1)):
        raise BadRequestError("malformed path")
    task_id = unquote(match.group(1))
    if match.group(2) is None:
        return (200, as_json(service.get(task_id))) if method == "GET" else _not_allowed("GET, HEAD")

    if method != "PATCH":
        return _not_allowed("PATCH")
    body = _read_object(environ, ["status"])
    return 200, as_json(service.transition(task_id, parse_status(_optional_string(body, "status"))))


def _path(environ: dict[str, Any]) -> str:
    """The request path, still percent-encoded where the server exposes it.

    WSGI decodes PATH_INFO before routing, which would turn an encoded slash inside an id into a path
    separator. Servers that keep the raw target (gunicorn's RAW_URI, some others' REQUEST_URI) let the
    route match first and the segment be decoded after, as api-go and api-ts do.
    """
    raw = environ.get("RAW_URI") or environ.get("REQUEST_URI")
    if isinstance(raw, str) and raw != "":
        return raw.split("?", 1)[0]
    path = environ.get("PATH_INFO", "/")
    return path if isinstance(path, str) and path != "" else "/"


def _not_allowed(allow: str) -> NoReturn:
    raise MethodNotAllowedError(allow)


def _read_object(environ: dict[str, Any], allowed: list[str]) -> dict[str, object]:
    """Reads a size-bounded JSON object and refuses fields the endpoint does not document."""
    invalid = BadRequestError("request body must be a JSON object with only the documented fields")
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        raise invalid from None
    stream = environ.get("wsgi.input")
    if length > MAX_BODY_BYTES:
        _drain(stream, min(length, MAX_DRAIN_BYTES))
        raise invalid
    try:
        raw = stream.read(length) if stream is not None and length > 0 else b""
    except TimeoutError:
        raise RequestTimeoutError from None
    if len(raw) < length:
        raise RequestTimeoutError
    # An empty body is not an empty object: api-go and api-ts refuse it as malformed, and so does this.
    if raw.strip() == b"":
        raise invalid
    try:
        # JSON on the wire is UTF-8 (RFC 8259, section 8.1). json.loads(bytes) would also take UTF-16
        # and a byte-order mark, and it takes NaN and Infinity, which are not JSON.
        body = json.loads(raw.decode("utf-8"), parse_constant=_not_json)
    except ValueError:
        raise invalid from None
    if not isinstance(body, dict):
        raise invalid
    if any(key not in allowed for key in body):
        raise invalid
    return body


def _not_json(name: str) -> NoReturn:
    raise ValueError(f"{name} is not JSON")


def _drain(stream: Any, remaining: int) -> None:
    """Reads and discards what the client is still sending, in bounded chunks."""
    while stream is not None and remaining > 0:
        chunk = stream.read(min(remaining, 64 * 1024))
        if not chunk:
            return
        remaining -= len(chunk)


def _optional_string(body: dict[str, object], key: str) -> str:
    """A missing field reads as empty, which the domain rejects; a wrong type is malformed."""
    value = body.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise BadRequestError(f"{key} must be a string")
    return value
