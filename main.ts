// Pump.fun Paper Sprint entry: one strategy program on Node 22 speaking
// agent-fun/replay/v2. The hello message carries the capital, caps and fees;
// each batch message carries the slot, the events, the marks and the fills;
// the reply to each batch carries the orders decided on that slot. All
// trading logic lives in strategy.ts; this file only wires the SDK shim to it.
//
// Determinism contract: the harness runs this program twice and the two
// action logs must match byte for byte, so nothing here (or in strategy.ts)
// reads the clock, the environment, or unseeded randomness — every decision
// is a pure function of the hello and the batch stream.

import { runBot } from "./vendor/makefun-bot.ts";
import { PumpStrategy } from "./strategy.ts";

const strategy = new PumpStrategy();

await runBot({
  onBatch(state, batch) {
    return strategy.decide(state, batch);
  },
});
