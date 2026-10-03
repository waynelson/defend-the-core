"""Turn on a world experiment (default: Beta APIs, needed by the chat bridge)
in a Crafty-managed BDS world's level.dat.

    python tools/experiments.py                  # dev: show the world's experiments
    python tools/experiments.py --enable         # dev: enable Beta APIs (stops and starts the server)
    DTC_TARGET=beta python tools/experiments.py --enable --yes-beta

BDS has no command for experiments, so this stops the server, downloads
level.dat (a backup goes to dist/ and to level.dat.bak-<time> next to it),
sets the flags, uploads it and starts the server again.
"""

import io
import struct
import sys
import time
import urllib.parse
from pathlib import Path

import node

ROOT = Path(__file__).resolve().parent.parent
EXPERIMENT = "gametest"  # the "Beta APIs" toggle

# ---------------------------------------------------------------- NBT (little-endian)

END, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, BYTE_ARRAY, STRING, LIST, COMPOUND, INT_ARRAY, LONG_ARRAY = range(13)
_FIXED = {BYTE: "<b", SHORT: "<h", INT: "<i", LONG: "<q", FLOAT: "<f", DOUBLE: "<d"}


def _read(f, fmt):
    size = struct.calcsize(fmt)
    return struct.unpack(fmt, f.read(size))[0]


def _read_string(f):
    return f.read(_read(f, "<H")).decode("utf-8")


def _read_payload(f, tag):
    if tag in _FIXED:
        return _read(f, _FIXED[tag])
    if tag == BYTE_ARRAY:
        return f.read(_read(f, "<i"))
    if tag == STRING:
        return _read_string(f)
    if tag == LIST:
        item = _read(f, "<b")
        return (item, [_read_payload(f, item) for _ in range(_read(f, "<i"))])
    if tag == COMPOUND:
        out = {}
        while True:
            child = _read(f, "<b")
            if child == END:
                return out
            name = _read_string(f)
            out[name] = (child, _read_payload(f, child))
    if tag in (INT_ARRAY, LONG_ARRAY):
        fmt = "<i" if tag == INT_ARRAY else "<q"
        return [_read(f, fmt) for _ in range(_read(f, "<i"))]
    raise ValueError(f"unknown NBT tag {tag}")


def _write_string(out, text):
    raw = text.encode("utf-8")
    out.write(struct.pack("<H", len(raw)) + raw)


def _write_payload(out, tag, value):
    if tag in _FIXED:
        out.write(struct.pack(_FIXED[tag], value))
    elif tag == BYTE_ARRAY:
        out.write(struct.pack("<i", len(value)) + value)
    elif tag == STRING:
        _write_string(out, value)
    elif tag == LIST:
        item, values = value
        out.write(struct.pack("<bi", item, len(values)))
        for v in values:
            _write_payload(out, item, v)
    elif tag == COMPOUND:
        for name, (child, v) in value.items():
            out.write(struct.pack("<b", child))
            _write_string(out, name)
            _write_payload(out, child, v)
        out.write(struct.pack("<b", END))
    elif tag in (INT_ARRAY, LONG_ARRAY):
        fmt = "<i" if tag == INT_ARRAY else "<q"
        out.write(struct.pack("<i", len(value)))
        for v in value:
            out.write(struct.pack(fmt, v))
    else:
        raise ValueError(f"unknown NBT tag {tag}")


def parse_level_dat(data: bytes):
    """(storage version, root name, root compound)"""
    version, length = struct.unpack("<ii", data[:8])
    f = io.BytesIO(data[8:8 + length])
    if _read(f, "<b") != COMPOUND:
        raise ValueError("level.dat root is not a compound")
    name = _read_string(f)
    return version, name, _read_payload(f, COMPOUND)


def build_level_dat(version: int, name: str, root: dict) -> bytes:
    body = io.BytesIO()
    body.write(struct.pack("<b", COMPOUND))
    _write_string(body, name)
    _write_payload(body, COMPOUND, root)
    payload = body.getvalue()
    return struct.pack("<ii", version, len(payload)) + payload


def enable_experiment(root: dict, key: str = EXPERIMENT) -> bool:
    """Sets experiments.<key> (and the bookkeeping flags); True if anything changed."""
    tag, experiments = root.get("experiments", (COMPOUND, {}))
    if tag != COMPOUND:
        raise ValueError("experiments is not a compound")
    before = dict(experiments)
    for flag in (key, "experiments_ever_used", "saved_with_toggled_experiments"):
        experiments[flag] = (BYTE, 1)
    root["experiments"] = (COMPOUND, experiments)
    return experiments != before


# ---------------------------------------------------------------- node


def stats():
    return node.request("get", "servers/{sid}/stats")["data"]


def wait_running(want: bool, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if bool(stats().get("running")) == want:
            return
        time.sleep(3)
    sys.exit(f"server did not {'start' if want else 'stop'} in {timeout}s")


def action(name):
    result = node.request("post", f"servers/{{sid}}/action/{name}")
    if not isinstance(result, dict) or result.get("status") != "ok":
        sys.exit(f"{name} failed: {result}")


def world_dir() -> str:
    props = node.request("get", "servers/{sid}/properties")["data"]["settings"]
    level = next(s["value"] for s in props if s["key"] == "level-name")
    return f"worlds/{level}"


def download(path: str) -> bytes:
    import ssl  # pylint: disable=import-outside-toplevel
    import urllib.request  # pylint: disable=import-outside-toplevel

    base, token = node.node()
    url = f"{base}/servers/{node.SERVER_ID}/files/{urllib.parse.quote(path)}/download"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, context=ssl._create_unverified_context(), timeout=60) as resp:
        return resp.read()


def upload(folder: str, filename: str, data: bytes):
    result = node.request(
        "post",
        "servers/{sid}/files/upload",
        raw=data,
        content_type="application/octet-stream",
        headers={
            "fileId": f"exp{int(time.time())}{filename.encode().hex()[:8]}",
            "fileName": filename,
            "fileSize": str(len(data)),
            "totalChunks": "0",
            "location": folder,
        },
    )
    if not isinstance(result, dict) or result.get("status") not in ("ok", "completed"):
        sys.exit(f"upload of {filename} failed: {result}")


def main():
    enable = "--enable" in sys.argv
    if node.TARGET == "beta" and enable and "--yes-beta" not in sys.argv:
        sys.exit("changing the beta world needs --yes-beta")
    folder = world_dir()
    print(f"target: {node.TARGET} ({node.NODE_NAME}), world: {folder}")
    if not enable:
        _, _, root = parse_level_dat(download(f"{folder}/level.dat"))
        print("experiments:", {k: v for k, (_, v) in root.get("experiments", (0, {}))[1].items()})
        return

    was_running = bool(stats().get("running"))
    if was_running:
        print("stopping server...")
        action("stop_server")
        wait_running(False)
    data = download(f"{folder}/level.dat")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (ROOT / "dist").mkdir(exist_ok=True)
    (ROOT / "dist" / f"level.dat.{node.TARGET}.{stamp}").write_bytes(data)
    version, name, root = parse_level_dat(data)
    if enable_experiment(root):
        new = build_level_dat(version, name, root)
        # Round-trip check before anything is written back.
        assert parse_level_dat(new)[2] == root
        upload(folder, f"level.dat.bak-{stamp}", data)
        upload(folder, "level.dat", new)
        print("Beta APIs enabled")
    else:
        print("Beta APIs already enabled")
    if was_running:
        print("starting server...")
        action("start_server")
        wait_running(True)
    print("done")


if __name__ == "__main__":
    main()
