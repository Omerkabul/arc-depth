"use strict";
/* ===========================================================================
 * zincir.js — Arc chain constants and a minimal JSON-RPC client
 *
 * WHY RAW JSON-RPC AND NOT ethers
 *   During development, ethers' JsonRpcProvider kept retrying network
 *   detection forever ("failed to detect network ... retry in 1s") whenever an
 *   endpoint was dead, and it masked real RPC errors behind a generic
 *   "could not coalesce error". Arc's RPC returns two *different* errors that
 *   matter — `-32012 requested range too large` (permanent: never retry) and
 *   rate limiting (transient: back off and retry) — and ethers hid both.
 *
 *   A raw client is ~40 lines, surfaces the real error text, has one hard
 *   timeout and no hidden retry loop. For a tool whose whole job is honest
 *   measurement, seeing the actual failure is worth more than convenience.
 *
 * NO SECRETS IN THIS FILE. The RPC URL is a public endpoint and can be
 * overridden with the ARC_RPC environment variable.
 * =========================================================================== */
const https = require("https");
const http = require("http");

/* Arc mainnet. USDC is BOTH the gas token and the quote asset, which is why
 * every size in this tool is denominated in USDC and no volatile gas balance
 * is needed. */
const ARC = {
  chainId: 5042,
  rpc: process.env.ARC_RPC || "https://rpc.mainnet.arc.io",
  /* USDC precompile: 6 decimals as an ERC-20, 18 as the native unit. */
  usdc: "0x3600000000000000000000000000000000000000",
  usdcDecimals: 6,
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  /* Uniswap v4 quoter. quoteExactInputSingle reverts with the result encoded
   * in the revert payload, which is why the quoting code below reads revert
   * data rather than a return value. */
  /* Verified on-chain, not written from memory. */
  quoter: process.env.ARC_V4_QUOTER || "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  /* quoteExactInputSingle selector. */
  quoterSelector: "0xaa9d21cb",
  /* Nominal block time, for reporting only. Block lookups DO NOT use it:
   * measured drift reached fourteen hours, so timestamps are resolved by
   * binary search over real blocks instead. */
  blockTimeSec: 0.5074
};

/* Uniswap v4 PoolManager.Initialize — the ONLY way to recover a PoolKey from
 * a pool id. The id is keccak(PoolKey) and is not reversible, so the key has
 * to be read from the event that created the pool.
 *   Initialize(bytes32 id, address currency0, address currency1,
 *              uint24 fee, int24 tickSpacing, address hooks,
 *              uint160 sqrtPriceX96, int24 tick)
 * id, currency0 and currency1 are indexed; the rest sit in `data`. */
/* keccak of the signature above. Computed and checked against a live Arc
 * log rather than copied from memory — an address or topic written from
 * recall is an assertion, and a wrong one fails silently by matching
 * nothing. */
const INITIALIZE_TOPIC =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

/* fee == 2^23 is v4's dynamic-fee flag: the hook decides the fee at swap
 * time, so no fixed percentage can be quoted for such a pool. */
const DYNAMIC_FEE_FLAG = 8388608;

function rpc(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(ARC.rpc); } catch (e) { return reject(new Error("invalid ARC_RPC")); }
    const mod = u.protocol === "http:" ? http : https;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] });
    const req = mod.request({
      hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: "POST",
      timeout: timeoutMs || 15000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        if (res.statusCode !== 200) {
          /* A rate limit is its own class of failure. It says nothing about the
           * request — the identical call succeeds once the window reopens — so
           * it must not be reported the way a malformed request is, and it
           * needs a far longer wait than a dropped connection. The server's own
           * Retry-After is honoured when it sends one, because guessing against
           * a published number is how a client earns a longer ban. */
          const limited = res.statusCode === 429 || res.statusCode === 503;
          const ra = Number(res.headers["retry-after"]);
          return reject(Object.assign(new Error("HTTP " + res.statusCode), {
            httpStatus: res.statusCode,
            rateLimited: limited,
            transient: limited,
            retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : null
          }));
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { return reject(new Error("response was not JSON")); }
        if (parsed.error) {
          const err = new Error(String(parsed.error.message || parsed.error));
          err.rpcCode = parsed.error.code;
          /* -32012 is permanent for the given range: retrying the same call
           * will fail identically. Callers must narrow the range instead. */
          err.permanent = (parsed.error.code === -32012) || /range too large/i.test(err.message);
          return reject(err);
        }
        resolve(parsed.result);
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("rpc timeout"), { transient: true })));
    req.on("error", (e) => reject(Object.assign(e, { transient: true })));
    req.write(body);
    req.end();
  });
}

/* Retry only what is worth retrying, and wait for the right reason.
 *
 * Three outcomes, three behaviours:
 *   permanent (-32012, range too large) — returned at once, because the same
 *     call will fail identically and the caller has to narrow the range;
 *   rate limited (429/503) — the longest wait, growing exponentially, and more
 *     attempts than anything else gets, because the request is fine and only
 *     time fixes it. A short linear backoff here just spends the retries
 *     inside the same closed window and then reports a failure that was never
 *     a failure;
 *   anything else transient (timeout, reset socket) — a short linear backoff.
 *
 * The retry budget is deliberately split: a rate limit gets more attempts than the
 * general budget allows, up to RATE_TRIES, because collapsing it into the general
 * budget is what made a throttled public endpoint look like broken code. */
const RATE_TRIES = 6;
async function rpcRetry(method, params, attempts) {
  const max = attempts || 3;
  let last = null, rateHits = 0;
  for (let i = 0; i < max; ) {
    try { return await rpc(method, params); }
    catch (e) {
      last = e;
      if (e.permanent) throw e;

      if (e.rateLimited) {
        rateHits++;
        if (rateHits > RATE_TRIES) throw e;
        /* 1.5s, 3s, 6s, 12s, 24s, 30s — capped, and overridden by the
         * server's Retry-After whenever it gives one. A rate-limited attempt
         * does not consume the general budget, so a throttled window cannot
         * exhaust the retries meant for network faults. */
        const bekle = e.retryAfterMs || Math.min(1500 * Math.pow(2, rateHits - 1), 30000);
        await new Promise((r) => setTimeout(r, bekle));
        continue;
      }

      i++;
      if (i >= max) throw e;
      await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw last;
}

const blockNumber = async () => parseInt(await rpcRetry("eth_blockNumber", []), 16);

async function blockAt(tag) {
  const b = await rpcRetry("eth_getBlockByNumber", [typeof tag === "number" ? "0x" + tag.toString(16) : tag, false]);
  return b ? { number: parseInt(b.number, 16), hash: b.hash, timestamp: parseInt(b.timestamp, 16) } : null;
}

/* Resolve the block at a wall-clock time by BINARY SEARCH over real block
 * timestamps.
 *
 * The first version computed it arithmetically from a hardcoded genesis
 * timestamp and a fixed 0.5074 s block time. Checked against live blocks it
 * was off by 48,184 blocks at the chain head and 101,173 blocks at block 1M —
 * six to fourteen HOURS. Arc block times have not been uniform, so any
 * constant-rate formula drifts, and the drift is not monotonic either.
 *
 * That error would have been fatal and silent. This function exists to centre
 * a narrow eth_getLogs window, because Arc rejects wide ranges with -32012.
 * A window centred six hours away finds nothing, and an empty result looks
 * identical to "this pool has no Initialize event".
 *
 * Binary search costs about log2(head), roughly 25 calls, assumes nothing
 * about block time, and is exact to a single block. Results are cached since
 * pool creation times repeat across requests. */
const _blockCache = new Map();
async function blockForTime(unixMs) {
  const targetSec = Math.round(unixMs / 1000);
  if (_blockCache.has(targetSec)) return _blockCache.get(targetSec);
  let lo = 1, hi = await blockNumber();
  const head = await blockAt(hi);
  if (head && head.timestamp <= targetSec) { _blockCache.set(targetSec, hi); return hi; }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await blockAt(mid);
    if (!b) break;
    if (b.timestamp < targetSec) lo = mid + 1; else hi = mid;
  }
  if (_blockCache.size > 5000) _blockCache.clear();
  _blockCache.set(targetSec, lo);
  return lo;
}

const hexToBigInt = (h) => (!h || h === "0x" ? 0n : BigInt(h));
const toUsdc = (raw) => Number(raw) / Math.pow(10, ARC.usdcDecimals);
const fromUsdc = (amount) => BigInt(Math.round(amount * Math.pow(10, ARC.usdcDecimals)));

module.exports = {
  ARC, INITIALIZE_TOPIC, DYNAMIC_FEE_FLAG,
  rpc, rpcRetry, blockNumber, blockAt, blockForTime,
  hexToBigInt, toUsdc, fromUsdc
};
