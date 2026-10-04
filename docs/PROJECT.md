# Defend the Core: project control document

The handoff document for anyone (human or agent) picking up development. It
describes what exists, where it lives, how to change and ship it, the rules
of the road, and what's next. **This file is authoritative; README.md is out
of date** (it still describes the 0.6 Quartermaster and depot).

Last updated: 2026-10-04, add-on v0.7.3 on dev (beta: see Current state).

---

## 1. What this is

**Defend the Core** is a Minecraft Bedrock tower-defense game mode run by a
Dungeon Master (DM). Players defend a core block from waves of mobs that path
to it and breach whatever is in the way; they earn coins and skill points,
buy gear and defenses on Market Street, and place turrets and mines. The DM
runs the game from a **DM tab** in a Crafty Controller panel (or lets the
**auto DM** run it).

Two deliverables:

| Part | Where | What |
| --- | --- | --- |
| Bedrock add-on | `C:\defend-the-core`, public at github.com/waynelson/defend-the-core | Behavior pack (entities, items, Script API code), resource pack, chat-bridge pack |
| DM tab | Wayne's Crafty fork, `C:\Crafty` / `C:\Crafty-Dev`, branch `local/nelson-next` | Panel UI, API, protocol validation, world map, remote-node support |

The original design spec ("Defend the Core — Bedrock Add-on & Crafty Plus DM
Plugin Spec") was uploaded in the first chat session and is **not in either
repo**; ask Wayne for it if you need the original intent. `docs/M0.md` covers
the first spike.

## 2. Working agreement (read first)

- **Owner:** Wayne (waynelson). Plays and tests with family and beta testers.
- **Two servers, two roles:**
  - **mc-testing = dev.** Free to wipe, restart, flatten, stress. Deploy here
    as often as you like.
  - **mc-defend = beta.** Real testers play here. **Deploy, restart, reset or
    run world-changing commands on beta only when Wayne asks.** Beta only
    ever runs a tagged release.
- **Crafty service restarts are Wayne's.** The hub runs as a Windows service
  and restarting it needs admin. When a fork change needs the panel
  restarted, say so; don't try to restart it.
- **Don't push the Crafty fork** to GitLab without asking (it has never been
  pushed; commits stay local). Pushing the add-on to GitHub after committing
  has been routine.
- **Report honestly what was tested.** Most features can be checked from the
  console, but anything needing a player (menus, combat feel, locked items)
  is "untested in-game" until Wayne tries it. Say which is which.
- **UI style (DM tab):** solid Bootstrap buttons (outline buttons were
  unreadable), plain small text (not `text-muted`), plain-English labels.
- Wayne prefers a recommendation over a survey of options, and short
  plain-language summaries.

## 3. Repos, branches and commit flow

### Add-on (`C:\defend-the-core`)

- Branch `main`; releases are annotated tags `vX.Y.Z` (v0.1.0 … v0.7.1).
- Push with the GitHub CLI's credentials (the Windows credential store
  fails to persist):
  ```
  git -c credential.helper= -c "credential.helper=!gh auth git-credential" push origin main --follow-tags
  ```
- `vendor/bedrock-samples` holds vanilla definitions for reference;
  `types/` and `node_modules/` back the type checker.

### Crafty fork

- Remotes: `origin` = gitlab.com/personal-use-group7112940/crafty-4,
  `upstream` = gitlab.com/crafty-controller/crafty-4.
- Branches: `local/nelson` (older, tracks origin), `feature/dm-tab` (first DM
  tab cut), **`local/nelson-next`** (all current DM work; never pushed).
- Two worktrees of one repo:
  - `C:\Crafty-Dev` has `local/nelson-next` checked out.
  - `C:\Crafty` is the **running service's code**, a *detached HEAD* at the
    same commit.
- **Commit flow** (keeps both in step):
  ```
  cd C:\Crafty            # edit and test here
  git add <files> && git commit
  C=$(git rev-parse HEAD)
  cd C:\Crafty-Dev && git merge --ff-only $C
  cd C:\Crafty && git switch --detach local/nelson-next
  ```
- Hub tests: `C:\Crafty\.venv\Scripts\python.exe -m pytest -q`
  (whole suite ~540 tests, ~1 min; DM only: `tests/classes/dm`).
- Ignore the untracked `crafty.exe` / `crafty_updater.exe` in `C:\Crafty`.

## 4. Environments

| | Hub | mc-testing (dev) | mc-defend (beta) |
| --- | --- | --- | --- |
| Machine | This Windows PC, Crafty service from `C:\Crafty` | Linux node, Crafty at `/opt/crafty` | Linux node, Crafty at `/opt/crafty` |
| Hardware | | 2 cores @ 3.5 GHz, 1.3 GB RAM | 2 cores, 1.4 GB RAM |
| Crafty server id | | `53b99c65-fc31-4c5e-9434-c806c4db0aa0` | `8c0e5b50-d3fa-444c-87df-62e2995b5ba3` |
| BDS | | 1.26.52 | 1.26.52 |

- The hub reaches nodes through `NodeClient` with a certificate-pinned API
  token. The dev tools (`tools/node.py`) read the token from the hub DB
  (`C:\crafty\app\config\db\crafty.sqlite`) and skip certificate checks.
- Both servers need `content-log-console-output-enabled=true` and
  `content-log-level=info` in `server.properties` (that's how `[DM]` lines
  reach the console), and the **Beta APIs** experiment (for the chat bridge;
  `tools/experiments.py`). Players need nothing special.
- World rules (no natural mob spawns, no insomnia phantoms, no PvP) are set
  by the add-on on every load (`GAMERULES` in `main.js`).

**Beta world** "Nelson - Defend the CORE World 2", seed 1829058741, 441
chunks pre-generated: core (-139, 62, 153); depot centre (-182, 69, 128),
facing east; Market Street entrance (-190, 70, 128), plaza (-246, 70, 128).
New game #2 started (wave 0, setup) on 2026-10-04.

**Dev world**: core (0, 66, 0) on a flattened 81×81 stone stress arena (y 65,
x/z −40..40); depot (43, 64, −25) facing west; Market Street runs east
(x ≈ 51..115). Dev is a mess by design; wipe and re-run `dm:setup` freely.

## 5. Architecture

### How the hub and the add-on talk

```
DM tab (browser) ──HTTPS──> hub API (/api/v2/servers/<id>/dm)
   hub validates payload (app/classes/dm/protocol.py) ──> console command:
       scriptevent dm:<action> <json>          (remote servers: via NodeClient)
   add-on (main.js handlers) does it, prints:
       [DM] {"t": "ack" | "nack" | <event>, ...}   (content log -> console)
   hub polls the console buffer, parses [DM] lines (log_parser.py),
   keeps state per server (session.py), DM tab polls state.
```

- `scriptevent` payloads are capped at 2048 chars, **~1000 through Crafty's
  remote console**. Keep payloads small.
- **Crafty keeps only 70 console lines** (`virtual_terminal_lines`): anything
  reading `[DM]` lines must poll often and de-duplicate (see `tools/dm.py`
  `Watcher`).
- The hub's `protocol.py` `ACTIONS` dict mirrors every add-on action with a
  JSON schema (`additionalProperties: false`). **Adding an action or field
  to the add-on means adding it to `protocol.py` too**, or the DM tab
  rejects it. Add a case to `tests/classes/dm/test_protocol.py`.
- `WORLD_ACTIONS` in `protocol.py` (weather, time, give, say, title,
  tp_core, tell, heal, kick) are plain vanilla commands built by the hub,
  not add-on actions.
- Protocol version: `PROTOCOL = 1` (in `main.js`, reported in `loaded`).

### Add-on packs

| Pack | Contents |
| --- | --- |
| `packs/BP` | `entities/` (**generated**), `items/` (generated), `scripts/`, `loot_tables/`, `texts/` |
| `packs/RP` | client entities (generated from `tools/templates/*.entity.json`, 1.8/1.10 vanilla formats), `textures/item_texture.json`, `texts/en_US.lang` (generated) |
| `packs/chat` | `chat.js`: relays player chat to `[DM]` lines; uses `@minecraft/server` 2.11.0-beta, so it needs Beta APIs |

**Entity and item JSON is generated by `tools/gen_entities.py`. Edit that
script, run it, never hand-edit the output.** The main pack uses stable
`@minecraft/server` 2.10.0 and `@minecraft/server-ui` 2.2.0.

### Script modules (`packs/BP/scripts`)

| Module | Role |
| --- | --- |
| `main.js` | Action router (`handlers`), `entityDie` bounty/XP, world-load startup, `GAMERULES` |
| `util.js` | `emit` (prints `[DM]` lines), `store`/`stored` (JSON world properties), `overworld`, helpers |
| `core.js` | The core entity on a beacon: place, clear, HP, label |
| `game.js` | Phases (setup, prep, wave, intermission, won, lost), waves (begin/group/commit), HUD, `hooks` (timerDone, waveCleared, lost, newGame), `resetGame`, `gameNo` |
| `spawner.js` / `roster.js` | Spawning, spawn points, `MOBS` roster and default targeting |
| `breach.js` | Block damage map, stuck detection (first `max_attackers`=60 mobs), modules: dig, detonate_stuck, siege_arrow, artillery |
| `auto.js` | Auto DM: prep → generated wave → intermission (supply drop, restock, tower) → … ; watchdog and wave timeout |
| `economy.js` | `coins` scoreboard, settings, wave pay, `BOUNTY`, `payBounty` (full to the final blow, `bounty_share` to everyone else) |
| `progression.js` | XP, levels (instant level-ups), skill points (`dm_xp`, `dm_level`, `dm_sp`), round-end XP |
| `stats.js` | Six skills, per-game reset, benefits (damage bonus, health boost, regen), skill vendors, Armorer |
| `loadout.js` | Spawn kit; armour at the Armor level, **locked in slot**, kept on death, enchanted per Armorer |
| `shop.js` | Vendor kinds (`VENDORS`), `spawnVendor`, routing, Engineer and Provisioner stock |
| `mason.js` | Building blocks by the stack, priced from breach HP |
| `ui.js` | Shared form menus, `charge`, `sell`, `giveItem` |
| `defenses.js` | Turrets (tiers, script-kept HP, repair/upgrade/pick-up menu, limits) and mines; arrow cleanup |
| `depot.js` | Free supply depot pavilion, barrels (`kits.js`), path to the core, `Builder` (rotated local frame) |
| `market.js` | Market Street structure and vendor stalls (built with a temporary ticking area) |
| `tower.js` | Procedural dungeon towers with guards and loot near the spawn (avoids Market Street) |
| `rewards.js` | Supply-drop item rain, `lootStack` |
| `players.js` | Player snapshots for the DM tab |
| `perf.js` | `dm:perf` tick timing sampler, `dm:stress` test helper |

### World data

- World dynamic properties: `dtc:core`, `dtc:depot`, `dtc:points`,
  `dtc:game` (incl. `game_no`), `dtc:auto`, `dtc:tower`, `dtc:config`
  (breach), `dtc:economy`, `dtc:progression`, `dtc:mines`, `dtc:market`.
- Player: `dtc:stats` (`{game, ranged, melee, health, regen, armor,
  engineer, armor_ench}`).
- Entities: turrets `dtc:owner`, `dtc:tier`, `dtc:eng`; vendors `dtc:shop`;
  attackers `dtc:last_hit_by`; guards `dtc:home`, `dtc:tower`.
- Scoreboards: `coins` (sidebar), `dm_xp`, `dm_level`, `dm_sp`.

### Hub side (Crafty fork)

| File | Role |
| --- | --- |
| `app/classes/dm/protocol.py` | Action schemas, `validate_action`, world actions |
| `app/classes/dm/log_parser.py`, `session.py` | Parse `[DM]` lines; per-server state and event feed |
| `app/classes/dm/world_map.py`, `world_snapshot.py` | Pure-Python LevelDB + Bedrock chunk reader; top-down map renders from a safe world copy (`save hold/query/resume`) |
| `app/classes/controllers/dm_controller.py` | Sessions, sending, armed waves (auto-launch when a timer ends), map refresh, server stats |
| `app/classes/web/routes/api/servers/server/dm.py` | The DM API route (needs the Commands permission) |
| `app/classes/web/routes/api/crafty/remote_nodes/index.py` | Remote-server DM handler |
| `app/classes/remote_nodes/node_client.py` | Pinned-cert node client (`download` used by the map) |
| `app/frontend/static/assets/js/shared/dm.js`, `dm-map.js` | The DM tab UI (cards: game, waves, auto DM, towers, economy, levels, world, setup, players, chat, map, feed) |
| `app/frontend/static/assets/css/partial/crafty-dm.css` | Styles |
| `app/frontend/templates/panel/server_dm.html`, `remote_dm.html` | Tab templates |
| `tests/classes/dm/` | protocol, session, world-map tests |

## 6. The game as implemented (v0.7.x)

- **Flow:** setup → prep (timer) → wave → intermission → … → won/lost.
  Clearing the final wave wins; the core dying loses. `new_game` resets the
  wave count and every player.
- **Auto DM defaults:** prep 180 s, intermission 90 s, 10 waves, difficulty
  2 + 0.7/wave (cap 10), flyers on, supply drop each intermission, depot
  restock every 3 waves, a tower every 2 intermissions, wave timeout 420 s.
  Biggest default wave ≈ 35 mobs. **Max mobs alive** (`config max_alive`,
  default 150): wave spawns past the cap queue and come in (≤ 6 per 5 ticks)
  as others die; `wave_capped` is emitted once per wave. DM `spawn` commands
  ignore the cap.
- **Attackers:** zombie, skeleton, swarmer, digger, sapper, siege skeleton,
  phantom, blaze, ghast (ghast targets the core only; artillery module).
- **Fresh start each game:** 1,000 coins (`start_coins`) and 2 skill points
  (progression `start_sp`), level 1 in all six skills, level-1 kit (locked leather armour, stone sword, bow, 32 arrows).
  Players from an older game or version are wiped on first appearance;
  never-seen players keep their (starting) items.
- **Income:** wave pay 50 + 10 × wave to everyone; bounty per kill (swarmer
  1, zombie 2, skeleton 3, digger/siege/phantom/guards 4, sapper 5, blaze 6,
  ghast 12, captain 20): full to the final blow, 50% to everyone else
  (`bounty_share`). Tower clear: +100 coins and +150 XP each. Estimate
  ≈ 2,050–2,200 coins earned per player over a default 10-wave game, on
  top of the starting coins.
- **Skills** (level n→n+1 costs n skill points, max 5): Ranged/Melee +25%
  damage per level; Health +2 hearts per level; Regeneration 0.25→1.2 HP/s
  for everyone; Armor tier leather→netherite (free, locked); Engineering +1
  turret, +3 mines, +10% turret durability per level, turret tier II at 2,
  III at 4.
- **Market Street** (behind the depot, away from the core): Engineer
  (Engineering; turrets, mines, traps & redstone, core repair), Mason (free
  dirt/cobble; blocks by the stack at `block_price` × breach HP), Provisioner
  (tools, food, light, storage, utility), Bowyer, Blacksmith, Healer,
  Alchemist (skill + gear by level), Armorer (Armor; Protection/Blast/
  Projectile I-IV, Thorns I-III, Feather Falling I-IV on the locked armour).
  Prices live in `shop.js`, `stats.js`, `mason.js`.
- **Turrets:** arrow (150), flak (200, flyers), frost (120). Base HP 40/40/30
  × tier (1, 1.5, 2) × Engineering. Talk to a turret: repair
  (`repair_rate` 0.5 coins/HP), upgrade (1×/1.5× the turret's price),
  pick up (owner, full HP). Limits: `turret_limit` 3 / `mine_limit` 10 per
  player plus Engineering.
- **Free depot:** cobblestone, dirt, torches, workshop, enchanting kit only.

## 7. Tools and everyday commands

All from `C:\defend-the-core` (Git Bash). `DTC_TARGET=beta` switches tools to
mc-defend; default is dev.

| Command | What |
| --- | --- |
| `npx tsc -p jsconfig.json` | Type-check the scripts. Run before every deploy. |
| `python tools/gen_entities.py` | Regenerate entity/item/lang JSON after editing the generator |
| `python tools/deploy.py` | Dev build (patch 1000+) → install on mc-testing, restart, wait for "script loaded" |
| `python tools/dm.py <action> '<json>'` | Send `dm:<action>` and print the `[DM]` replies |
| `python tools/dm.py raw <command>` | Any console command; prints the last console lines |
| `python tools/dm.py log [n]` / `console [n]` | Recent `[DM]` events / raw console |
| `python tools/node.py get servers/{sid}/stats` | Server CPU/memory; `crafty/stats` for the host |
| `python tools/stress.py arena` / `run [plan]` / `one T M [s]` | Stress tests (dev only) |
| `python tools/pregen.py x z r` | Pre-generate chunks around a point |
| `python tools/experiments.py --enable` | Turn on Beta APIs in a world's level.dat (restarts the server) |

**Release to beta (only when Wayne asks):**
1. Bump the version in all three manifests: `packs/BP/manifest.json` (4
   arrays), `packs/RP/manifest.json` (2), `packs/chat/manifest.json` (2).
   Keep the patch below 1000.
2. `git commit -m "Release X.Y.Z: …"`, `git tag -a vX.Y.Z -m "…"`, push with
   `--follow-tags`.
3. `DTC_TARGET=beta python tools/deploy.py --beta` (refuses a dirty tree or
   an untagged HEAD).
4. If the release changes world structures: `DTC_TARGET=beta python
   tools/dm.py depot '{"containers_only":true}'` and/or `market '{}'`.

**Testing without a player:**
- Far chunks aren't loaded with nobody online. Use a temporary ticking area
  (`raw tickingarea add circle <x> 0 <z> <r> dtc_test true`, then remove it;
  10 per world max; the core keeps `dtc_core`).
- Check structures with `raw testforblock x y z <block>` and entities with
  `raw testfor @e[type=dm:vendor]`.
- `dm.py probe '{"on":true,"every":20}'` streams attacker positions and HP;
  `perf '{"on":true,"every":100}'` streams tick timing.
- In-game behaviour (forms, combat, locked items) needs Wayne.

## 8. Gotchas we've already paid for

- Git Bash: heredocs containing `§`, backticks or nested quotes break or get
  mangled. Write patch scripts to a file (or use the Edit tool). Paths with a
  leading `/` get rewritten; `tools/node.py` accepts paths without it.
- `getDynamicProperty` fails during early execution; load state in
  `worldLoad`/start functions.
- Entity JSON: `pushable` takes no `value`; `float_duration`/`hover_height`
  need `{min,max}`; `attack_range` not `attack_radius`. 1.26-format client
  files render custom entities invisible: use the 1.8/1.10 templates. Blaze
  and ghast need `runtime_identifier`. `minecraft:fireball` isn't
  summonable (we use `dm:fireball`).
- Bedrock item/block ids differ from Java: `fence_gate`, `wooden_door`,
  `bed`, `brick_block`, `stone_stairs`, `end_bricks`, `nether_brick`,
  `stonecutter_block`, `web`; no `spectral_arrow`. Potions need the `give`
  command with a data value (no stable API).
- `forEach(fn)` passes the index as a second argument; `refreshArmor(p,
  rebuild)` was nearly called with `rebuild = index`.
- Infighting: `hurt_by_target` filters exclude `dm_attacker` and `dm_guard`.
  Flyers need `target_search_height` 80.
- Arrows from siege skeletons are removed after their first hit (they
  drilled down otherwise); turret arrows are removed when they hit a block.
- BDS only saves chunks changed since generation: pre-generation also
  "touches" each chunk.
- After installing a new world, the packs must be enabled (deploy PATCHes
  the addon flags).
- Restart detection compares the stats `started` time (old logs lie).
- A depot rebuild must reuse the stored floor y (a survey reads the roof as
  ground) and demolish before relocating.
- Tower sites skip the Market Street footprint (they were placed straight
  behind the depot, where the street now is).
- CRLF warnings on commit are harmless.

## 9. Performance limits (stress test, dev, 2026-10-04)

The bottleneck is BDS's single main thread (one of the two cores); memory
stayed ≈ 500–600 MB (≤ 46% of the host). 20 TPS is full speed.

| Load | TPS |
| --- | --- |
| ≤ 150 mobs, no turrets | 20 |
| 200 mobs | 16 |
| 300 / 400 mobs | 10.6 / 6.6 |
| 100 mobs vs 25–50 turrets | 19.3–20 |
| 100 mobs vs 100 / 150 / 200 turrets | 16 / 12.5 / 10.9 (1,300–1,800 stray arrows) |
| 200 mobs vs 25–100 turrets | 10–12.5 |

Safe ceiling ≈ 150 live attackers. Normal games (≈ 35 mobs, 10–30 turrets)
have about 4× headroom. The turret-arrow cleanup (b581900) is deployed on
dev but **not yet measured**; the earlier numbers are without it. Raw
results: `dist/stress_before.log`, `dist/stress.json` (not committed).

## 10. Current state

- **v0.7.3** (tag `v0.7.3`): turret/mine items place through a `dtc:placer`
  custom item component (the old `playerInteractWithBlock` listener never
  fired for plain items, so nothing could be placed); players level up as
  soon as XP is enough, not at round end.
- **Beta:** v0.7.2 until 0.7.3 is deployed (tag `v0.7.2`): world rules on load, turret arrow
  cleanup, per-player HUD (level, XP, skill points, skill levels), 1,000
  starting coins / 2 SP, max mobs alive cap (150), `dm:perf`, `dm:stress`.
- **Dev:** same as beta unless noted in later commits.
- **Fork:** `local/nelson-next` c0c1e3ff (team share of bounties). The
  running panel only has it after Wayne restarts the Crafty service.
- **Untested in-game:** every vendor menu (Engineer, Mason, Provisioner,
  skill vendors, Armorer upgrades), turret repair/upgrade/pick-up menu,
  locked armour (incl. the hotbar-swap shortcut), the damage/health/regen
  benefits, the returning-player wipe on beta, Market Street's look up close,
  enchantment names (density, impaling).

## 11. Backlog

Near term:
1. Re-run `python tools/stress.py run turrets` to measure the arrow cleanup.
2. Rewrite README.md from this document.
3. Show `perf` (TPS) on the DM tab next to CPU/memory.
4. Clean up the dev stress arena (or re-run `dm:setup` on a fresh dev world).

Ideas discussed, not built: skill-point respec, selling items back, team
coin pooling, more turret types, sweeping DM tools for structures.

Economy tuning knobs (DM tab Economy card): wave pay, bounty ×, team share,
starting coins, block price, repair rate, turret/mine limits, prices.
