# Defend the Core

A Minecraft Bedrock tower-defense game mode run by a Dungeon Master. Players
defend a core from waves of mobs and bosses that path to it and break through
whatever is in the way. They earn coins and skill points, train six skills,
buy gear and blocks on Market Street, sell loot to the Pawnbroker, and place
turrets and mines. The DM runs the game from a DM tab in a
[Crafty Controller](https://craftycontrol.com/) panel (a separate Crafty fork),
or lets the built-in auto DM run it.

This repo is the Bedrock side: a behavior pack (entities, items and Script
API code), a resource pack, and a small chat-bridge pack.

**Status: beta (v0.7.5).** Developers: start with
[docs/PROJECT.md](docs/PROJECT.md), the project control document
(architecture, workflows, current state, backlog).

## The game

- **Waves:** siege zombies, swarmers, diggers, sappers, archers, ghasts,
  blazes and phantoms, plus five **bosses** (Warlord, Bone Colossus,
  Necromancer, Demolisher, Dread Ghast). Mobs that get stuck dig, blast or
  shoot through walls. Late waves run to hundreds of mobs, streamed in so the
  server stays smooth.
- **Players** start each game with 1,000 coins, 2 skill points and a level-1
  kit. Kills (a full bounty for the final blow, half for everyone else),
  cleared waves and cleared towers pay coins and XP; levels bring skill
  points. Each player sees their own coins, level and skills on screen.
- **Skills:** Ranged, Melee, Health, Regeneration, Armor (free armour locked
  to you) and Engineering (more and tougher turrets).
- **Market Street:** Engineer, Mason, Provisioner, Bowyer, Blacksmith,
  Healer, Alchemist, Armorer, and the Pawnbroker on the plaza.
- **Defenses:** arrow, flak and frost turrets (repair and upgrade them by
  talking to them) and blast and frost mines.
- **Towers:** dungeons near the spawn with guards and loot.
- **Supply depot:** free dirt, cobblestone, torches, workstations and an
  enchanting kit.

## Building

```
npm install
npx tsc -p jsconfig.json        # type-check
python tools/gen_entities.py    # regenerate entity JSON after editing it
python tools/build.py           # dist/defend_the_core.mcaddon
```

Deploying goes through Crafty's addon API (`tools/deploy.py`); see
docs/PROJECT.md.
