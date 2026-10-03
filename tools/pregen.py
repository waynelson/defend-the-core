"""Generate every chunk within a radius of a point before players join.

    DTC_TARGET=beta python tools/pregen.py -174 128 10   # block x, z, radius in chunks

BDS has no pre-generation command, but a ticking area loads (and so
generates) every chunk inside it. BDS only saves chunks that changed since
generation, so each chunk is also touched (a block placed and removed at
the build limit) and the batch flushed with save hold before its area goes.
Ticking areas are capped at 100 chunks each and 10 per world, so the
square is covered by 10x10-chunk rectangles, a few at a time.
"""

import re
import sys
import time

import dm

BATCH = 3  # temporary areas at once (the world may already have others)
TIMEOUT = 300  # seconds per batch
# A chunk answers the probe as soon as it loads; give generation time to
# finish before flushing the batch to disk.
SETTLE = 30
PREFIX = "dtc_gen"


def chunk_loaded_probe(cx, cz):
    # Unloaded chunks answer "outside of the world"; loaded ones give a
    # normal yes/no about the block.
    return f"testforblock {cx * 16 + 8} 319 {cz * 16 + 8} air"


def wait_loaded(chunks):
    pending = set(chunks)
    deadline = time.time() + TIMEOUT
    while pending and time.time() < deadline:
        # Probe in small groups and read after each: Crafty keeps only ~70
        # console lines, so a big burst would push the answers out.
        todo = sorted(pending)
        for i in range(0, len(todo), 25):
            seen = set(dm.console_lines())
            for cx, cz in todo[i:i + 25]:
                dm.send(chunk_loaded_probe(cx, cz))
            time.sleep(1)
            for line in dm.console_lines():
                if line in seen:
                    continue
                m = re.search(r"block at (-?\d+),319,(-?\d+)", line)
                if m and "outside" not in line:
                    pending.discard(((int(m.group(1)) - 8) // 16, (int(m.group(2)) - 8) // 16))
        print(f"  {len(chunks) - len(pending)}/{len(chunks)} loaded")
        if pending:
            time.sleep(3)
    return pending


def touch(chunks):
    """BDS only saves chunks that changed since they were generated
    (untouched ones are regenerated from the seed on every load; tested).
    Placing and removing a block at the build limit marks each one changed
    without leaving a trace."""
    for cx, cz in chunks:
        x, z = cx * 16 + 8, cz * 16 + 8
        dm.send(f"setblock {x} 319 {z} glass")
        dm.send(f"setblock {x} 319 {z} air")


def flush_to_disk():
    """`save hold` makes BDS write every loaded chunk out; wait until it
    says the files are ready, then let it carry on."""
    dm.send("save hold")
    try:
        for _ in range(30):
            time.sleep(1)
            seen = set(dm.console_lines())
            dm.send("save query")
            time.sleep(1)
            if any("ready to be copied" in l for l in dm.console_lines() if l not in seen):
                return True
        return False
    finally:
        dm.send("save resume")


def main():
    x, z, radius = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 10
    ccx, ccz = x >> 4, z >> 4
    xs = list(range(ccx - radius, ccx + radius + 1))
    zs = list(range(ccz - radius, ccz + radius + 1))
    rects = [(xs[i:i + 10], zs[j:j + 10]) for i in range(0, len(xs), 10) for j in range(0, len(zs), 10)]
    print(f"{len(xs) * len(zs)} chunks around chunk {ccx},{ccz} in {len(rects)} areas")
    missing = []
    for start in range(0, len(rects), BATCH):
        batch = rects[start:start + BATCH]
        names = []
        chunks = []
        for k, (rx, rz) in enumerate(batch):
            name = f"{PREFIX}{start + k}"
            names.append(name)
            dm.send(f"tickingarea remove {name}")
            dm.send(
                f"tickingarea add {rx[0] * 16} 0 {rz[0] * 16} {rx[-1] * 16 + 15} 0 {rz[-1] * 16 + 15} {name} true"
            )
            chunks += [(cx, cz) for cx in rx for cz in rz]
        time.sleep(2)
        print(f"batch {start // BATCH + 1}: areas {', '.join(names)} ({len(chunks)} chunks)")
        missing += wait_loaded(chunks)
        print(f"  settling {SETTLE}s so the chunks finish generating")
        time.sleep(SETTLE)
        touch(chunks)
        print(f"  marked {len(chunks)} chunks changed so they get saved")
        # Then write them out while still loaded.
        print("  flushed to disk" if flush_to_disk() else "  flush not confirmed")
        for name in names:
            dm.send(f"tickingarea remove {name}")
        time.sleep(1)
    print("done" if not missing else f"{len(missing)} chunks never answered: {sorted(missing)[:10]}")


if __name__ == "__main__":
    main()
