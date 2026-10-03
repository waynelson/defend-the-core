// Defend the Core chat bridge: relays player chat to the DM as `[DM]` lines.
//
// Chat events are beta-only, so this lives in its own pack pinned to the
// beta Script API of one BDS release; when a BDS update breaks it, only chat
// relay stops. The world needs the "Beta APIs" experiment.

import { system, world } from "@minecraft/server";

function emit(type, data) {
  console.log(`[DM] ${JSON.stringify({ t: type, tick: system.currentTick, ...data })}`);
}

world.afterEvents.chatSend.subscribe((event) => {
  emit("chat", {
    name: event.sender.name,
    message: event.message.slice(0, 500),
    to: event.targets?.map((p) => p.name),
  });
});

world.afterEvents.worldLoad.subscribe(() => emit("chat_bridge", { ok: true }));
