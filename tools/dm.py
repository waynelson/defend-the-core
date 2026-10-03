"""Send DM commands to the mc-testing console and read back [DM] lines.

    python tools/dm.py ping
    python tools/dm.py spawn '{"mob":"dm:zombie","count":3,"dist":40}'
    python tools/dm.py raw "time set day"     # any console command
    python tools/dm.py log [N]                # last N [DM] lines (default 40)
    python tools/dm.py console [N]            # last N raw log lines

Commands other than raw/log/console become `scriptevent dm:<action> <json>`,
and the [DM] lines that arrive within a few seconds are printed.
"""

import html
import json
import re
import sys
import time

import node

DM_LINE = re.compile(r"\[DM\] (\{.*\})")


def console_lines():
    result = node.request("get", "servers/{sid}/logs")
    if not isinstance(result, dict) or result.get("status") != "ok":
        sys.exit(f"could not read logs: {result}")
    return [html.unescape(line) for line in result["data"]]


def dm_events(lines):
    events = []
    for line in lines:
        match = DM_LINE.search(line)
        if match:
            try:
                events.append(json.loads(match.group(1)))
            except ValueError:
                events.append({"t": "unparsed", "line": line})
    return events


class Watcher:
    """Collects [DM] events across polls. Crafty keeps only a short output
    buffer, so long tests must poll often; timestamped lines de-duplicate."""

    def __init__(self):
        self.seen = set(console_lines())
        self.events = []

    def poll(self):
        new = []
        for line in console_lines():
            if line not in self.seen:
                self.seen.add(line)
                new.append(line)
        events = dm_events(new)
        self.events.extend(events)
        return events

    def run(self, seconds, interval=1.0, echo=False):
        deadline = time.time() + seconds
        while time.time() < deadline:
            time.sleep(interval)
            for event in self.poll():
                if echo:
                    print(json.dumps(event))
        return self.events


def send(command):
    result = node.request(
        "post", "servers/{sid}/stdin", raw=command.encode(), content_type="text/plain"
    )
    if not isinstance(result, dict) or result.get("status") != "ok":
        sys.exit(f"send failed: {result}")


def send_and_watch(command, wait=4.0):
    watcher = Watcher()
    send(command)
    if not watcher.run(wait, interval=0.75, echo=True):
        print("(no [DM] lines yet)")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    action, rest = sys.argv[1], sys.argv[2:]
    if action == "log":
        for event in dm_events(console_lines())[-int(rest[0] if rest else 40):]:
            print(json.dumps(event))
    elif action == "console":
        print("\n".join(console_lines()[-int(rest[0] if rest else 40):]))
    elif action == "raw":
        send(" ".join(rest))
        time.sleep(1.5)
        print("\n".join(console_lines()[-8:]))
    else:
        payload = rest[0] if rest else "{}"
        send_and_watch(f"scriptevent dm:{action} {payload}")


if __name__ == "__main__":
    main()
