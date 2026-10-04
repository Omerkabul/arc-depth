"use strict";
/* ===========================================================================
 * kontrol.js — self-checks. Run with: npm run check
 *
 * Every check here exists because the corresponding bug actually happened
 * during development. They are regression tests for mistakes that FAIL
 * SILENTLY — the dangerous kind, where the code returns a plausible number
 * instead of an error.
 *
 *   1) ABI encoding. Hand-rolled calldata was wrong twice (a missing offset
 *      word for the dynamic outer tuple, then a further mismatch). On-chain
 *      this produces meaningless quotes that look fine.
 *   2) Timestamp to block. An arithmetic estimate from a fixed block time was
 *      off by up to fourteen hours, which would have centred the event search
 *      window nowhere near the pool and returned "no Initialize event".
 *   3) Live end to end. Proves the whole path works against the real chain.
 * =========================================================================== */
const { AbiCoder } = require("ethers");
const Z = require("./zincir.js");
const H = require("./havuz.js");

const line = (durum, label, detail) =>
  console.log("  " + durum + "  " + label + (detail ? "   " + detail : ""));

let failures = 0, limited = 0;

/* A rate-limited endpoint is reported as LIMIT, not FAIL, and does not set the
 * exit code. The distinction is not cosmetic: the public Arc RPC throttles, so
 * anyone running these checks while the service is also running will be
 * throttled, and calling that a failed check tells them the code is broken when
 * it is not. The run still says plainly that something went unverified — a
 * check that was skipped must never read as a check that passed. */
const check = (ok, label, detail) => { if (!ok) failures++; line(ok ? "PASS" : "FAIL", label, detail); };

const rateLimitHatasi = (e) =>
  !!(e && (e.rateLimited || e.httpStatus === 429 || /\b(429|503)\b|rate.?limit|too many requests/i.test(String(e.message || e))));

/* For a failure that is already in hand: it decides between FAIL and LIMIT
 * instead of the caller having to know the difference. */
const checkE = (e, label, detail) => {
  if (e && rateLimitHatasi(e)) { limited++; line("LIMIT", label, "rate limited by the RPC, not verified"); return; }
  failures++; line("FAIL", label, detail);
};

async function abiCheck() {
  console.log("\n1) ABI encoding matches a reference coder");
  const ref = AbiCoder.defaultAbiCoder();
  const sig = "tuple(tuple(address,address,uint24,int24,address),bool,uint128,bytes)";
  const base = {
    currency0: "0x3600000000000000000000000000000000000000",
    currency1: "0xa39c8e2ceb2a0f9d6e9d059f5e470edfda691c15",
    fee: 10000, tickSpacing: 200,
    hooks: "0x0000000000000000000000000000000000000000"
  };
  const cases = [
    { zeroForOne: true, amount: 5000000n, tickSpacing: 200, label: "usdc->token, 5 USDC" },
    { zeroForOne: false, amount: 123456789n, tickSpacing: 200, label: "token->usdc, large amount" },
    { zeroForOne: true, amount: 1n, tickSpacing: -60, label: "negative tickSpacing" },
    { zeroForOne: true, amount: (1n << 120n), tickSpacing: 1, label: "near-uint128 amount" }
  ];
  for (const c of cases) {
    const key = Object.assign({}, base, { tickSpacing: c.tickSpacing });
    const expected = Z.ARC.quoterSelector + ref.encode([sig], [[
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      c.zeroForOne, c.amount, "0x"
    ]]).slice(2);
    const actual = H.encodeQuote(key, c.zeroForOne, c.amount);
    check(expected === actual, c.label,
      expected === actual ? "" : "lengths " + expected.length + " vs " + actual.length);
  }
}

async function blockCheck() {
  console.log("\n2) timestamp to block resolution (binary search, no fixed block time)");
  const head = await Z.blockNumber();
  for (const target of [head - 1, head - 170000, 1000000]) {
    const b = await Z.blockAt(target);
    if (!b) { check(false, "block " + target, "could not be read"); continue; }
    const found = await Z.blockForTime(b.timestamp * 1000);
    const drift = Math.abs(found - b.number);
    /* Several 0.5 s blocks share one timestamp second, so a few blocks of
     * drift is expected and harmless; the search window absorbs it. */
    check(drift <= 10, "block " + b.number, "drift " + (found - b.number) + " blocks");
  }
}

async function liveCheck() {
  console.log("\n3) live end to end on a real Arc token");
  /* AI on Arc. Chosen because it is known to have many pools with very
   * different fee tiers, which is the exact situation this tool is for. */
  const token = process.env.CHECK_TOKEN || "0xa39c8e2ceb2a0f9d6e9d059f5e470edfda691c15";
  let pools;
  try { pools = await H.poolsOfToken(token); }
  catch (e) { checkE(e, "pool listing", String(e.message).slice(0, 60)); return; }
  check(pools.length > 0, "pool listing", pools.length + " pools found");
  if (!pools.length) return;

  const withLiquidity = pools.filter((p) => Number.isFinite(p.liquidityUsd) && p.liquidityUsd > 0)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const target = withLiquidity[0] || pools[0];

  const key = await H.poolKeyOf(target);
  if (key.error) {
    /* poolKeyOf reports its failure as a string rather than throwing, so the
     * rate-limit test is applied to that string. */
    checkE({ message: key.error }, "PoolKey recovery", key.error);
    return;
  }
  check(true, "PoolKey recovery", "fee " + key.fee + ", tickSpacing " + key.tickSpacing + ", hooks " + String(key.hooks).slice(0, 10));

  const block = await Z.blockNumber();
  const rt = await H.roundTrip(key, 5, block);
  check(rt.status === "MEASURED" || rt.status === "CANNOT_SELL",
    "round-trip quote", rt.status + (rt.roundTripBps != null ? " at " + rt.roundTripBps + " bps" : "") + (rt.reason ? " (" + rt.reason + ")" : ""));
}

(async () => {
  console.log("arc-depth self-check");
  console.log("  rpc     " + Z.ARC.rpc);
  console.log("  quoter  " + Z.ARC.quoter);
  console.log("  manager " + Z.ARC.poolManager);
  try {
    await abiCheck();
    await blockCheck();
    await liveCheck();
  } catch (e) {
    console.log("\nunexpected error: " + (e && e.message));
    failures++;
  }
  const kuyruk = limited ? "   (" + limited + " not verified: RPC rate limited)" : "";
  console.log("\n" + (failures ? failures + " CHECK(S) FAILED" + kuyruk
    : limited ? "no failures, but " + limited + " check(s) could not be verified because the RPC rate limited us"
    : "all checks passed"));
  process.exit(failures ? 1 : 0);
})();
