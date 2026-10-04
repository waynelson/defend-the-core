"""Stress test on the dev server: many attackers against many turrets.

    python tools/stress.py arena          # flatten an 81x81 arena around the core
    python tools/stress.py run [plan]     # run the plan (default: full), print a table
    python tools/stress.py one T M [S]    # one step: T turrets, M mobs, S seconds

Each step clears the field, places the turrets in rings around the core,
spawns the attackers from four sides, keeps their number topped up and the
core alive, and samples tick timing (dm:perf) and the node's CPU and memory.
A step that drops below MIN_TPS stops that series from going higher.

Dev only: refuses to run against DTC_TARGET=beta.
"""

import json
import statistics
import sys
import time

import dm
import node

if node.TARGET != "dev":
    sys.exit("stress tests run on dev only")

MIX = ["dm:swarmer", "dm:swarmer", "dm:zombie", "dm:zombie", "dm:skeleton", "dm:digger"]
BEARINGS = [0, 90, 180, 270]
SPAWN_DIST = 34
SETTLE_S = 8
MIN_TPS = 8

PLANS = {
    "mobs": [(0, m) for m in (25, 50, 100, 150, 200, 300, 400, 600)],
    "turrets": [(t, 100) for t in (10, 25, 50, 100, 150, 200)],
    "mix": [(t, m) for t in (25, 50, 100) for m in (50, 100, 200, 300)],
}
PLANS["full"] = PLANS["mobs"] + PLANS["turrets"] + PLANS["mix"]


def act(action, payload=None):
    dm.send(f"scriptevent dm:{action} {json.dumps(payload or {}, separators=(',', ':'))}")


def raw(command):
    dm.send(command)


def node_stats():
    try:
        server = node.request("get", "servers/{sid}/stats")["data"]
        host = node.request("get", "crafty/stats")["data"]
        return {
            "proc_cpu": server.get("cpu"),
            "proc_mem_mb": round((server.get("mem") or 0) / 2**20),
            "host_cpu": host.get("cpu_usage"),
            "host_mem_pct": host.get("mem_percent"),
        }
    except Exception as why:  # noqa: BLE001 - stats are best effort
        return {"error": str(why)}


def arena():
    """An 81x81 stone floor at y 65 around (0, 0), cleared 25 high, with
    the core on a beacon in the middle."""
    for z in range(-40, 41, 10):
        z2 = min(40, z + 9)
        raw(f"fill -40 58 {z} 40 64 {z2} dirt")
        raw(f"fill -40 65 {z} 40 65 {z2} stone")
        raw(f"fill -40 66 {z} 40 90 {z2} air")
    act("core_clear")
    time.sleep(1)
    act("core_set", {"x": 0, "y": 65, "z": 0, "setblock": True})
    act("tickingarea", {"radius": 4})
    time.sleep(3)
    print("\n".join(dm.console_lines()[-6:]))


def spawn(count):
    """`count` attackers from four sides, in groups of up to 25."""
    n = 0
    while n < count:
        for bearing in BEARINGS:
            if n >= count:
                break
            mob = MIX[n % len(MIX)]
            k = min(25, count - n)
            act("spawn", {"mob": mob, "count": k, "bearing": bearing, "dist": SPAWN_DIST})
            n += k


def step(turrets, mobs, seconds=40):
    act("stress", {"clear": True})
    act("phase", {"phase": "wave"})
    time.sleep(2)
    if turrets:
        act("stress", {"turrets": turrets})
    if mobs:
        spawn(mobs)
    watcher = dm.Watcher()
    watcher.poll()  # skip what's already there
    samples, stats = [], []
    start = time.time()
    last_top = last_core = start
    while time.time() - start < seconds + SETTLE_S:
        time.sleep(2)
        now = time.time()
        for e in watcher.poll():
            if e.get("t") == "perf" and now - start > SETTLE_S:
                samples.append(e)
        if now - last_core > 5:
            act("core", {"hp": "max"})
            last_core = now
        if mobs and now - last_top > 10 and samples:
            alive = samples[-1]["attackers"]
            if alive < mobs * 0.8:
                spawn(mobs - alive)
            last_top = now
        if now - start > SETTLE_S and len(stats) < (now - start - SETTLE_S) / 10:
            stats.append(node_stats())
    act("stress", {"clear": True})
    if not samples:
        return {"turrets": turrets, "mobs": mobs, "error": "no perf samples"}
    tps = [s["tps"] for s in samples]
    good = [s for s in stats if "error" not in s]
    return {
        "turrets": turrets,
        "mobs": mobs,
        "tps_med": statistics.median(tps),
        "tps_min": min(tps),
        "tick_ms": statistics.median(s["tick_ms"] for s in samples),
        "max_ms": max(s["max_ms"] for s in samples),
        "alive": round(statistics.mean(s["attackers"] for s in samples)),
        "entities": max(s["entities"] for s in samples),
        "arrows": max(s["projectiles"] for s in samples),
        "proc_cpu": max((s["proc_cpu"] or 0) for s in good) if good else None,
        "proc_mem_mb": max(s["proc_mem_mb"] for s in good) if good else None,
        "host_mem_pct": max((s["host_mem_pct"] or 0) for s in good) if good else None,
    }


COLS = ["turrets", "mobs", "alive", "entities", "arrows", "tps_med", "tps_min", "tick_ms", "max_ms",
        "proc_cpu", "proc_mem_mb", "host_mem_pct"]


def show(row):
    print(" ".join(f"{str(row.get(c, '')):>11}" for c in COLS), flush=True)


def run(plan):
    act("perf", {"on": True, "every": 40})
    print(" ".join(f"{c:>11}" for c in COLS), flush=True)
    results = []
    failed = []  # (turrets, mobs) steps that fell below MIN_TPS
    for turrets, mobs in PLANS[plan]:
        # Anything at least as heavy as a failed step would fail too.
        if any(turrets >= t and mobs >= m for t, m in failed):
            continue
        row = step(turrets, mobs)
        results.append(row)
        show(row)
        if row.get("tps_med", 0) < MIN_TPS:
            failed.append((turrets, mobs))
    act("phase", {"phase": "setup"})
    act("perf", {"on": False})
    with open("dist/stress.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)
    return results


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == "arena":
        arena()
    elif sys.argv[1] == "run":
        run(sys.argv[2] if len(sys.argv) > 2 else "full")
    elif sys.argv[1] == "one":
        act("perf", {"on": True, "every": 40})
        print(" ".join(f"{c:>11}" for c in COLS))
        show(step(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]) if len(sys.argv) > 4 else 40))
        act("phase", {"phase": "setup"})
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
