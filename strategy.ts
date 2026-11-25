// Pump.fun paper-trading strategy: breakout + pullback entries, overhang filter,
// graduation-proximity momentum, multi-tranche exits with trailing stops.
//
// Design (written from scratch for this bounty):
// - Every coin is tracked from its TradeEvents: price from virtual reserves,
//   a short ring of recent trades for velocity / buy-sell balance, and the
//   running high/low since first sight. No per-coin memory across runs and no
//   tuned-to-one-window constants: thresholds are coarse on purpose so the bot
//   survives a fresh 6h window it has never seen.
// - Entries: (A) breakout to a new high after a >=25% run from the low with
//   real buying behind it, (B) pullback re-entry after a >=12% dip off a high
//   that itself sits >=50% above the low, once the dip starts bouncing, and
//   (C) graduation chase when real SOL reserves approach migration with the
//   price holding near its high. Coins with heavy seller overhang in the
//   recent window, dead coins (down >50% from high, still falling), and thin
//   coins (too few trades / too little real reserve to take a >=0.02 SOL
//   order under the 100 bps-of-real-reserve cap) are skipped.
// - Exits are mechanical per position: sell half at +30%, sell the rest at
//   +80% or on a trailing stop (18% off the peak once the peak was +15%),
//   hard stop at -25%, stale exit after ~12000 slots without profit.
// - After a stop-loss the bot halves its size and pauses new entries briefly
//   (post-loss risk scaling). At most 5 open positions, at most 2 new buys
//   per batch, at most 16 orders per batch.
// - Fully deterministic: every decision comes from the slot number and the
//   events in the batch stream. No clock, no environment, no randomness.

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- coarse, window-robust parameters (no fine tuning to one dataset) ---
const BASE_BUY_SOL = 0.30; // SOL per first tranche
const ADD_BUY_SOL = 0.15; // SOL for a pullback add-on tranche
const MIN_BUY_SOL = 0.02; // never buy less (keeps round trips >= 0.01 SOL)
const MIN_TRADES = 10; // activity floor before a coin is tradable
const MIN_REAL_SOL = 2; // SOL of real reserves before a coin is tradable
const WIN_SLOTS = 3000; // recent window for velocity / overhang (~10 min)
const MIN_WIN_TRADES = 5; // trades inside the recent window
const BREAKOUT_RUN = 1.25; // high must sit >=25% above the low
const BREAKOUT_VS_FIRST = 1.15; // and >=15% above the first-seen price
const PULLBACK_MIN_RUN = 1.5; // pullback coins must have run >=50% first
const PULLBACK_DIP_MIN = 0.88; // price <= 88% of the high (a real dip)
const PULLBACK_DIP_MAX = 0.7; // but not collapsed below 70% of the high
const PULLBACK_BOUNCE = 1.03; // and ticking back up >=3% off the dip low
const GRAD_REAL_SOL = 45; // graduation chase starts at 45 SOL real reserves
const PARTIAL_AT = 0.3; // sell half at +30%
const RUNNER_AT = 0.8; // sell the rest at +80%
const HARD_STOP = -0.25; // sell all at -25%
const TRAIL_FROM_PEAK = 0.82; // trailing stop: 18% below the position peak
const TRAIL_ARM_AT = 0.15; // trailing stop arms once the peak is +15%
const STALE_SLOTS = 12000; // exit a flat position after this many slots
const LOSS_COOLDOWN_SLOTS = 200; // pause new entries briefly after a stop
const LOSS_SIZE_SCALE = 0.6; // smaller size while a recent loss is open
const REBUY_GAP_SLOTS = 500; // don't re-buy the same mint too soon
const MAX_NEW_BUYS_PER_BATCH = 2;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 500;

interface RecentTrade {
  slot: number;
  price: number;
  buy: boolean;
  sol: number; // lamports as a float number (totals stay far below 2^53)
}

interface Coin {
  mint: string;
  firstSlot: number;
  firstPrice: number;
  low: number;
  high: number;
  lastPrice: number;
  prevPrice: number;
  trades: number;
  lastTradeSlot: number;
  dipLow: number; // lowest price since the running high was set
  recent: RecentTrade[];
}

interface Pos {
  mint: string;
  entrySlot: number;
  peak: number;
  partialTaken: boolean;
  addedTranche: boolean;
}

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const q = Number(curve.virtual_quote_reserves);
  const t = Number(curve.virtual_token_reserves);
  if (t <= 0 || q <= 0) return 0;
  return q / t;
}

export class PumpStrategy {
  private coins = new Map<string, Coin>();
  private positions = new Map<string, Pos>();
  private lastBuySlot = new Map<string, number>();
  private recentLossSlot = -1_000_000;
  private recentLossOpen = false;
  private lastPruneSlot = 0;

  decide(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];

    // 1) Fold this batch's events into per-coin state.
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        if (!this.coins.has(e.mint)) {
          const p = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          this.coins.set(e.mint, {
            mint: e.mint,
            firstSlot: slot,
            firstPrice: p,
            low: p,
            high: p,
            lastPrice: p,
            prevPrice: p,
            trades: 0,
            lastTradeSlot: slot,
            dipLow: p,
            recent: [],
          });
        }
      } else if (e.event === "TradeEvent") {
        let c = this.coins.get(e.mint);
        const p = Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves);
        if (!c) {
          c = {
            mint: e.mint,
            firstSlot: slot,
            firstPrice: p,
            low: p,
            high: p,
            lastPrice: p,
            prevPrice: p,
            trades: 0,
            lastTradeSlot: slot,
            dipLow: p,
            recent: [],
          };
          this.coins.set(e.mint, c);
        }
        c.prevPrice = c.lastPrice;
        c.lastPrice = p;
        if (p > c.high) {
          c.high = p;
          c.dipLow = p;
        } else if (p < c.dipLow) {
          c.dipLow = p;
        }
        if (p < c.low) c.low = p;
        c.trades += 1;
        c.lastTradeSlot = slot;
        c.recent.push({ slot, price: p, buy: e.is_buy, sol: Number(e.sol_amount) });
        if (c.recent.length > 40) c.recent.splice(0, c.recent.length - 40);
        touched.add(e.mint);
      }
      // CompleteEvent: nothing to track here; state.curves marks it complete
      // and maxBuyLamports() returns 0 for it, so it can never be bought.
    }

    // 2) Manage exits for every held position (uses live curve prices).
    this.manageExits(state, orders);

    // 3) Entries: only coins that actually traded in this batch.
    if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
      let newBuys = 0;
      for (const mint of touched) {
        if (newBuys >= MAX_NEW_BUYS_PER_BATCH) break;
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
        const c = this.coins.get(mint);
        if (!c) continue;
        const buy = this.entryFor(state, c, slot);
        if (buy) {
          orders.push(buy);
          newBuys += 1;
        }
      }
    }

    // 4) Occasional prune of dead coins so the map stays small.
    if (slot - this.lastPruneSlot > 20000) {
      this.lastPruneSlot = slot;
      for (const [mint, c] of this.coins) {
        if (!state.positions.has(mint) && slot - c.lastTradeSlot > 60000) {
          this.coins.delete(mint);
        }
      }
    }
    return orders;
  }

  // --- exits ---------------------------------------------------------------
  private manageExits(state: BotState, orders: OrderInput[]): void {
    // Sync position bookkeeping with the harness account.
    for (const mint of [...this.positions.keys()]) {
      if (!state.positions.has(mint)) this.positions.delete(mint);
    }
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const coin = this.coins.get(mint);
      const price = curve ? priceOf(curve) : coin ? coin.lastPrice : 0;
      if (price <= 0) continue;
      const costPerToken = Number(holding.cost_lamports) / Number(holding.token_amount);
      if (costPerToken <= 0) continue;
      let pos = this.positions.get(mint);
      if (!pos) {
        pos = { mint, entrySlot: state.slot, peak: price, partialTaken: false, addedTranche: false };
        this.positions.set(mint, pos);
      }
      if (price > pos.peak) pos.peak = price;
      const gain = price / costPerToken - 1;
      const peakGain = pos.peak / costPerToken - 1;
      const pendingSell = [...state.pending.values()].some(
        (p) => p.order.side === "sell" && p.order.mint === mint,
      );
      if (pendingSell) continue;

      const tokens = holding.token_amount;
      const sellAll = (): void => {
        orders.push({ side: "sell", mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      };
      // Hard stop first: never let a loser run.
      if (gain <= HARD_STOP) {
        sellAll();
        this.noteLoss(state.slot);
        continue;
      }
      // Runner target.
      if (gain >= RUNNER_AT) {
        sellAll();
        this.noteWin();
        continue;
      }
      // Trailing stop once the peak was meaningfully profitable.
      if (peakGain >= TRAIL_ARM_AT && price <= pos.peak * TRAIL_FROM_PEAK) {
        sellAll();
        if (gain > 0) this.noteWin();
        continue;
      }
      // First partial lock at +30%.
      if (!pos.partialTaken && gain >= PARTIAL_AT) {
        const half = tokens / 2n;
        if (half > 0n) {
          orders.push({ side: "sell", mint, token_amount: half, max_slippage_bps: SELL_SLIPPAGE_BPS });
          pos.partialTaken = true;
        }
        continue;
      }
      // Stale: flat for too long, free the slot for a livelier coin.
      if (state.slot - pos.entrySlot > STALE_SLOTS && gain < 0.05) {
        sellAll();
        continue;
      }
    }
  }

  private noteLoss(slot: number): void {
    this.recentLossSlot = slot;
    this.recentLossOpen = true;
  }

  private noteWin(): void {
    this.recentLossOpen = false;
  }

  // --- entries --------------------------------------------------------------
  private entryFor(state: BotState, c: Coin, slot: number): OrderInput | null {
    const curve = state.curves.get(c.mint);
    if (!curve || curve.complete) return null;
    if (c.trades < MIN_TRADES) return null;
    if (Number(curve.real_quote_reserves) < MIN_REAL_SOL * 1e9) return null;
    if (slot - c.lastTradeSlot > 0) return null; // only act on a fresh trade
    if (slot - this.recentLossSlot < LOSS_COOLDOWN_SLOTS) return null;

    const held = state.positions.get(c.mint);
    const pendingBuy = [...state.pending.values()].some(
      (p) => p.order.side === "buy" && p.order.mint === c.mint,
    );
    if (pendingBuy) return null;

    // Recent-window stats from the trade ring.
    let winTrades = 0;
    let winBuy = 0;
    let winSell = 0;
    let lastBuys = 0;
    let lastN = 0;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i];
      if (t.slot < slot - WIN_SLOTS) break;
      winTrades += 1;
      if (t.buy) winBuy += t.sol;
      else winSell += t.sol;
      if (lastN < 3) {
        lastN += 1;
        if (t.buy) lastBuys += 1;
      }
    }
    if (winTrades < MIN_WIN_TRADES) return null;

    // Overhang filter: recent selling swamping buying while the price is
    // already off its high means sellers are still in control — skip.
    const price = c.lastPrice;
    if (winSell > winBuy * 1.6 && price < c.high * 0.95) return null;
    // Dead coin: down more than half from its high with no bounce.
    if (price < c.high * 0.5) return null;

    const sizeScale = this.recentLossOpen ? LOSS_SIZE_SCALE : 1;
    const freeCash = state.freeCashLamports();

    // Add-on tranche on a held position: pullback add while still near cost.
    if (held) {
      const pos = this.positions.get(c.mint);
      if (!pos || pos.addedTranche) return null;
      const costPerToken = Number(held.cost_lamports) / Number(held.token_amount);
      const gain = price / costPerToken - 1;
      if (gain > 0.1 || gain < -0.1) return null;
      if (price > c.high * 0.9 || price < c.dipLow * 1.02) return null;
      const sized = this.sizedBuy(state, c.mint, ADD_BUY_SOL * sizeScale, freeCash);
      if (!sized) return null;
      pos.addedTranche = true;
      return sized;
    }

    // Fresh entry: don't churn the same mint.
    const lastBuy = this.lastBuySlot.get(c.mint);
    if (lastBuy !== undefined && slot - lastBuy < REBUY_GAP_SLOTS) return null;

    const runFromLow = c.high / c.low;
    const vsFirst = price / c.firstPrice;
    const bounced = price >= c.dipLow * PULLBACK_BOUNCE;

    // (C) Graduation chase: deep real reserves, price holding near its high.
    const gradChase =
      Number(curve.real_quote_reserves) >= GRAD_REAL_SOL * 1e9 &&
      price >= c.high * 0.97 &&
      winBuy >= winSell &&
      runFromLow >= BREAKOUT_RUN;
    // (A) Breakout: new high after a real run, with buying behind it.
    const breakout =
      price >= c.high * 0.999 &&
      runFromLow >= BREAKOUT_RUN &&
      vsFirst >= BREAKOUT_VS_FIRST &&
      winBuy >= winSell * 0.8;
    // (B) Pullback: ran up, dipped 12-30% off the high, now bouncing.
    const pullback =
      runFromLow >= PULLBACK_MIN_RUN &&
      price <= c.high * PULLBACK_DIP_MIN &&
      price >= c.high * PULLBACK_DIP_MAX &&
      bounced &&
      lastBuys >= 1;

    if (!gradChase && !breakout && !pullback) return null;

    const want = (gradChase ? BASE_BUY_SOL * 1.25 : BASE_BUY_SOL) * sizeScale;
    const sized = this.sizedBuy(state, c.mint, want, freeCash);
    if (!sized) return null;
    this.lastBuySlot.set(c.mint, slot);
    return sized;
  }

  private sizedBuy(state: BotState, mint: string, wantSol: number, freeCash: bigint): OrderInput | null {
    const cap = state.maxBuyLamports(mint);
    let want = BigInt(Math.floor(wantSol * 1e9));
    if (want > cap) want = cap;
    const cashCap = freeCash / 2n; // never spend more than half the free cash on one buy
    if (want > cashCap) want = cashCap;
    if (want < BigInt(Math.floor(MIN_BUY_SOL * 1e9))) return null;
    return { side: "buy", mint, quote_lamports: want, max_slippage_bps: BUY_SLIPPAGE_BPS };
  }
}
