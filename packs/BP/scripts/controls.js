// Player self-admin: buttons and levers in the mall's upper-floor control
// rooms (placed by market.js, which registers each block's action here).
// Anyone can use them unless the DM switches them off (breach config
// player_controls). Every use is announced and sent to the DM feed.
//
// Reset map is a two-press action: it asks the panel (the [DM] line
// `request` kind new_world) to generate a fresh world and set it up.

import { system, world } from "@minecraft/server";
import { autoConfig, setAuto } from "./auto.js";
import { getConfig } from "./breach.js";
import { respawnVendors, restockDepot, depotBuilder } from "./depot.js";
import { control, gameStatus, setPhase } from "./game.js";
import { buildMarket, marketBounds } from "./market.js";
import { startRain } from "./rewards.js";
import { raiseTower } from "./tower.js";
import { emit, overworld, store, stored } from "./util.js";

const PROP = "dtc:controls"; // {"x,y,z": action}
const DIFFICULTY_PROP = "dtc:difficulty";
const COOLDOWN_TICKS = 60;
const LONG_COOLDOWN_TICKS = 20 * 120; // supply drops, towers, mall repairs
const RESET_CONFIRM_TICKS = 20 * 10;
const LONG = new Set(["supply_drop", "raise_tower", "fix_mall"]);

/** Auto-DM presets the difficulty levers select. */
export const DIFFICULTIES = {
  easy: { label: "Easy", start: 1, step: 0.5, max: 6, waves: 8 },
  normal: { label: "Normal", start: 2, step: 0.7, max: 10, waves: 10 },
  hard: { label: "Hard", start: 3, step: 0.9, max: 10, waves: 12 },
  brutal: { label: "Brutal", start: 5, step: 1, max: 10, waves: 15 },
};

const lastUsed = new Map(); // action -> tick
let resetArmed; // {by, until}

const key = (l) => `${l.x},${l.y},${l.z}`;

/** market.js: the control blocks it placed, {"x,y,z": action}. */
export function registerControls(map) {
  store(PROP, map);
}

export function selectedDifficulty() {
  const d = stored(DIFFICULTY_PROP, "normal");
  return DIFFICULTIES[d] ? d : "normal";
}

function say(text) {
  world.sendMessage(text);
}

/** Levers show the selected difficulty: that one on, the rest off. */
export function syncLevers() {
  const map = stored(PROP, {});
  const selected = selectedDifficulty();
  const dim = overworld();
  for (const [spot, action] of Object.entries(map)) {
    if (!action.startsWith("difficulty_")) continue;
    const [x, y, z] = spot.split(",").map(Number);
    try {
      const block = dim.getBlock({ x, y, z });
      if (block?.typeId === "minecraft:lever") {
        block.setPermutation(block.permutation.withState("open_bit", action === `difficulty_${selected}`));
      }
    } catch {
      // not loaded
    }
  }
}

function playersInMall() {
  const box = marketBounds(1);
  if (!box) return [];
  return world.getAllPlayers().filter((p) => {
    const { x, z } = p.location;
    return x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2;
  });
}

const ACTIONS = {
  auto_toggle(player) {
    if (autoConfig().on) {
      setAuto({ on: false });
      say(`§e${player.name} stopped the auto DM.`);
    } else {
      setAuto({ on: true });
      say(`§a${player.name} started the auto DM§r (${DIFFICULTIES[selectedDifficulty()].label}).`);
    }
  },
  pause_toggle(player) {
    const paused = gameStatus().paused;
    control(paused ? "resume" : "pause");
    say(`§e${player.name} ${paused ? "resumed" : "paused"} the game.`);
  },
  next_wave(player) {
    const s = gameStatus();
    if ((s.phase !== "prep" && s.phase !== "intermission") || !(s.seconds_left > 1)) {
      return player.sendMessage("§cThat only works while a prep or intermission timer is running.");
    }
    setPhase(s.phase, 1);
    say(`§c${player.name} called the next wave in early!`);
  },
  supply_drop(player) {
    startRain({ count: 16, quality: 2, duration_s: 6 });
    say(`§a${player.name} called in a supply drop.`);
  },
  fix_mall(player) {
    // Out of the way first: the rebuild clears the site.
    const b = depotBuilder();
    const out = b.at(0, 1, 9);
    for (const p of playersInMall()) p.teleport({ x: out.x + 0.5, y: out.y, z: out.z + 0.5 });
    buildMarket();
    say(`§e${player.name} is rebuilding the mall (everyone inside was moved to the depot).`);
  },
  restock(player) {
    restockDepot();
    say(`§a${player.name} restocked the supply depot.`);
  },
  respawn_vendors(player) {
    respawnVendors();
    say(`§a${player.name} called the vendors back to their shops.`);
  },
  raise_tower(player) {
    raiseTower({});
    say(`§5${player.name} raised a new tower near the spawn.`);
  },
  daytime(player) {
    overworld().runCommand("time set day");
    overworld().runCommand("weather clear");
    say(`§e${player.name} brought out the sun.`);
  },
  reset_map(player) {
    const now = system.currentTick;
    if (!resetArmed || now > resetArmed.until) {
      resetArmed = { by: player.name, until: now + RESET_CONFIRM_TICKS };
      say(`§c§l${player.name} pressed RESET MAP.§r §cPress it again within 10 seconds to wipe the world and start over.`);
      return false; // not used yet: no cooldown
    }
    resetArmed = undefined;
    say(`§4§lRESETTING THE MAP.§r §cA new world is being made; the server restarts in about a minute.`);
    emit("request", { kind: "new_world", by: player.name });
    return true;
  },
};

function use(player, action) {
  if (getConfig().player_controls === false) {
    player.sendMessage("§cThe DM has switched the player controls off.");
    return;
  }
  const now = system.currentTick;
  const wait = LONG.has(action) ? LONG_COOLDOWN_TICKS : COOLDOWN_TICKS;
  const last = lastUsed.get(action) ?? -wait;
  if (now - last < wait) {
    player.sendMessage(`§eThat was just used; try again in ${Math.ceil((wait - (now - last)) / 20)} s.`);
    return;
  }
  try {
    if (ACTIONS[action](player) === false) return;
    lastUsed.set(action, now);
    emit("control_used", { name: player.name, control: action });
  } catch (e) {
    player.sendMessage(`§c${String(e).replace(/^Error: /, "")}`);
  }
}

function difficulty(player, level, on) {
  const selected = selectedDifficulty();
  if (!on) {
    // One is always selected: switching the selected one off puts it back.
    if (level === selected) system.run(syncLevers);
    return;
  }
  if (getConfig().player_controls === false) {
    player.sendMessage("§cThe DM has switched the player controls off.");
    system.run(syncLevers);
    return;
  }
  const { label, ...preset } = DIFFICULTIES[level];
  setAuto(preset);
  store(DIFFICULTY_PROP, level);
  system.run(syncLevers);
  say(`§e${player.name} set the auto DM to §l${label}§r§e (${preset.waves} waves, difficulty ${preset.start} rising ${preset.step} a wave).`);
  emit("control_used", { name: player.name, control: `difficulty_${level}` });
}

export function startControls() {
  world.afterEvents.buttonPush.subscribe((event) => {
    const action = stored(PROP, {})[key(event.block.location)];
    const player = event.source;
    if (!action || player?.typeId !== "minecraft:player" || !ACTIONS[action]) return;
    use(/** @type {import("@minecraft/server").Player} */ (player), action);
  });
  world.afterEvents.leverAction.subscribe((event) => {
    const action = stored(PROP, {})[key(event.block.location)];
    if (!action?.startsWith("difficulty_") || !event.player) return;
    difficulty(event.player, action.slice("difficulty_".length), event.isPowered);
  });
}
