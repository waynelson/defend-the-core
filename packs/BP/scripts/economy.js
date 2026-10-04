// Coins: a `coins` scoreboard (kept per player by the game, shown in the
// sidebar). Everyone online earns a share when a wave is cleared. Every kill
// pays a bounty: the full bounty to whoever lands the killing blow (or owns
// the turret or mine that did), and bounty_share of it to everyone else.

import { DisplaySlotId, world } from "@minecraft/server";
import { emit, store, stored } from "./util.js";

const OBJECTIVE = "coins";
const ECON_PROP = "dtc:economy";
const DEFAULTS = {
  wave_base: 50, // per player per cleared wave...
  wave_step: 10, // ...plus this times the wave number
  bounty_mult: 1, // scales BOUNTY
  bounty_share: 0.5, // everyone else online gets this much of each bounty
  shop_open: true,
  turret_limit: 3, // turrets per player
  mine_limit: 10, // mines per player
  start_coins: 200, // every player's coins at the start of a game
  block_price: 4, // Mason: coins per second of block HP, per stack of 64
  repair_rate: 0.5, // coins per turret HP repaired
  prices: {}, // shop item id -> price, overrides shop.js
};
export const BOUNTY = {
  "dm:zombie": 2, "dm:skeleton": 3, "dm:swarmer": 1, "dm:digger": 4, "dm:sapper": 5,
  "dm:siege_skeleton": 4, "dm:ghast": 12, "dm:blaze": 6, "dm:phantom": 4,
  "dm:guard_zombie": 4, "dm:guard_archer": 4, "dm:guard_captain": 20,
};
const RANGES = {
  wave_base: [0, 10000], wave_step: [0, 1000], bounty_mult: [0, 20], turret_limit: [0, 20], mine_limit: [0, 100],
  start_coins: [0, 100000], block_price: [0, 100], bounty_share: [0, 1], repair_rate: [0, 20],
};

export function econ() {
  const saved = stored(ECON_PROP, {});
  return { ...DEFAULTS, ...saved, prices: { ...(saved.prices ?? {}) } };
}

export function setEconomy(changes) {
  const config = econ();
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (changes[key] === undefined) continue;
    const value = changes[key];
    if (typeof value !== "number" || value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
    config[key] = value;
  }
  if (changes.shop_open !== undefined) config.shop_open = Boolean(changes.shop_open);
  for (const [id, price] of Object.entries(changes.prices ?? {})) {
    if (price === null) delete config.prices[id];
    else if (!Number.isInteger(price) || price < 0 || price > 100000) throw new Error(`price of ${id} must be 0..100000`);
    else config.prices[id] = price;
  }
  store(ECON_PROP, config);
  emit("economy", config);
  return config;
}

function objective() {
  return world.scoreboard.getObjective(OBJECTIVE) ?? world.scoreboard.addObjective(OBJECTIVE, "§6Coins");
}

export function coinsOf(player) {
  try {
    return objective().getScore(player) ?? 0;
  } catch {
    return 0; // no score yet
  }
}

export function setCoins(player, amount) {
  objective().setScore(player, Math.max(0, Math.round(amount)));
}

/** Adds (or with a negative delta, takes) coins; never below zero.
 * `quiet` skips the DM feed line (team bounty shares would flood it). */
export function addCoins(player, delta, reason, quiet = false) {
  const before = coinsOf(player);
  const change = Math.max(-before, Math.round(delta));
  objective().addScore(player, change);
  const balance = before + change;
  if (!quiet) emit("coins", { name: player.name, delta: change, reason, balance });
  return balance;
}

export function payWave(waveNo) {
  const config = econ();
  const amount = Math.round(config.wave_base + config.wave_step * waveNo);
  const players = world.getAllPlayers();
  for (const player of players) {
    addCoins(player, amount, `wave ${waveNo}`);
    player.sendMessage(`§6+${amount} coins§r for clearing wave ${waveNo}`);
  }
  emit("wave_payout", { wave_no: waveNo, each: amount, players: players.length });
}

const shareOwed = new Map(); // player name -> fractional coins from shares

/** Bounty for a death: the full bounty to whoever earned it (if online),
 * a share to everyone else online (fractions carry over to later kills). */
export function payBounty(mobType, playerName) {
  const base = BOUNTY[mobType];
  if (!base) return;
  const config = econ();
  const full = base * config.bounty_mult;
  const mob = mobType.replace("dm:", "");
  for (const player of world.getAllPlayers()) {
    if (player.name === playerName) {
      if (full > 0) addCoins(player, full, `bounty ${mob}`);
      continue;
    }
    const owed = (shareOwed.get(player.name) ?? 0) + full * config.bounty_share;
    const whole = Math.floor(owed);
    shareOwed.set(player.name, owed - whole);
    if (whole > 0) addCoins(player, whole, `team bounty ${mob}`, true);
  }
}

/** DM grants: {player?: name, delta} or {all: true, delta}. */
export function grantCoins(msg) {
  if (typeof msg.delta !== "number" || !Number.isFinite(msg.delta) || Math.abs(msg.delta) > 100000) {
    throw new Error("delta must be a number within ±100000");
  }
  const players = msg.all ? world.getAllPlayers() : world.getAllPlayers().filter((p) => p.name === msg.player);
  if (!players.length) throw new Error(msg.all ? "nobody is online" : `${msg.player} is not online`);
  const balances = {};
  for (const player of players) {
    balances[player.name] = addCoins(player, msg.delta, "dm");
    player.sendMessage(`${msg.delta >= 0 ? "§6+" : "§c"}${msg.delta} coins§r from the DM`);
  }
  return { balances };
}

export function startEconomy() {
  world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, { objective: objective() });
}
