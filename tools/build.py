"""Zip packs/BP and packs/RP into dist/defend_the_core.mcaddon.

Each build stamps an increasing patch number into both manifests (and the
BP's dependency on the RP) inside the zip only, so clients that cached an
earlier resource pack download the new one.
"""

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS = {"BP": "defend_the_core_BP", "RP": "defend_the_core_RP"}
DIST = ROOT / "dist"
COUNTER = DIST / ".build"
OUT = DIST / "defend_the_core.mcaddon"


def next_build() -> int:
    build = int(COUNTER.read_text()) + 1 if COUNTER.exists() else 1
    COUNTER.write_text(str(build))
    return build


def stamp(manifest: dict, build: int, rp_uuid: str) -> dict:
    manifest = json.loads(json.dumps(manifest))
    major, minor, _ = manifest["header"]["version"]
    version = [major, minor, build]
    manifest["header"]["version"] = version
    for module in manifest["modules"]:
        module["version"] = version
    for dep in manifest.get("dependencies", []):
        if dep.get("uuid") == rp_uuid:
            dep["version"] = version
    return manifest


def main() -> Path:
    DIST.mkdir(exist_ok=True)
    build = next_build()
    rp_uuid = json.loads((ROOT / "packs/RP/manifest.json").read_text())["header"]["uuid"]
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for src, folder in PACKS.items():
            base = ROOT / "packs" / src
            for path in sorted(base.rglob("*")):
                if not path.is_file():
                    continue
                arc = f"{folder}/{path.relative_to(base).as_posix()}"
                if path.name == "manifest.json" and path.parent == base:
                    manifest = stamp(json.loads(path.read_text()), build, rp_uuid)
                    zf.writestr(arc, json.dumps(manifest, indent=2))
                else:
                    zf.write(path, arc)
    print(f"built {OUT.relative_to(ROOT)} (version 0.1.{build})")
    return OUT


if __name__ == "__main__":
    main()
