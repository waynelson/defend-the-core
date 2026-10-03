"""Zip packs/BP and packs/RP into an .mcaddon in dist/.

    python tools/build.py             # dev build: dist/defend_the_core.mcaddon
    python tools/build.py --release   # release: dist/defend_the_core-<version>.mcaddon

Dev builds stamp patch 1000 + an increasing counter into both manifests (and
the BP's dependency on the RP) inside the zip only, so clients that cached an
earlier resource pack download the new one. Release builds use the manifest
version as written; keep its patch below 1000 so a release and a dev build
never share a version.
"""

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS = {"BP": "defend_the_core_BP", "RP": "defend_the_core_RP"}
DIST = ROOT / "dist"
COUNTER = DIST / ".build"
DEV_PATCH_BASE = 1000


def manifest_version() -> list:
    return json.loads((ROOT / "packs/BP/manifest.json").read_text())["header"]["version"]


def next_build() -> int:
    build = int(COUNTER.read_text()) + 1 if COUNTER.exists() else 1
    COUNTER.write_text(str(build))
    return build


def stamp(manifest: dict, version: list, rp_uuid: str) -> dict:
    manifest = json.loads(json.dumps(manifest))
    manifest["header"]["version"] = version
    for module in manifest["modules"]:
        module["version"] = version
    for dep in manifest.get("dependencies", []):
        if dep.get("uuid") == rp_uuid:
            dep["version"] = version
    return manifest


def main(release: bool = False) -> Path:
    DIST.mkdir(exist_ok=True)
    major, minor, patch = manifest_version()
    if release:
        if patch >= DEV_PATCH_BASE:
            sys.exit(f"release patch must be below {DEV_PATCH_BASE}")
        version = [major, minor, patch]
        out = DIST / f"defend_the_core-{major}.{minor}.{patch}.mcaddon"
    else:
        version = [major, minor, DEV_PATCH_BASE + next_build()]
        out = DIST / "defend_the_core.mcaddon"
    rp_uuid = json.loads((ROOT / "packs/RP/manifest.json").read_text())["header"]["uuid"]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for src, folder in PACKS.items():
            base = ROOT / "packs" / src
            for path in sorted(base.rglob("*")):
                if not path.is_file():
                    continue
                arc = f"{folder}/{path.relative_to(base).as_posix()}"
                if path.name == "manifest.json" and path.parent == base:
                    manifest = stamp(json.loads(path.read_text()), version, rp_uuid)
                    zf.writestr(arc, json.dumps(manifest, indent=2))
                else:
                    zf.write(path, arc)
    print(f"built {out.relative_to(ROOT)} (version {'.'.join(map(str, version))})")
    return out


if __name__ == "__main__":
    main(release="--release" in sys.argv)
