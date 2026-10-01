"""A corrupt or misidentified vendor payload must never reach dpkg installation."""

import hashlib
import json
from pathlib import Path

import pytest
from pytest import MonkeyPatch

import install_security_packages as patch


def _package(name: str, payload: bytes) -> patch.Package:
    return patch.Package(
        name,
        "1",
        "amd64",
        f"{patch.REPOSITORY}/pool/updates/main/p/probe/{name}_1_amd64.deb",
        hashlib.sha256(payload).hexdigest(),
    )


def test_corrupt_later_payload_never_installs_an_earlier_verified_one(monkeypatch: MonkeyPatch) -> None:
    packages = [_package("first", b"first"), _package("second", b"second")]
    calls: list[list[str]] = []

    def run(command: list[str]) -> str:
        calls.append(command)
        return "first\t1\tamd64" if command[0].endswith("dpkg-deb") else "0"

    def fetch(url: str) -> bytes:
        return b"first" if "first_" in url else b"tampered"

    monkeypatch.setattr(patch, "_run", run)
    monkeypatch.setattr(patch, "_is_newer", lambda _installed, _locked: False)
    with pytest.raises(patch.PatchError, match="SHA-256 mismatch"):
        patch.install(packages, fetch)
    assert not any("--install" in command for command in calls)


def test_wrong_package_architecture_is_refused_before_install(monkeypatch: MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def run(command: list[str]) -> str:
        calls.append(command)
        return "first\t1\tarm64" if command[0].endswith("dpkg-deb") else "0"

    monkeypatch.setattr(patch, "_run", run)
    monkeypatch.setattr(patch, "_is_newer", lambda _installed, _locked: False)
    with pytest.raises(patch.PatchError, match="metadata mismatch"):
        patch.install([_package("first", b"first")], lambda _url: b"first")
    assert not any("--install" in command for command in calls)


def test_a_newer_pinned_base_is_never_downgraded(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(patch, "_run", lambda _command: "2")
    monkeypatch.setattr(patch, "_is_newer", lambda _installed, _locked: True)
    with pytest.raises(patch.PatchError, match="instead of downgrading"):
        patch.install([_package("first", b"first")], lambda _url: pytest.fail("must not download"))


def test_all_base_architectures_have_four_complete_locks_and_unknown_architectures_fail() -> None:
    lock = Path(__file__).parent.parent / "security-packages.json"
    for architecture in ["amd64", "arm64", "armel", "armhf", "i386", "ppc64el", "riscv64", "s390x"]:
        packages = patch.load_packages(lock, architecture)
        assert len(packages) == 4
        assert all(package.architecture == architecture for package in packages)
    with pytest.raises(patch.PatchError, match="No reviewed payload"):
        patch.load_packages(lock, "unknown")


def test_lock_cannot_redirect_to_an_unreviewed_repository_or_escape_the_security_pool(tmp_path: Path) -> None:
    data = json.loads((Path(__file__).parent.parent / "security-packages.json").read_text())
    lock = tmp_path / "lock.json"
    data["repository"] = "http://example.com"
    lock.write_text(json.dumps(data))
    with pytest.raises(patch.PatchError, match="repository"):
        patch.load_packages(lock, "amd64")
    data["repository"] = patch.REPOSITORY
    data["packages"]["openssl"]["files"]["amd64"]["path"] = "pool/updates/main/../../other.deb"
    lock.write_text(json.dumps(data))
    with pytest.raises(patch.PatchError, match="security pool"):
        patch.load_packages(lock, "amd64")
