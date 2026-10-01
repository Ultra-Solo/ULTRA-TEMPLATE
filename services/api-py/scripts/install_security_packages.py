"""Install vendor security payloads from exact, reviewed checksums, without mutable apt indexes."""

import hashlib
import json
import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from urllib.request import urlopen

REPOSITORY = "https://deb.debian.org/debian-security"
MAX_PAYLOAD = 16 * 1024 * 1024


class PatchError(Exception):
    """Invalid or unavailable pinned input; no unverified payload may be installed."""


@dataclass(frozen=True)
class Package:
    name: str
    version: str
    architecture: str
    url: str
    sha256: str


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise PatchError("Expected a JSON object in the package lock")
    return cast("dict[str, object]", value)


def _text(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise PatchError("Expected a non-empty string in the package lock")
    return value


def load_packages(lock: Path, architecture: str) -> list[Package]:
    document = _object(json.loads(lock.read_text()))
    if document.get("schemaVersion") != 1 or document.get("repository") != REPOSITORY:
        raise PatchError("Unsupported package-lock schema or repository")
    packages = []
    for name, value in _object(document.get("packages")).items():
        item = _object(value)
        version = _text(item.get("version"))
        if re.fullmatch(r"[a-z0-9][a-z0-9+.-]+", name) is None or re.fullmatch(r"[A-Za-z0-9.+:~_-]+", version) is None:
            raise PatchError("Invalid package name or version")
        files = _object(item.get("files"))
        if architecture not in files:
            raise PatchError(f"No reviewed payload for architecture {architecture}; update the lock")
        asset = _object(files[architecture])
        path, sha256 = _text(asset.get("path")), _text(asset.get("sha256"))
        if re.fullmatch(r"pool/updates/main/[a-z0-9/]+/[A-Za-z0-9.+~_-]+\.deb", path) is None:
            raise PatchError("Payload must be a Debian security pool file")
        if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
            raise PatchError("Payload needs a full SHA-256 checksum")
        packages.append(Package(name, version, architecture, f"{REPOSITORY}/{path}", sha256))
    if not packages:
        raise PatchError("Package lock is empty")
    return packages


def _run(command: list[str]) -> str:
    # Absolute Debian program paths and validated arguments; no shell is involved.
    return subprocess.check_output(command, text=True).strip()  # noqa: S603


def _is_newer(installed: str, locked: str) -> bool:
    # Both versions are data arguments to an absolute Debian program, never shell source.
    result = subprocess.run(["/usr/bin/dpkg", "--compare-versions", installed, "gt", locked], check=False)  # noqa: S603
    if result.returncode not in (0, 1):
        raise PatchError("Cannot compare the base-image package version")
    return result.returncode == 0


def fetch_payload(url: str) -> bytes:
    if not url.startswith(f"{REPOSITORY}/pool/updates/main/"):
        raise PatchError("Payload URL is outside the reviewed HTTPS repository")
    # The URL is restricted to the official HTTPS repository above; TLS verification stays enabled.
    with urlopen(url, timeout=30) as response:  # noqa: S310
        payload = bytes(response.read(MAX_PAYLOAD + 1))
    if len(payload) > MAX_PAYLOAD:
        raise PatchError("Vendor payload exceeds the download bound")
    return payload


def install(packages: list[Package], fetcher: Callable[[str], bytes] = fetch_payload) -> None:
    for package in packages:
        installed = _run(["/usr/bin/dpkg-query", "--show", "--showformat=${Version}", package.name])
        if _is_newer(installed, package.version):
            raise PatchError(
                f"Base already has newer {package.name}; refresh or remove the patch instead of downgrading"
            )
    with TemporaryDirectory(prefix="security-payloads-") as temporary:
        paths = []
        for index, package in enumerate(packages):
            payload = fetcher(package.url)
            if hashlib.sha256(payload).hexdigest() != package.sha256:
                raise PatchError(f"SHA-256 mismatch for {package.name}; nothing installed")
            path = Path(temporary) / f"{index}.deb"
            path.write_bytes(payload)
            fields = _run(
                ["/usr/bin/dpkg-deb", "--show", "--showformat=${Package}\t${Version}\t${Architecture}", str(path)]
            )
            if fields.split("\t") != [package.name, package.version, package.architecture]:
                raise PatchError(f"Package metadata mismatch for {package.name}; nothing installed")
            paths.append(str(path))
        # Every payload passed integrity and identity checks before the first installation.
        _run(["/usr/bin/dpkg", "--install", *paths])
    for package in packages:
        if _run(["/usr/bin/dpkg-query", "--show", "--showformat=${Version}", package.name]) != package.version:
            raise PatchError(f"Installed version differs from the lock for {package.name}")


def main() -> None:
    architecture = _run(["/usr/bin/dpkg", "--print-architecture"])
    install(load_packages(Path(sys.argv[1]), architecture))
    print(f"Installed checksum-verified security packages for {architecture}")


if __name__ == "__main__":
    main()
