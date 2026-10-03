# Defend the Core

A Minecraft Bedrock add-on for a tower-defense game run by a Dungeon Master.
Players place a core and build defenses around it. The DM, working outside the
game from a [Crafty Controller](https://craftycontrol.com/) panel, sends waves
of mobs that path to the core and break through whatever is in the way.

This repo is the Bedrock side: a behavior pack (entities and Script API code)
and a resource pack (client entities reusing vanilla models and textures). The
Crafty DM tab lives in a separate Crafty fork.

**Status: alpha.** The M0 spike is done (see [docs/M0.md](docs/M0.md)); breach
mechanics and waves come next.

## What's in it

| Thing | Notes |
| --- | --- |
| `dm:core` | The core. Spawned on a beacon, takes damage only from DM attackers. |
| `dm:zombie`, `dm:skeleton` | Attackers that target the core first. Players are only targeted inside an aggro radius or when they hit the mob. |
| Supply depot | An open spruce pavilion about 50 blocks from the core, with 11 labelled chests of starter kits and a path back to the core. |

## DM commands

Everything runs from the server console (Crafty's console tab works) as
`scriptevent dm:<action> <json>`. Replies are `[DM] {json}` lines in the
server log. The server needs `content-log-console-output-enabled=true` in
`server.properties` for those lines to appear. Messages are limited to 2048
characters.

| Action | Payload | Does |
| --- | --- | --- |
| `core_set` | `{"x":0,"z":0,"y"?,"setblock"?,"inside"?}` | Place the core at a block (surface if no `y`). Placing the first beacon in-game also registers the core. |
| `core_hp` | `{"hp":200}` | Set core health. |
| `core_clear` | `{}` | Remove the core. |
| `tickingarea` | `{"radius":4}` | Keep chunks around the core loaded (radius in chunks, max 4). |
| `spawn` | `{"mob":"dm:zombie","count":3,"dist":40,"bearing":0,"targeting":"prioritized"}` | Spawn attackers at a distance and bearing (0 = north) from the core. `targeting`: `core_only`, `prioritized`, `nearest`. |
| `targeting` | `{"targeting":"core_only"}` | Switch every live attacker's targeting. |
| `kill_all` | `{}` | Remove all attackers. |
| `depot` | `{"dist":50}` or `{"x":..,"z":..,"y"?}` | Build the supply depot on the flattest spot at `dist` from the core, or at x/z. Run again to rebuild in place; add `"relocate":true` to move it. |
| `depot_restock` | `{}` | Refill every depot chest with its kit. |
| `probe` | `{"every":20}` / `{"on":false}` | Log attacker positions and distance to the core. |
| `status`, `ping` | `{}` | Core and attacker counts / connectivity check. |

Starter kits are defined in [packs/BP/scripts/kits.js](packs/BP/scripts/kits.js).

## Layout

```
packs/BP/          behavior pack: entities/, scripts/ (main.js, depot.js, kits.js)
packs/RP/          resource pack: client entities, lang
tools/build.py     zip both packs into dist/defend_the_core.mcaddon
tools/deploy.py    build and install on a Crafty-managed server via its addon API
tools/dm.py        send dm:* commands through Crafty and print the [DM] replies
docs/M0.md         spike results
```

## Building

```
npm install         # Script API typings (@minecraft/server 2.10.0) and TypeScript
npm run check       # type-check the scripts
python tools/build.py
```

Import `dist/defend_the_core.mcaddon` into a world, or install it with any
add-on manager. The packs target Bedrock 1.26.50+.

`tools/deploy.py` and `tools/dm.py` talk to a Crafty node through a Crafty
hub's stored remote-node token. They are dev conveniences for one particular
setup; see the top of `tools/node.py` for the environment variables.

The client entity files in `packs/RP/entity` are adapted from Mojang's
[bedrock-samples](https://github.com/Mojang/bedrock-samples).
