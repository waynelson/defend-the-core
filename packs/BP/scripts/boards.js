// The mall's public leaderboards: top killers (final blows, including by a
// player's turrets and mines) and top earners (coins earned this game, never
// anyone's balance). Kept per game in a world property and shown on
// floating labels (dm:label entities tagged dtc:label = board_kills /
// board_earned) that the mall places.

import { system } from "@minecraft/server";
import { gameNo } from "./game.js";
import { emit, overworld, store, stored } from "./util.js";

const PROP = "dtc:boards";
const ROWS = 8;
const REFRESH_TICKS = 100;
const SAVE_TICKS = 200;

let data;
let dirty = false;

function current() {
  if (!data) data = stored(PROP, {});
  if (data.game !== gameNo()) {
    data = { game: gameNo(), kills: {}, earned: {} };
    dirty = true;
  }
  return data;
}

/** A final blow (by the player or their turret or mine). */
export function recordKill(name) {
  if (!name) return;
  const d = current();
  d.kills[name] = (d.kills[name] ?? 0) + 1;
  dirty = true;
}

/** Coins earned (wave pay, bounties, tower bonuses, loot sold...). */
export function recordEarned(name, amount) {
  if (!name || !(amount > 0)) return;
  const d = current();
  d.earned[name] = (d.earned[name] ?? 0) + Math.round(amount);
  dirty = true;
}

function table(title, subtitle, scores, unit) {
  const rows = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, ROWS)
    .map(([name, n], i) => `${i === 0 ? "§6" : "§f"}${i + 1}. ${name}  §e${n.toLocaleString()}${unit}`);
  return [title, subtitle, ...(rows.length ? rows : ["§7nobody yet"])].join("\n");
}

export function boardTexts() {
  const d = current();
  return {
    board_kills: table("§c§lTOP KILLERS", "§7final blows this game", d.kills, ""),
    board_earned: table("§e§lTOP EARNERS", "§7coins earned this game", d.earned, ""),
  };
}

function refresh() {
  const texts = boardTexts();
  for (const label of overworld().getEntities({ type: "dm:label" })) {
    const key = label.getDynamicProperty("dtc:label");
    if (typeof key === "string" && texts[key] !== undefined && label.nameTag !== texts[key]) label.nameTag = texts[key];
  }
}

export function boardsStatus() {
  const d = current();
  return { game: d.game, kills: d.kills, earned: d.earned };
}

export function startBoards() {
  system.runInterval(() => {
    try {
      refresh();
    } catch (e) {
      emit("error", { where: "boards", error: String(e) });
    }
  }, REFRESH_TICKS);
  system.runInterval(() => {
    if (!dirty) return;
    dirty = false;
    store(PROP, current());
  }, SAVE_TICKS);
}
