// The Mason: building blocks. Dirt and cobblestone are free; anything
// nicer costs coins in proportion to how long attackers take to break it
// (the breach hardness, so a DM hardness override changes the price too).

import { ItemStack, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { hardnessSeconds } from "./breach.js";
import { addCoins, coinsOf, econ } from "./economy.js";
import { emit } from "./util.js";

export const FREE_BLOCKS = [
  ["Dirt", "minecraft:dirt"],
  ["Cobblestone", "minecraft:cobblestone"],
];
const FREE_COUNT = 64;
export const BATCH = 64; // blocks per purchase: a stack

// [label, item id]; the price is worked out from the block's hardness.
export const BLOCKS = {
  Stone: [
    ["Stone", "minecraft:stone"],
    ["Stone Bricks", "minecraft:stone_bricks"],
    ["Smooth Stone", "minecraft:smooth_stone"],
    ["Polished Andesite", "minecraft:polished_andesite"],
    ["Mossy Cobblestone", "minecraft:mossy_cobblestone"],
    ["Bricks", "minecraft:brick_block"],
    ["Sandstone", "minecraft:sandstone"],
    ["End Stone", "minecraft:end_stone"],
  ],
  Wood: [
    ["Oak Planks", "minecraft:oak_planks"],
    ["Spruce Planks", "minecraft:spruce_planks"],
    ["Oak Log", "minecraft:oak_log"],
    ["Oak Fence", "minecraft:oak_fence"],
    ["Fence Gate", "minecraft:fence_gate"],
    ["Wooden Door", "minecraft:wooden_door"],
    ["Trapdoor", "minecraft:trapdoor"],
    ["Ladder", "minecraft:ladder"],
    ["Scaffolding", "minecraft:scaffolding"],
  ],
  Shapes: [
    ["Stone Brick Slab", "minecraft:stone_brick_slab"],
    ["Stone Brick Stairs", "minecraft:stone_brick_stairs"],
    ["Cobblestone Wall", "minecraft:cobblestone_wall"],
    ["Stone Brick Wall", "minecraft:stone_brick_wall"],
    ["Oak Slab", "minecraft:oak_slab"],
    ["Oak Stairs", "minecraft:oak_stairs"],
  ],
  "Earth & Glass": [
    ["Sand", "minecraft:sand"],
    ["Gravel", "minecraft:gravel"],
    ["Glass", "minecraft:glass"],
    ["Glass Pane", "minecraft:glass_pane"],
    ["White Wool", "minecraft:white_wool"],
    ["Clay", "minecraft:clay"],
  ],
  Fortify: [
    ["Copper Block", "minecraft:copper_block"],
    ["Deepslate Bricks", "minecraft:deepslate_bricks"],
    ["Deepslate Tiles", "minecraft:deepslate_tiles"],
    ["Deepslate Brick Wall", "minecraft:deepslate_brick_wall"],
    ["Iron Bars", "minecraft:iron_bars"],
    ["Iron Door", "minecraft:iron_door"],
    ["Iron Block", "minecraft:iron_block"],
    ["Cobweb", "minecraft:web"],
    ["Obsidian", "minecraft:obsidian"],
  ],
};

// Blocks priced above their breach HP (obsidian also shrugs off every
// explosion, so it's worth more than its HP alone).
const PRICE_MULT = { "minecraft:obsidian": 2 };

/** Coins for a stack: block_price coins per second of breach HP (times any
 * PRICE_MULT). */
export function blockPrice(typeId, config = econ()) {
  return Math.max(1, Math.round(hardnessSeconds(typeId) * config.block_price * (PRICE_MULT[typeId] ?? 1)));
}

/** For the DM tab: every block with its HP and price. */
export function blockPrices(config = econ()) {
  return Object.values(BLOCKS).flat().map(([label, id]) => ({ label, hp: hardnessSeconds(id), price: blockPrice(id, config) }));
}

function give(player, typeId, amount) {
  const left = player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(typeId, amount));
  if (left) player.dimension.spawnItem(left, player.location);
}

function show(player, form, retry, then) {
  form.show(player).then((response) => {
    // A form opened mid-interaction comes back "UserBusy": try once more.
    if (response.canceled && String(response.cancelationReason) === "UserBusy" && retry) {
      system.runTimeout(retry, 10);
      return;
    }
    if (!response.canceled && response.selection !== undefined) then(response.selection);
  });
}

function openCategory(player, name) {
  const config = econ();
  const coins = coinsOf(player);
  const blocks = BLOCKS[name];
  const form = new ActionFormData().title(`§l${name}`).body(`§6${coins} coins§r · sold by the stack (${BATCH})\nTougher blocks cost more.`);
  form.button("« Back");
  for (const [label, id] of blocks) {
    const price = blockPrice(id, config);
    form.button(`${label} x${BATCH}\n${coins >= price ? "§2" : "§4"}${price} coins`);
  }
  show(player, form, undefined, (i) => {
    if (i === 0) return system.runTimeout(() => openMason(player), 2);
    const [label, id] = blocks[i - 1];
    const price = blockPrice(id, config);
    if (coinsOf(player) < price) {
      player.sendMessage(`§cYou need ${price - coinsOf(player)} more coins for ${label}.`);
    } else {
      give(player, id, BATCH);
      const balance = addCoins(player, -price, `bought ${label}`);
      emit("purchase", { name: player.name, item: `${label} x${BATCH}`, price, balance });
      player.sendMessage(`§aBought ${BATCH} ${label}§r for ${price} coins. §6${balance} coins§r left.`);
    }
    system.runTimeout(() => openCategory(player, name), 2);
  });
}

export function openMason(player, retried = false) {
  if (!econ().shop_open) return player.sendMessage("§cThe Mason is closed right now.");
  const form = new ActionFormData()
    .title("§lMason")
    .body(`§6${coinsOf(player)} coins§r\nDirt and cobblestone are free. Anything tougher costs more the longer it holds attackers off.`);
  for (const [label] of FREE_BLOCKS) form.button(`${label} x${FREE_COUNT}\n§2free`);
  const names = Object.keys(BLOCKS);
  for (const name of names) form.button(`${name}\n§8${BLOCKS[name].length} blocks`);
  show(player, form, retried ? undefined : () => openMason(player, true), (i) => {
    if (i < FREE_BLOCKS.length) {
      give(player, FREE_BLOCKS[i][1], FREE_COUNT);
      system.runTimeout(() => openMason(player), 2);
    } else {
      system.runTimeout(() => openCategory(player, names[i - FREE_BLOCKS.length]), 2);
    }
  });
}
