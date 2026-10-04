# Defend the Core (Bedrock add-on)

Read `docs/PROJECT.md` before changing anything: it is the project control
document (architecture, environments, workflows, gotchas, current state,
backlog). README.md is out of date.

Hard rules:
- mc-testing (dev) is free to wipe and deploy to: `python tools/deploy.py`.
- mc-defend (beta) has real testers: deploy, restart or change it **only when
  Wayne asks**, and only a tagged release (`DTC_TARGET=beta python
  tools/deploy.py --beta`).
- Wayne restarts the Crafty Windows service himself; tell him when a hub
  change needs it.
- Entity/item JSON is generated: edit `tools/gen_entities.py` and run it.
- New or changed add-on actions/fields must be mirrored in the Crafty fork's
  `app/classes/dm/protocol.py` (with a test), or the DM tab rejects them.
- Type-check before deploying: `npx tsc -p jsconfig.json`.
- Say what was tested from the console and what still needs a player.
