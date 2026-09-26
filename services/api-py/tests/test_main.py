import json
import re

import pytest

from api_py.main import SystemClock, run


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
