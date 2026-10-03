"""Show a countdown on every player's action bar, driven from the console.

    DTC_TARGET=beta python tools/timer.py 10m "Prep phase"
    python tools/timer.py 90s

A stopgap until the add-on's phase timers (dm:phase duration_s) exist.
"""

import re
import sys
import time

import dm


def parse_duration(text: str) -> int:
    match = re.fullmatch(r"(\d+)([ms]?)", text)
    if not match:
        sys.exit("duration looks like 10m, 90s or 600")
    value, unit = int(match.group(1)), match.group(2)
    return value * 60 if unit == "m" else value


def main():
    total = parse_duration(sys.argv[1] if len(sys.argv) > 1 else "10m")
    label = sys.argv[2] if len(sys.argv) > 2 else "Time left"
    end = time.time() + total
    dm.send(f"title @a title §e{label}")
    dm.send(f"title @a subtitle §f{total // 60}:{total % 60:02d}")
    while (left := round(end - time.time())) > 0:
        minutes, seconds = divmod(left, 60)
        color = "§c" if left <= 30 else "§6" if left <= 60 else "§e"
        try:
            dm.send(f"title @a actionbar {color}{label}: {minutes}:{seconds:02d}")
        except SystemExit as err:  # server restarted or briefly unreachable
            print(err, file=sys.stderr)
        time.sleep(max(0.0, 1 - ((time.time() - end) % 1)))
    dm.send("title @a title §cTime's up!")
    dm.send("playsound note.pling @a")


if __name__ == "__main__":
    main()
