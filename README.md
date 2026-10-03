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
| Attackers | Target the core first; players only inside a 6-block aggro radius or when they hit the mob. See the roster below. |
| Breaching | Stuck attackers break what's in their way. Each block type has a breach time (cobblestone ~4 s for one digger, obsidian ~100 s), scaled by the DM's breach multiplier; damage decays, and broken blocks drop nothing. Explosions never destroy the core's block. |
| Waves and phases | Waves are assembled from groups and spawn on a schedule; phases (setup, prep, wave, intermission, won, lost) can carry a timer shown on every player's action bar with the core's health. Clearing the final wave wins. |
| Supply depot | An open spruce pavilion about 50 blocks from the core, with 11 labelled chests of starter kits and a path back to the core. |

### Roster

| Mob | Look | Breach module (defaults) |
| --- | --- | --- |
| `dm:zombie` | zombie | none |
| `dm:skeleton` | skeleton | none |
| `dm:swarmer` | husk | `dig` (dps 0.5) |
| `dm:digger` | zombie with pickaxe | `dig` (dps 1.5) |
| `dm:sapper` | creeper | `detonate_stuck` (after 6 s stuck) |
| `dm:siege_skeleton` | stray | `siege_arrow` (1.5 per hit; stuck archers lob volleys) |
| `dm:ghast` | ghast (flies) | `artillery` (fireball at the core every 5 s within 64 blocks; drifts in to ~18 blocks). Blasts break blocks. Targets the core only. |
| `dm:blaze` | blaze (hovers) | none: bursts of small fireballs that set fires |
| `dm:phantom` | phantom (flies) | none: swoops at the core; a roof over the core stops it |

Modules are set per spawn group, so any mob can carry any module.
Flyers ignore walls; their answer is cover (a roof) and players shooting back.
Ghast blasts and dm:fireball explosions never destroy the core's own block.

### Players and chat

The add-on reports who is online every 5 seconds (health, position, distance
to the core, game mode, dimension, biome) and on join, leave, death and game
mode changes; `dm:players` asks for the list.

Chat is relayed by a separate pack, **Defend the Core Chat Bridge**
(`packs/chat`), because chat events are only in the beta Script API. It needs
the world's **Beta APIs** experiment; BDS can't toggle that, so
`tools/experiments.py --enable` stops the server, edits `level.dat` (with
backups) and starts it again. Players don't need to do anything. The bridge
is pinned to the beta API of one BDS release, so a BDS update can stop it
until it is rebuilt; only chat relay is affected.

## DM commands

The DM tab in the Crafty fork drives all of this. By hand,
everything runs from the server console as `scriptevent dm:<action> <json>`.
Every message may carry `v` (protocol version, 1) and `msg_id`; the add-on
answers `ack` or `nack` with the same `msg_id`. Status comes back as
`[DM] {json}` lines in the server log, which needs
`content-log-console-output-enabled=true` and `content-log-level=info` in
`server.properties`. Messages are limited to 2048 characters (1000 through
Crafty's remote console).

| Action | Payload | Does |
| --- | --- | --- |
| `wave_begin` | `{"wave_id":"w1","final"?:true}` | Open a wave. |
| `group` | `{"wave_id":"w1","mob":"dm:digger","count":5,"bearing":0,"dist":40,"interval_s":1,"delay_s"?,"targeting"?,"modules"?}` | Add a spawn group to the open wave. Spawn at `bearing`/`dist` from the core, a named `point`, or `x`/`z`. |
| `wave_commit` | `{"wave_id":"w1"}` | Launch the wave. |
| `phase` | `{"phase":"prep","duration_s":600}` | Enter a phase, with an optional timer. |
| `control` | `{"cmd":"pause"}` | `pause`, `resume`, `abort` (the wave) or `kill_all`. |
| `config` | `{"breach_mult":1.5,"decay_rate":0.25,"max_attackers":60,"hardness":{"minecraft:stone":5}}` | Live tuning. |
| `points` | `{"points":{"north":{"x":0,"z":-40}}}` | Named spawn points. |
| `core` | `{"hp":"max"}` | Heal or set core health. |
| `core_set` | `{"x":0,"z":0,"y"?,"setblock"?,"inside"?}` | Place the core at a block (surface if no `y`). Placing the first beacon in-game also registers the core. |
| `core_clear` | `{}` | Remove the core. |
| `setup` | `{}` | One-shot world setup: core at world spawn, ticking area, depot, world spawn at the depot. |
| `tickingarea` | `{"radius":4}` | Keep chunks around the core loaded (radius in chunks, max 4). |
| `spawn` | `{"mob":"dm:digger","count":3,"bearing":90,"dist":30}` | Ad-hoc spawn outside a wave. |
| `targeting` | `{"targeting":"core_only"}` | Switch every live attacker's targeting (`core_only`, `prioritized`, `nearest`). |
| `kill_all` | `{}` | Remove all attackers (aborts a running wave). |
| `depot` | `{"dist":50}` or `{"x":..,"z":..,"y"?}` | Build the supply depot on the flattest spot at `dist` from the core, or at x/z. Run again to rebuild in place; add `"relocate":true` to move it. |
| `depot_restock` | `{}` | Refill every depot chest with its kit. |
| `probe` | `{"every":20}` / `{"on":false}` | Log attacker positions and distance to the core. |
| `players` | `{}` | Everyone online, as in the `players` reports. |
| `rain` | `{"count":12,"radius":12,"duration_s":6,"quality":2}` | Reward: key survival items fall from the sky at random spots around the core (quality 1 basic, 2 good, 3 great). |
| `status`, `roster`, `ping` | `{}` | Full game state / mobs and module ranges / connectivity check. |

Starter kits are defined in [packs/BP/scripts/kits.js](packs/BP/scripts/kits.js).

## Layout

```
packs/BP/          behavior pack: entities/ (generated), loot_tables/, scripts/
packs/RP/          resource pack: client entities, lang
tools/gen_entities.py  generate the attacker entity files from one roster
tools/build.py     zip both packs into dist/ (--release: tagged version)
tools/deploy.py    build and install on a Crafty-managed server via its addon API
tools/dm.py        send dm:* commands through Crafty and print the [DM] replies
tools/experiments.py  enable the Beta APIs experiment in a server's world (for the chat bridge)
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
