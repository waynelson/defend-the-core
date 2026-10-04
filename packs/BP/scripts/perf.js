// Performance sampler for the DM and stress tests: real tick lengths
// (the server aims for 20 ticks a second, 50 ms each) and what's alive.
// Off by default; `dm:perf {on: true, every: 100}` emits a perf line every
// `every` ticks.

import { system } from "@minecraft/server";
import { coreLocation } from "./core.js";
import { dmPlace } from "./defenses.js";
import { attackers } from "./spawner.js";
import { emit, overworld } from "./util.js";

let run;
let last = 0;
let gaps = [];

function sample(every) {
  const now = Date.now();
  if (last) gaps.push(now - last);
  last = now;
  if (gaps.length < every) return;
  const total = gaps.reduce((a, b) => a + b, 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const dim = overworld();
  const count = (families) => dim.getEntities({ families }).length;
  emit("perf", {
    tps: Math.round((1000 * gaps.length * 10) / total) / 10,
    tick_ms: Math.round((total / gaps.length) * 10) / 10,
    p95_ms: sorted[Math.floor(sorted.length * 0.95)],
    max_ms: sorted[sorted.length - 1],
    attackers: attackers().length,
    turrets: count(["dm_turret"]),
    entities: dim.getEntities().length,
    projectiles: dim.getEntities({ type: "minecraft:arrow" }).length + dim.getEntities({ type: "minecraft:snowball" }).length,
  });
  gaps = [];
}

/** {on, every?: ticks between reports (20..1200, default 100)} */
export function setPerf(msg) {
  if (run !== undefined) system.clearRun(run);
  run = undefined;
  last = 0;
  gaps = [];
  if (!msg.on) return { on: false };
  const every = Math.min(Math.max(Math.round(msg.every ?? 100), 20), 1200);
  run = system.runInterval(() => sample(every), 1);
  return { on: true, every };
}

/**
 * Stress-test helper (dev worlds): {clear: true} removes every attacker,
 * turret and stray projectile; {turrets: n, type?, tier?, r1?: 8, gap?: 3}
 * places n turrets in rings around the core on the surface (rings r1,
 * r1 + gap, ...; a turret every ~3 blocks along each ring).
 */
export function stress(msg) {
  const dim = overworld();
  if (msg.clear) {
    let removed = 0;
    for (const e of [
      ...attackers(),
      ...dim.getEntities({ families: ["dm_turret"] }),
      ...dim.getEntities({ type: "minecraft:arrow" }),
      ...dim.getEntities({ type: "minecraft:snowball" }),
    ]) {
      try {
        e.remove();
        removed++;
      } catch {
        // gone already
      }
    }
    return { removed };
  }
  const core = coreLocation();
  if (!core) throw new Error("no core set");
  const want = Math.min(Math.max(Math.round(msg.turrets ?? 0), 0), 400);
  const gap = msg.gap ?? 3;
  let placed = 0;
  for (let r = msg.r1 ?? 8; placed < want && r < 64; r += gap) {
    const slots = Math.max(6, Math.floor((2 * Math.PI * r) / 3));
    for (let i = 0; i < slots && placed < want; i++) {
      const a = (2 * Math.PI * i) / slots + r; // stagger the rings
      const x = Math.round(core.x + Math.cos(a) * r);
      const z = Math.round(core.z + Math.sin(a) * r);
      const top = dim.getTopmostBlock({ x, z });
      if (!top) continue;
      dmPlace({ type: msg.type ?? "arrow", tier: msg.tier ?? 1, x, y: top.location.y + 1, z });
      placed++;
    }
  }
  return { placed };
}
