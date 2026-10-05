"use strict";
/* ===========================================================================
 * havuz.js — find a token's Arc pools, recover each PoolKey, quote a round trip
 *
 * THE PROBLEM THIS SOLVES
 *   On Arc a single token routinely has dozens of Uniswap v4 pools. Measured
 *   on the live chain: the token AI had 47 of them. Going through the right
 *   one costs 7.84% for a 5 USDC round trip; going through the worst costs
 *   99.23%. Nothing published on Arc tells a buyer which pool to use.
 *
 *   Existing Arc scanners cannot answer it either, and say so themselves.
 *   Smithii's Arc page: "token scanners rely on third-party providers that
 *   simulate buys and sells to catch honeypots, and those providers do not
 *   cover Arc yet." Their suggested workaround is to buy a small amount and
 *   try to sell it. This module does exactly that — as a quote, so it costs
 *   nothing and risks nothing.
 *
 * HOW
 *   1) List the token's pools from GeckoTerminal (public, keyless).
 *   2) Recover each PoolKey. A v4 pool id is keccak(PoolKey) and is not
 *      reversible, so the key has to be read from the PoolManager.Initialize
 *      event that created the pool. The pool creation time from step 1 is
 *      converted to a block by binary search, then a narrow eth_getLogs
 *      window around it is filtered by the pool id topic — one precise hit
 *      instead of scanning the chain.
 *   3) Quote BOTH legs at the SAME pinned block: USDC -> token, then exactly
 *      that token amount -> USDC. The second leg must use the first leg's
 *      output; feeding it an arbitrary amount ignores the first leg's price
 *      impact and understates the true cost.
 *   4) Re-read the block hash afterwards. If it changed, the two legs may not
 *      have come from the same state and the result is reported as unverified
 *      rather than quietly trusted.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 *   - A failed RPC call is NOT a honeypot. Those are reported as UNMEASURED.
 *     Treating a network error as a verdict stamps healthy pools as traps;
 *     that mistake was made once during development and cost a real pool its
 *     reputation in the logs.
 *   - Dynamic-fee pools (fee == 2^23) have their fee decided by the hook at
 *     swap time. No fixed percentage applies and they are flagged, not priced.
 *   - Uniswap v3 pools on Arc exist and are NOT covered here. The v4 quoter
 *     cannot price them.
 * =========================================================================== */
const https = require("https");
const fs = require("fs");
const Z = require("./zincir.js");

const GT = "https://api.geckoterminal.com/api/v2";

function getJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs || 20000, headers: { accept: "application/json" } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        if (res.statusCode !== 200) {
          const e = new Error("HTTP " + res.statusCode);
          e.httpStatus = res.statusCode;
          /* 429 means slow down, not "no data". Treating it as absence of
           * data is how a working service silently reports nothing. */
          e.transient = res.statusCode === 429 || res.statusCode >= 500;
          return reject(e);
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error("response was not JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { transient: true })));
    req.on("error", (e) => reject(Object.assign(e, { transient: true })));
  });
}

let _lastGt = 0;
const GT_SPACING_MS = Number(process.env.GT_SPACING_MS || 2500);
async function gt(path, attempt) {
  const a = attempt || 0;
  const wait = GT_SPACING_MS - (Date.now() - _lastGt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastGt = Date.now();
  try { return await getJSON(GT + path); }
  catch (e) {
    if (!e.transient || a >= 3) throw e;
    await new Promise((r) => setTimeout(r, 3000 * Math.pow(2, a)));
    return gt(path, a + 1);
  }
}

/* ---- 0) a token's pools, locally ----------------------------------------
 *
 * Reads the token -> pools index built by arastirma/ters-indeks-derle.js:
 * 52-byte records sorted by token then pool id. Binary search to the first
 * record for the token, then walk forward while the token still matches.
 * No parsing, no network, nothing resident.
 *
 * This list has no liquidity in it — the index does not know any — so it is
 * a fallback, not a replacement for the remote listing. It is, however,
 * WIDER: the remote provider only lists pools that trade, while this knows
 * every pool that was ever initialised, including the untraded ones a
 * honeypot check has most reason to look at. */
const TOKEN_INDEX = process.env.ARC_TOKEN_INDEX || "";
const TREC = 52;
let _tix = null;

function tokenIndexHandle() {
  if (_tix !== null) return _tix;
  _tix = false;
  if (!TOKEN_INDEX) return _tix;
  try {
    const st = fs.statSync(TOKEN_INDEX);
    if (st.size > 0 && st.size % TREC === 0) {
      _tix = { fd: fs.openSync(TOKEN_INDEX, "r"), count: st.size / TREC };
    }
  } catch (e) { _tix = false; }
  return _tix;
}

function localPoolsOfToken(token, limit) {
  const ix = tokenIndexHandle();
  if (!ix) return null;
  const want = Buffer.from(String(token).replace(/^0x/, "").toLowerCase(), "hex");
  if (want.length !== 20) return null;

  const rec = Buffer.alloc(TREC);
  /* Lower bound: the first record whose token is >= the one we want. */
  let lo = 0, hi = ix.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    fs.readSync(ix.fd, rec, 0, TREC, mid * TREC);
    if (Buffer.compare(rec.subarray(0, 20), want) < 0) lo = mid + 1; else hi = mid;
  }

  const out = [];
  const cap = limit || 64;
  for (let i = lo; i < ix.count && out.length < cap; i++) {
    fs.readSync(ix.fd, rec, 0, TREC, i * TREC);
    if (Buffer.compare(rec.subarray(0, 20), want) !== 0) break;
    out.push({
      poolId: "0x" + rec.subarray(20, 52).toString("hex"),
      name: null,
      labelFeePct: null,
      liquidityUsd: NaN,      /* genuinely unknown, not zero */
      fdvUsd: NaN,
      createdAt: null,
      dex: null
    });
  }
  return out.length ? out : null;
}

/* ---- 1) a token's pools ------------------------------------------------- */
/* The listing is cached for a short window. See the note at the top of this
 * change: the upstream rate limit, not the chain, was setting the p90. */
const POOLS_TTL_MS = Number(process.env.POOLS_TTL_MS || 90000);
const REMOTE_BUDGET_MS = Number(process.env.REMOTE_LIST_BUDGET_MS || 3000);
const POOLS_MAX = Number(process.env.POOLS_CACHE_MAX || 500);
const _poolCache = new Map();   /* token -> { at, pools } */
const _inflight = new Map();    /* token -> Promise, so N callers make 1 call */

function _remember(k, pools) {
  _poolCache.set(k, { at: Date.now(), pools });
  if (_poolCache.size > POOLS_MAX) {
    /* Oldest first; Map preserves insertion order and entries are re-set on
     * refresh, so the front of the iterator is the least recently written. */
    const drop = _poolCache.size - POOLS_MAX;
    let i = 0;
    for (const key of _poolCache.keys()) { if (i++ >= drop) break; _poolCache.delete(key); }
  }
}

/* Returns { pools, ageMs, stale }. ageMs is 0 for a fresh upstream read.
 * stale is true only when the upstream failed and a previous list was used,
 * which the caller is expected to surface rather than hide. */
async function poolsOfTokenMeta(token) {
  const k = String(token).toLowerCase();
  const hit = _poolCache.get(k);
  if (hit && Date.now() - hit.at < POOLS_TTL_MS) {
    return { pools: hit.pools, ageMs: Date.now() - hit.at, stale: false, source: "remoteCache" };
  }
  if (_inflight.has(k)) return _inflight.get(k);

  const job = _fetchPools(k).then(
    (pools) => { _remember(k, pools); _inflight.delete(k); return { pools, ageMs: 0, stale: false, source: "remote" }; },
    (err) => {
      _inflight.delete(k);
      /* A rate limit is not an answer. If a previous list exists, serving it
       * with its age attached is more useful and more honest than failing. */
      const old = _poolCache.get(k);
      if (old) {
        return {
          pools: old.pools, ageMs: Date.now() - old.at, stale: true,
          source: "remoteCache", error: String(err.message)
        };
      }
      /* No previous list either. The local index can still say which pools
       * exist, just not how deep they are. */
      const yerel = localPoolsOfToken(k);
      if (yerel) {
        return { pools: yerel, ageMs: 0, stale: false, source: "localIndex", error: String(err.message) };
      }
      throw err;
    }
  );
  _inflight.set(k, job);

  /* Stop waiting after the budget, but let the call finish: it still writes
   * the cache, so the next caller gets the richer remote list for free. */
  /* The background call may still reject after we have answered from the
   * local index. Nothing is waiting on it by then, so swallow it here
   * rather than let it surface as an unhandled rejection. */
  job.catch(function () {});

  const yerelVar = !!localPoolsOfToken(k, 1);
  if (!yerelVar) return job;

  let zamanlayici;
  const butce = new Promise((resolve) => {
    zamanlayici = setTimeout(() => {
      const yerel = localPoolsOfToken(k);
      resolve(yerel
        ? { pools: yerel, ageMs: 0, stale: false, source: "localIndex",
            error: "remote listing exceeded " + REMOTE_BUDGET_MS + " ms" }
        : null);
    }, REMOTE_BUDGET_MS);
    if (zamanlayici.unref) zamanlayici.unref();
  });

  const kazanan = await Promise.race([job.then((r) => { clearTimeout(zamanlayici); return r; }), butce]);
  return kazanan || job;
}

async function poolsOfToken(token) {
  return (await poolsOfTokenMeta(token)).pools;
}

async function _fetchPools(token) {
  const d = await gt("/networks/arc/tokens/" + token + "/pools");
  const list = (d && d.data) || [];
  return list.map((x) => {
    const a = x.attributes || {};
    /* The pool name carries the fee tier, e.g. "AI / USDC 1%". It is a label,
     * not a source of truth — the authoritative fee comes from the Initialize
     * event in step 2. */
    const feeFromName = /([0-9.]+)%\s*$/.exec(String(a.name || ""));
    return {
      poolId: String(a.address || "").toLowerCase(),
      name: a.name || null,
      labelFeePct: feeFromName ? Number(feeFromName[1]) : null,
      liquidityUsd: Number(a.reserve_in_usd),
      fdvUsd: Number(a.fdv_usd),
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
      dex: (x.relationships && x.relationships.dex && x.relationships.dex.data && x.relationships.dex.data.id) || null
    };
  }).filter((p) => p.poolId);
}

/* ---- 2) PoolKey from the Initialize event -------------------------------- */
const WINDOW_BLOCKS = Number(process.env.INIT_WINDOW_BLOCKS || 4000);

/* A PoolKey is immutable: the Initialize event fires once and its fields can
 * never change for that pool id. So it is cached permanently, on disk, which
 * turned a 33 second response into a sub-second one on repeat queries.
 *
 * Only derived public data is stored (pool id, currencies, fee, tickSpacing,
 * hooks). The cache file is disposable: deleting it costs speed, never
 * correctness. */
const path = require("path");
const CACHE_FILE = process.env.POOLKEY_CACHE ||
  path.join(__dirname, "..", "data", "poolkeys.json");
let _keys = null;
function loadKeys() {
  if (_keys) return _keys;
  try { _keys = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch (e) { _keys = {}; }
  return _keys;
}
let _dirty = false, _flushTimer = null;
function rememberKey(poolId, key) {
  const m = loadKeys();
  m[poolId] = key;
  _dirty = true;
  if (!_flushTimer) {
    /* Batched so a burst of lookups is one write, not hundreds. */
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      if (!_dirty) return;
      _dirty = false;
      try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        const tmp = CACHE_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(_keys));
        fs.renameSync(tmp, CACHE_FILE);
      } catch (e) { /* cache is an optimisation; failing to write is not fatal */ }
    }, 2000);
    if (_flushTimer.unref) _flushTimer.unref();
  }
}

/* ---- a local seekable index, if one was built ---------------------------
 *
 * Recovering a key by log scan was measured at 45 s for a token nobody had
 * queried before, and that is the whole of the remaining cold-start cost.
 * The Initialize events only ever need reading once, so if this machine has
 * already read them, a lookup should not pay for them again.
 *
 * The file is sorted fixed-width records, so this is a binary search over
 * the file itself: ~18 reads of 100 bytes, nothing parsed, nothing cached in
 * memory. A 21 MB index therefore costs no resident memory at all, which
 * matters for a service that otherwise runs in 21 MB.
 *
 * The index is NOT trusted on its word. Every key it returns is hashed and
 * compared against the pool id before use — a wrong key would yield a
 * confident wrong quote, which is worse than a slow correct one. The check
 * is a local keccak and costs nothing.
 *
 * Optional by design: with ARC_POOL_INDEX unset, everything below behaves
 * exactly as before. The index is an accelerator, never a dependency. */
const INDEX_FILE = process.env.ARC_POOL_INDEX || "";
const REC = 100;
let _ix = null;   /* { fd, count } | false */

function indexHandle() {
  if (_ix !== null) return _ix;
  _ix = false;
  if (!INDEX_FILE) return _ix;
  try {
    const st = fs.statSync(INDEX_FILE);
    if (st.size > 0 && st.size % REC === 0) {
      _ix = { fd: fs.openSync(INDEX_FILE, "r"), count: st.size / REC };
    }
  } catch (e) { _ix = false; }
  return _ix;
}

function localIndexLookup(poolId) {
  const ix = indexHandle();
  if (!ix) return null;
  const want = Buffer.from(String(poolId).replace(/^0x/, ""), "hex");
  if (want.length !== 32) return null;

  const rec = Buffer.alloc(REC);
  let lo = 0, hi = ix.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    fs.readSync(ix.fd, rec, 0, REC, mid * REC);
    const cmp = Buffer.compare(rec.subarray(0, 32), want);
    if (cmp === 0) {
      const key = {
        currency0: "0x" + rec.subarray(32, 52).toString("hex"),
        currency1: "0x" + rec.subarray(52, 72).toString("hex"),
        fee: rec.readUInt32BE(72),
        tickSpacing: rec.readInt32BE(76),
        hooks: "0x" + rec.subarray(80, 100).toString("hex")
      };
      /* Verify rather than trust. */
      try {
        const { keccak256 } = require("ethers");
        const enc = coder().encode(["tuple(address,address,uint24,int24,address)"],
          [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]);
        if (keccak256(enc).toLowerCase() !== String(poolId).toLowerCase()) return null;
      } catch (e) { return null; }
      return key;
    }
    if (cmp < 0) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

/* Ask the on-chain registry. One eth_call, no range limits, no rate-limit
 * exposure worth worrying about, and the answer is shared with everyone else
 * who has ever looked a pool up — which is the entire point of putting it on
 * chain instead of in a private cache file.
 *
 * The result is used directly without checking the hash locally. That is not
 * laziness: the contract computes the id FROM the key, so a key it returns for
 * an id necessarily hashes to that id. Re-deriving it here would be checking
 * keccak against itself.
 *
 * A failure here is never fatal. The registry is a shortcut; the log scan
 * below remains the ground truth and runs whenever the shortcut misses. */
async function registryLookup(poolId) {
  try {
    const r = await Z.rpcRetry("eth_call", [{
      to: Z.ARC.registry,
      data: Z.ARC.registryGetSelector + String(poolId).slice(2)
    }]);
    const d = String(r || "").slice(2);
    if (d.length < 64 * 6) return null;
    const word = (i) => d.slice(i * 64, (i + 1) * 64);
    if (BigInt("0x" + word(0)) === 0n) return null;      /* found == false */
    const toInt24 = (hex) => {
      const v = BigInt("0x" + hex);
      return v >= (1n << 23n) ? Number(v - (1n << 24n)) : Number(v);
    };
    return {
      currency0: ("0x" + word(1).slice(24)).toLowerCase(),
      currency1: ("0x" + word(2).slice(24)).toLowerCase(),
      fee: Number(BigInt("0x" + word(3))),
      tickSpacing: toInt24(word(4)),
      hooks: ("0x" + word(5).slice(24)).toLowerCase()
    };
  } catch (e) {
    return null;
  }
}

async function poolKeyOf(pool) {
  const cached = loadKeys()[pool.poolId];
  if (cached) return Object.assign({}, cached, { fromCache: true });

  const yerel = localIndexLookup(pool.poolId);
  if (yerel) {
    rememberKey(pool.poolId, yerel);
    return Object.assign({}, yerel, { fromLocalIndex: true });
  }

  const zincirden = await registryLookup(pool.poolId);
  if (zincirden) {
    /* Written to the local cache too, so a second request for the same pool
     * costs nothing at all rather than one more call. */
    rememberKey(pool.poolId, zincirden);
    return Object.assign({}, zincirden, { fromRegistry: true });
  }

  if (!pool.createdAt) return { error: "pool creation time unknown, cannot narrow the event search" };
  let centre;
  try { centre = await Z.blockForTime(pool.createdAt); }
  catch (e) { return { error: "block lookup failed: " + String(e.message).slice(0, 60) }; }

  /* The window is deliberately wider than the binary-search error (measured
   * at 0-2 blocks) because several 0.5 s blocks share one timestamp second. */
  const from = Math.max(1, centre - WINDOW_BLOCKS);
  const to = centre + WINDOW_BLOCKS;
  let logs;
  try {
    logs = await Z.rpcRetry("eth_getLogs", [{
      address: Z.ARC.poolManager,
      topics: [Z.INITIALIZE_TOPIC, pool.poolId],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16)
    }]);
  } catch (e) {
    return { error: (e.permanent ? "range rejected by RPC: " : "log query failed: ") + String(e.message).slice(0, 60) };
  }
  if (!logs || !logs.length) {
    return { error: "no Initialize event in the searched window (" + from + "-" + to + ")" };
  }
  const l = logs[0];
  /* topics: [sig, id, currency0, currency1]
   * data:   fee (uint24) | tickSpacing (int24) | hooks (address) | ... */
  const d = String(l.data || "").slice(2);
  const word = (i) => d.slice(i * 64, (i + 1) * 64);
  const toInt24 = (hex) => { const v = BigInt("0x" + hex); return v >= (1n << 23n) ? Number(v - (1n << 24n)) : Number(v); };
  const key = {
    currency0: ("0x" + String(l.topics[2]).slice(26)).toLowerCase(),
    currency1: ("0x" + String(l.topics[3]).slice(26)).toLowerCase(),
    fee: Number(BigInt("0x" + word(0))),
    tickSpacing: toInt24(word(1)),
    hooks: ("0x" + word(2).slice(24)).toLowerCase(),
    initBlock: parseInt(l.blockNumber, 16)
  };
  rememberKey(pool.poolId, key);
  return key;
}

/* ---- 3) quote one leg --------------------------------------------------- */
/* quoteExactInputSingle returns its answer in the revert payload, so a revert
 * is the SUCCESS path and the payload has to be decoded. A revert with no
 * decodable payload means the call itself failed, which is a different thing
 * from the pool refusing the swap. */
/* ABI ENCODING IS DELEGATED, NOT HAND-ROLLED.
 *
 * The first version built the calldata by hand. It was wrong twice: it
 * omitted the leading offset word for the dynamic outer tuple, and after
 * that was fixed it still did not match. Both faults were found only by
 * encoding the same call with a verified ABI coder and comparing byte for
 * byte — on-chain they would have produced plausible-looking but meaningless
 * quotes, which is worse than a visible error.
 *
 * ethers is used ONLY for encoding and decoding here. Its JsonRpcProvider is
 * deliberately not used: during development it retried network detection
 * forever against a dead endpoint and masked real RPC errors behind
 * "could not coalesce error". The raw client in zincir.js keeps the error
 * text intact; the ABI coder removes a class of silent bugs. Each tool for
 * what it is good at. */
let _coder = null;
function coder() {
  if (_coder) return _coder;
  const { AbiCoder } = require("ethers");
  _coder = AbiCoder.defaultAbiCoder();
  return _coder;
}

const QUOTE_ABI = "tuple(tuple(address,address,uint24,int24,address),bool,uint128,bytes)";

function encodeQuote(key, zeroForOne, amountIn) {
  const body = coder().encode([QUOTE_ABI], [[
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    zeroForOne,
    amountIn,
    "0x"
  ]]);
  return Z.ARC.quoterSelector + body.slice(2);
}

/* Short and few on purpose. If the endpoint is throttling hard, waiting
 * longer does not produce a quote, it just produces a late answer — and
 * the call is pinned to a block that is ageing while we wait. Four tries
 * at up to 5 s each could hold a single pool for twenty seconds, which was
 * measured. UNMEASURED delivered quickly is more useful than a number
 * delivered after the caller has given up. */
const QUOTE_RATE_TRIES = Number(process.env.QUOTE_RATE_TRIES || 2);

async function quoteLeg(key, zeroForOne, amountIn, blockTag) {
  const data = encodeQuote(key, zeroForOne, amountIn);
  const call = { to: Z.ARC.quoter, data };
  const tag = blockTag != null ? "0x" + Number(blockTag).toString(16) : "latest";
  let rateHits = 0;
  for (;;) {
  try {
    const out = await Z.rpc("eth_call", [call, tag]);
    if (out && out !== "0x") {
      const v = Z.hexToBigInt("0x" + out.slice(2, 66));
      return v > 0n ? { amountOut: v } : { reason: "quote returned zero" };
    }
    return { reason: "empty response" };
  } catch (e) {
    /* A rate limit is not an answer from the pool — it is the endpoint
     * declining to ask. Retry it, briefly, before falling through to the
     * revert decoding below. */
    if (e.rateLimited && rateHits < QUOTE_RATE_TRIES) {
      rateHits++;
      const bekle = Math.min(e.retryAfterMs || 400 * Math.pow(2, rateHits - 1), 1500);
      await new Promise((r) => setTimeout(r, bekle));
      continue;
    }
    /* Some nodes put revert data on the error object, others in the message. */
    const blob = String((e && (e.data || e.message)) || "");
    const m = /0x[0-9a-fA-F]{64,}/.exec(blob);
    if (m) {
      const v = Z.hexToBigInt("0x" + m[0].slice(2, 66));
      if (v > 0n) return { amountOut: v };
      return { reason: "revert payload decoded to zero" };
    }
    /* No decodable payload: the CALL failed, the pool did not speak. */
    return { unmeasured: true, reason: "call failed: " + String(e.message).slice(0, 60) };
  }
  }
}

/* ---- 4) round trip at one pinned block ---------------------------------- */
async function roundTrip(key, sizeUsdc, blockTag) {
  const usdcIsCurrency0 = String(key.currency0).toLowerCase() === Z.ARC.usdc.toLowerCase();
  const amountIn = Z.fromUsdc(sizeUsdc);

  const buy = await quoteLeg(key, usdcIsCurrency0, amountIn, blockTag);
  if (buy.unmeasured) return { status: "UNMEASURED", reason: "buy leg: " + buy.reason };
  if (!buy.amountOut) return { status: "NO_BUY_QUOTE", reason: buy.reason };
  /* uint128 is the quoter's amount type; anything larger cannot be encoded. */
  if (buy.amountOut >= (1n << 127n)) return { status: "UNMEASURED", reason: "token amount exceeds uint128" };

  const sell = await quoteLeg(key, !usdcIsCurrency0, buy.amountOut, blockTag);
  if (sell.unmeasured) return { status: "UNMEASURED", reason: "sell leg: " + sell.reason };
  if (!sell.amountOut) return { status: "CANNOT_SELL", reason: sell.reason, buyWorked: true };

  const inUsd = Z.toUsdc(amountIn);
  const outUsd = Z.toUsdc(sell.amountOut);
  return {
    status: "MEASURED",
    inUsdc: Number(inUsd.toFixed(6)),
    outUsdc: Number(outUsd.toFixed(6)),
    /* Round-trip cost includes BOTH fees and price impact, which is the only
     * number that matches what a trader actually experiences. */
    roundTripBps: Math.round((1 - outUsd / inUsd) * 10000),
    tokensReceived: buy.amountOut.toString()
  };
}

module.exports = {
  poolsOfToken, poolsOfTokenMeta, poolKeyOf, registryLookup, localIndexLookup,
  localPoolsOfToken, roundTrip, quoteLeg, encodeQuote, gt
};
