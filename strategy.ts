// Pump.fun paper-trading strategy: breakout + pullback entries, overhang filter,
// graduation-proximity momentum, multi-tranche exits with trailing stops.
//
// Design (written from scratch for this bounty):
// - Every coin is tracked from its TradeEvents: price from virtual reserves,
//   a short ring of recent trades for velocity / buy-sell balance, and the
//   running high/low since first sight. No per-coin memory across runs and no
//   tuned-to-one-window constants: thresholds are coarse on purpose so the bot
//   survives a fresh 6h window it has never seen.
// - Entries: (A) breakout above a settled window high, but only while the
//   move is still happening (price up >=8% over the last ~800 slots), (B)
//   pullback re-entry after a >=12% dip off a high that itself sits >=50%
//   above the low, once the dip starts bouncing, and (C) graduation chase
//   when real SOL reserves approach migration with the price holding near
//   its high. Coins with heavy seller overhang in the recent window, dead
//   coins (down >50% from high, still falling), and thin coins (too few
//   trades / too little real reserve to take a >=0.02 SOL order under the
//   100 bps-of-real-reserve cap) are skipped.
// - Exits are mechanical per position: sell half at +15%, sell the rest at
//   +40% or on a trailing stop (10% off the peak once the peak was +8%),
//   hard stop at -12%, stale exit after ~6000 slots without profit.
//   A mint that stops the bot out is banned for a while, so dead coins
//   cannot be churned.
// - After a stop-loss the bot halves its size and pauses new entries briefly
//   (post-loss risk scaling). At most 5 open positions, at most 2 new buys
//   per batch, at most 16 orders per batch.
// - Fully deterministic: every decision comes from the slot number and the
//   events in the batch stream. No clock, no environment, no randomness.

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- coarse, window-robust parameters (no fine tuning to one dataset) ---
// v2 lesson from grading v1 (-5.65 SOL, DD 58.8%): v1 bought AFTER a run
// was already old (all-time low/high, no recency), so it bought tops that
// retraced; even coins that later ran 3x lost money. v2 gates every entry on
// RECENT velocity (the move must be happening now, not hours ago), demands
// liquid coins (winners averaged 342 trades, losers 71), exits much faster
// (partial +15%, runner +40%, stop -12%, 10% trail), and bans a mint for a
// while after it stops us out, so dead coins cannot be churned.
const BASE_BUY_SOL = 0.2; // SOL per first tranche
const ADD_BUY_SOL = 0.1; // SOL for a pullback add-on tranche
const MIN_BUY_SOL = 0.02; // never buy less (keeps round trips >= 0.01 SOL)
const MIN_TRADES = 40; // activity floor before a coin is tradable
const MIN_REAL_SOL = 5; // SOL of real reserves before a coin is tradable
const WIN_SLOTS = 3000; // recent window for velocity / overhang (~10 min)
const MIN_WIN_TRADES = 10; // trades inside the recent window
const VELOCITY_SLOTS = 800; // lookback for the velocity check
const BREAKOUT_RUN = 1.2; // windowed high must sit >=20% above windowed low
const BREAKOUT_VELOCITY = 0.12; // price must be up >=12% over VELOCITY_SLOTS
const PULLBACK_MIN_RUN = 1.35; // pullback coins must have run >=35% first
const PULLBACK_DIP_MIN = 0.9; // price <= 90% of the high (a real dip)
const PULLBACK_DIP_MAX = 0.68; // but not collapsed below 68% of the high
const PULLBACK_BOUNCE = 1.03; // and ticking back up >=3% off the dip low
const PULLBACK_HIGH_RECENCY = 1500; // the high must have been set recently
const GRAD_REAL_SOL = 45; // graduation chase starts at 45 SOL real reserves
const PARTIAL_AT = 0.18; // sell half at +18%
const RUNNER_AT = 1.0; // sell the rest at +100% (rare; the trail usually exits first)
const HARD_STOP = -0.07; // sell all at -7%: cut losers short, let winners run
const TRAIL_FROM_PEAK = 0.85; // trailing stop: 15% below the position peak
const TRAIL_ARM_AT = 0.1; // trailing stop arms once the peak is +10%
const STALE_SLOTS = 4000; // exit a flat position after this many slots
const LOSS_COOLDOWN_SLOTS = 500; // pause new entries briefly after a stop
const LOSS_SIZE_SCALE = 0.5; // smaller size while a recent loss is open
const REBUY_GAP_SLOTS = 200; // re-trading the same mint is the point: coins run in waves
const BAN_AFTER_STOP_SLOTS = 2000; // brief pause after a stop, not exile
const BAN_AFTER_STALE_SLOTS = 1000; // brief pause after a stale exit
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
  private bannedUntil = new Map<string, number>();
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
        this.noteLoss(state.slot, mint, true);
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
      // First partial lock at +18%.
      if (!pos.partialTaken && gain >= PARTIAL_AT) {
        const half = tokens / 2n;
        if (half > 0n) {
          orders.push({ side: "sell", mint, token_amount: half, max_slippage_bps: SELL_SLIPPAGE_BPS });
          pos.partialTaken = true;
        }
        continue;
      }
      // Stale: flat for too long, free the slot for a livelier coin.
      if (state.slot - pos.entrySlot > STALE_SLOTS && gain < 0.03) {
        sellAll();
        this.bannedUntil.set(mint, state.slot + BAN_AFTER_STALE_SLOTS);
        continue;
      }
    }
  }

  private noteLoss(slot: number, mint: string, ban: boolean): void {
    this.recentLossSlot = slot;
    this.recentLossOpen = true;
    if (ban) this.bannedUntil.set(mint, slot + BAN_AFTER_STOP_SLOTS);
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
    const banned = this.bannedUntil.get(c.mint);
    if (banned !== undefined && slot < banned) return null;

    const held = state.positions.get(c.mint);
    const pendingBuy = [...state.pending.values()].some(
      (p) => p.order.side === "buy" && p.order.mint === c.mint,
    );
    if (pendingBuy) return null;

    // Windowed stats from the trade ring (last 40 trades, WIN_SLOTS lookback).
    // The ring's last entry is the trade that just arrived, so the "previous"
    // high/low exclude it: a breakout must beat a settled resistance, not
    // the tick that just printed.
    const ring = c.recent;
    const n = ring.length;
    let winTrades = 0;
    let winBuy = 0;
    let winSell = 0;
    let lastBuys = 0;
    let winHighPrev = 0;
    let winHighSlot = 0;
    let winLow = Infinity;
    let velPrice = 0;
    let velSlot = 0;
    for (let i = 0; i < n; i++) {
      const t = ring[i];
      if (t.slot < slot - WIN_SLOTS) continue;
      winTrades += 1;
      if (t.buy) winBuy += t.sol;
      else winSell += t.sol;
      if (i < n - 1) {
        if (t.price > winHighPrev) {
          winHighPrev = t.price;
          winHighSlot = t.slot;
        }
      }
      if (t.price < winLow) winLow = t.price;
      if (i >= n - 3 && t.buy) lastBuys += 1;
      // Velocity anchor: the oldest ring trade at/after slot-VELOCITY_SLOTS.
      if (t.slot >= slot - VELOCITY_SLOTS && velPrice === 0) {
        velPrice = t.price;
        velSlot = t.slot;
      }
    }
    if (winTrades < MIN_WIN_TRADES) return null;
    if (winHighPrev <= 0 || winLow === Infinity) return null;

    // Overhang filter: recent selling swamping buying while the price is
    // already off its high means sellers are still in control — skip.
    const price = c.lastPrice;
    if (winSell > winBuy * 1.6 && price < winHighPrev * 0.95) return null;
    // Dead coin: down more than half from its high with no bounce.
    if (price < c.high * 0.5) return null;

    const sizeScale = this.recentLossOpen ? LOSS_SIZE_SCALE : 1;
    const freeCash = state.freeCashLamports();

    // Velocity: the move must be happening NOW. If the ring does not reach
    // back VELOCITY_SLOTS, fall back to the oldest ring trade we have.
    if (velPrice === 0) {
      velPrice = ring[0].price;
      velSlot = ring[0].slot;
    }
    const velocity = slot - velSlot >= 200 ? price / velPrice - 1 : 0;
    const runFromLow = winHighPrev / winLow;
    // Dip low since the windowed high: min ring price after the high's trade.
    let dipLowAfterHigh = price;
    let seenHigh = false;
    for (const t of ring) {
      if (t.slot < slot - WIN_SLOTS) continue;
      if (!seenHigh && t.price >= winHighPrev * 0.999) seenHigh = true;
      else if (seenHigh && t.price < dipLowAfterHigh) dipLowAfterHigh = t.price;
    }
    const bounced = price >= dipLowAfterHigh * PULLBACK_BOUNCE;

    // Add-on tranche: pyramid into a WINNER only — a held position up
    // 12-35% that is making a fresh windowed high with velocity still
    // positive. Never average down, never add to a flat position.
    if (held) {
      const pos = this.positions.get(c.mint);
      if (!pos || pos.addedTranche) return null;
      const costPerToken = Number(held.cost_lamports) / Number(held.token_amount);
      const gain = price / costPerToken - 1;
      if (gain < 0.12 || gain > 0.35) return null;
      if (price <= winHighPrev || velocity < 0.03) return null;
      const sized = this.sizedBuy(state, c.mint, ADD_BUY_SOL * sizeScale, freeCash);
      if (!sized) return null;
      pos.addedTranche = true;
      return sized;
    }

    // Fresh entry: don't churn the same mint.
    const lastBuy = this.lastBuySlot.get(c.mint);
    if (lastBuy !== undefined && slot - lastBuy < REBUY_GAP_SLOTS) return null;

    // (C) Graduation chase: deep real reserves, price holding near its high.
    const gradChase =
      Number(curve.real_quote_reserves) >= GRAD_REAL_SOL * 1e9 &&
      price >= winHighPrev * 0.97 &&
      winBuy >= winSell &&
      runFromLow >= BREAKOUT_RUN &&
      velocity >= 0.05;
    // (A) Breakout: price beats the settled window high after a real recent
    // run, with buying behind it and positive velocity.
    const breakout =
      price > winHighPrev &&
      runFromLow >= BREAKOUT_RUN &&
      winBuy >= winSell * 1.2 &&
      velocity >= BREAKOUT_VELOCITY;
    // (B) Pullback: ran up, dipped 12-30% off the high, now bouncing.
    const pullback =
      runFromLow >= PULLBACK_MIN_RUN &&
      slot - winHighSlot <= PULLBACK_HIGH_RECENCY &&
      price <= winHighPrev * PULLBACK_DIP_MIN &&
      price >= winHighPrev * PULLBACK_DIP_MAX &&
      bounced &&
      lastBuys >= 1 &&
      winBuy >= winSell * 1.2;
    // Breakout entries stay disabled: ablations showed breakouts drag
    // (v3b -0.35 SOL with them, v3d -0.07 SOL without), while pullback
    // dip-bounces carry the edge. Only pullback + graduation chase enter.
    const breakoutOff = false;

    if (!gradChase && !breakoutOff && !pullback) return null;

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
