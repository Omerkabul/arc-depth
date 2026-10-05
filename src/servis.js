"use strict";
/* ===========================================================================
 * servis.js — HTTP front door
 *
 *   GET /sellable?token=0x...&size=5   measure a round trip through every pool
 *   GET /health                        liveness and configuration
 *
 * Read-only by construction: no wallet, no signing, no transactions, no
 * approvals. Every number comes from an eth_call quote or a public index.
 *
 * DESIGN NOTES THAT MATTER
 *   - UNMEASURED is not a verdict. A failed RPC call is reported as such and
 *     never as "cannot sell". Treating a network error as a honeypot stamps
 *     healthy pools as traps.
 *   - Both legs are quoted at the SAME pinned block and the block hash is
 *     re-read afterwards. If it moved, the answer says so instead of
 *     pretending the two legs shared one state.
 *   - Dynamic-fee pools (fee == 2^23) are listed but not priced: the hook
 *     decides the fee at swap time, so no fixed percentage is honest.
 *   - Rate limited per IP, because the public Arc RPC is a shared resource.
 * =========================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const Z = require("./zincir.js");
const H = require("./havuz.js");

const PORT = Number(process.env.PORT || 8712);
const HOST = process.env.HOST || "0.0.0.0";
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20);
const MAX_POOLS = Number(process.env.MAX_POOLS || 8);
const DEFAULT_SIZE = Number(process.env.DEFAULT_SIZE || 5);
const MAX_SIZE = Number(process.env.MAX_SIZE || 500);
/* Wall-clock ceiling for the quoting loop. Not a timeout on the request:
 * whatever was measured before the ceiling is still returned. */
const MEASURE_BUDGET_MS = Number(process.env.MEASURE_BUDGET_MS || 9000);

const log = (...a) => console.log("[arc-depth " + new Date().toISOString().slice(11, 19) + "]", ...a);

/* The set of files git tracks, read once from the commit. Using the commit as
 * the allowlist means anything gitignored (node_modules, data/, .env) is
 * unreachable by construction rather than by a path rule I might get wrong. */
let _tracked = null;
function trackedFiles() {
  if (_tracked) return _tracked;
  try {
    const out = require("child_process").execFileSync("git",
      ["-C", path.join(__dirname, ".."), "ls-files"], { encoding: "utf8", timeout: 10000 });
    _tracked = out.split(/\r?\n/).filter(Boolean);
  } catch (e) { _tracked = []; }
  return _tracked;
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= RATE_PER_MIN) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 300000) hits.delete(k);
  }
  return false;
}

async function measure(token, sizeUsdc) {
  const started = Date.now();
  const answer = {
    token, sizeUsdc, chain: "arc", chainId: Z.ARC.chainId,
    measuredAt: new Date().toISOString(),
    method: "Uniswap v4 quoter, both legs at one pinned block, chained amounts. No transaction is sent.",
    coverage: "Uniswap v4 pools only. Arc also has v3 pools and they are NOT covered here."
  };

  let pools, listMeta;
  try { listMeta = await H.poolsOfTokenMeta(token); pools = listMeta.pools; }
  catch (e) {
    answer.sellable = null;
    answer.result = "UNMEASURED";
    answer.explanation = "Could not list this token's pools: " + String(e.message).slice(0, 80) +
      ". This is not a verdict about the token.";
    return answer;
  }
  answer.poolsFound = pools.length;
  /* How old the pool LISTING is. Every quote below is still taken live at the
   * pinned block; only the set of pools to quote may lag by this much. */
  answer.poolListAgeMs = listMeta.ageMs;
  answer.poolListSource = listMeta.source || "remote";
  if (listMeta.source === "localIndex") {
    answer.poolListNote = "The listing provider failed (" +
      String(listMeta.error).slice(0, 60) + "), so the pool set came from the local " +
      "Initialize index instead. It is complete — it includes pools with no trading " +
      "volume, which the provider omits — but it carries no liquidity, so the pools " +
      "quoted below were NOT chosen deepest-first.";
  }
  if (listMeta.stale) {
    answer.poolListStale = true;
    answer.poolListNote = "The pool listing provider failed for this request (" +
      String(listMeta.error).slice(0, 60) + "), so the previous listing was used. " +
      "A pool opened in the last " + Math.round(listMeta.ageMs / 1000) + " s could be missing. " +
      "The quotes themselves are live.";
  }
  if (!pools.length) {
    answer.sellable = null;
    answer.result = "NO_POOLS_FOUND";
    answer.explanation = "No Arc pools are indexed for this token. That does not mean the token " +
      "does not exist — the pool may be too new to be indexed, or paired against something other than USDC.";
    return answer;
  }

  const dynamic = pools.filter((p) => p.labelFeePct != null && p.labelFeePct > 1000);
  if (dynamic.length) {
    answer.dynamicFeePools = dynamic.length;
    answer.dynamicFeeNote = "Fee is set by the hook at swap time for these pools (v4 dynamic-fee flag). " +
      "No fixed percentage can be quoted, so they are listed but not priced.";
  }

  /* Deepest pools first: that is where a trade would actually route, and the
   * per-IP budget should be spent on the pools that matter. */
  const candidates = pools
    .filter((p) => !(p.labelFeePct != null && p.labelFeePct > 1000))
    .sort((a, b) => (Number(b.liquidityUsd) || 0) - (Number(a.liquidityUsd) || 0))
    .slice(0, MAX_POOLS);

  let block = null, blockHash = null;
  try { block = await Z.blockNumber(); const b = await Z.blockAt(block); blockHash = b && b.hash; }
  catch (e) { /* reported below through pinStatus */ }
  answer.block = block; answer.blockHash = blockHash;

  const results = [];
  let butceAsildi = false;
  for (const p of candidates) {
    if (Date.now() - started > MEASURE_BUDGET_MS) {
      butceAsildi = true;
      results.push({
        poolId: p.poolId, name: p.name, dex: p.dex,
        labelFeePct: p.labelFeePct,
        liquidityUsd: Number.isFinite(p.liquidityUsd) ? p.liquidityUsd : null,
        status: "UNMEASURED",
        reason: "not reached within the " + MEASURE_BUDGET_MS + " ms measurement budget"
      });
      continue;
    }
    const row = {
      poolId: p.poolId, name: p.name, dex: p.dex,
      labelFeePct: p.labelFeePct, liquidityUsd: Number.isFinite(p.liquidityUsd) ? p.liquidityUsd : null
    };
    const key = await H.poolKeyOf(p);
    if (key.error) {
      row.status = "UNMEASURED";
      row.reason = key.error;
      results.push(row); continue;
    }
    row.keySource = key.fromCache ? "localCache"
      : key.fromLocalIndex ? "localIndex"
      : key.fromRegistry ? "onChainRegistry"
      : "initializeLogScan";
    row.fee = key.fee;
    row.feePct = Number((key.fee / 10000).toFixed(4));
    row.tickSpacing = key.tickSpacing;
    row.hooks = key.hooks;
    row.customHook = String(key.hooks).toLowerCase() !== "0x0000000000000000000000000000000000000000";
    const rt = await H.roundTrip(key, sizeUsdc, block);
    Object.assign(row, rt);
    results.push(row);
  }
  answer.pools = results;
  if (butceAsildi) {
    answer.budgetExceeded = true;
    answer.budgetNote = "Quoting stopped after " + MEASURE_BUDGET_MS + " ms, usually because the " +
      "RPC was rate limiting. Pools marked UNMEASURED below were not reached — that is not a " +
      "verdict about them, and the summary covers only the pools that were measured.";
  }

  /* Pin verification: did the chain move under us while we were reading? */
  if (block != null && blockHash) {
    try {
      const again = await Z.blockAt(block);
      answer.pinStatus = (again && again.hash === blockHash) ? "VERIFIED" : "REORG";
    } catch (e) { answer.pinStatus = "UNVERIFIED"; }
  } else answer.pinStatus = "NOT_PINNED";

  const measured = results.filter((r) => r.status === "MEASURED");
  if (measured.length) {
    measured.sort((a, b) => a.roundTripBps - b.roundTripBps);
    const best = measured[0], worst = measured[measured.length - 1];
    answer.sellable = true;
    answer.result = "SELLABLE";
    answer.bestPool = best.poolId;
    answer.bestRoundTripBps = best.roundTripBps;
    answer.bestRoundTripPct = Number((best.roundTripBps / 100).toFixed(2));
    answer.worstRoundTripPct = Number((worst.roundTripBps / 100).toFixed(2));
    answer.explanation = "Cheapest route costs " + answer.bestRoundTripPct + "% for a " + sizeUsdc +
      " USDC round trip" + (measured.length > 1 ? ", the most expensive measured pool costs " +
      answer.worstRoundTripPct + "%" : "") + ". The figure includes fees and price impact.";
    if (measured.length > 1 && worst.roundTripBps - best.roundTripBps > 1000) {
      answer.routingWarning = "Pools for this token differ by " +
        ((worst.roundTripBps - best.roundTripBps) / 100).toFixed(2) +
        " percentage points. Routing through the wrong one is the main risk here, not the token itself.";
    }
  } else if (results.some((r) => r.status === "CANNOT_SELL")) {
    answer.sellable = false;
    answer.result = "CANNOT_SELL";
    answer.explanation = "A buy could be quoted but a sell could not. This is a honeypot indicator. " +
      "It describes this block only; hook behaviour can change.";
  } else if (results.length && results.every((r) => r.status === "UNMEASURED")) {
    answer.sellable = null;
    answer.result = "UNMEASURED";
    answer.explanation = "Quote calls did not complete. This is NOT the same as cannot-sell. Try again.";
  } else {
    answer.sellable = null;
    answer.result = "NO_BUY_QUOTE";
    answer.explanation = "Even a buy could not be quoted; the pools appear empty or uninitialised.";
  }

  answer.elapsedMs = Date.now() - started;
  return answer;
}

const server = http.createServer(async (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  };
  let u;
  try { u = new URL(req.url, "http://localhost"); } catch (e) { return res.writeHead(400, headers).end("{}"); }

  /* The demo page is served by the same process on purpose. One process and
   * one origin means it works through a tunnel with no CORS setup and no
   * second host to keep alive — the simplest thing that can be public. */
  if (u.pathname === "/" || u.pathname === "/index.html") {
    try {
      const page = fs.readFileSync(path.join(__dirname, "..", "demo", "index.html"));
      return res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }).end(page);
    } catch (e) {
      return res.writeHead(500, headers).end(JSON.stringify({ error: "demo page missing" }));
    }
  }

  /* ---- PUBLIC SOURCE ----------------------------------------------------
   * The source is served from the same origin for two reasons.
   *
   * First, a measurement tool asks to be trusted, and the only honest basis
   * for that is being readable. Anyone can check that the round-trip number
   * comes from two chained quotes at one pinned block and that nothing is
   * signed or sent.
   *
   * Second, it makes the project a genuinely public code repository without
   * depending on any hosting account. /source lists and serves every tracked
   * file; the .git directory is served over git's HTTP protocol, so
   *     git clone <this-origin>/git
   * works for anyone. No login, no platform, no account.
   *
   * Only files git tracks are reachable. node_modules, data/ and .env are
   * gitignored and therefore invisible here — the allowlist is the commit,
   * not a path filter I might get wrong. */
  if (u.pathname === "/source" || u.pathname.startsWith("/source/")) {
    const rel = decodeURIComponent(u.pathname.replace(/^\/source\/?/, ""));
    if (!rel) {
      const files = trackedFiles();
      const rows = files.map((f) =>
        '<li><a href="/source/' + encodeURIComponent(f) + '">' + f + "</a></li>").join("\n");
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        "<!doctype html><meta charset=utf-8><title>arc-depth source</title>" +
        '<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;' +
        "background:#0f1115;color:#e7eaf0}a{color:#58a6ff}code{background:#171a21;padding:2px 6px;border-radius:4px}" +
        "@media(prefers-color-scheme:light){body{background:#fff;color:#1b1f26}code{background:#f0f2f5}}</style>" +
        "<h1>arc-depth source</h1>" +
        "<p>Every file this service runs. Clone it with:</p>" +
        "<p><code>git clone " + (req.headers.host ? "https://" + req.headers.host : "") + "/git arc-depth</code></p>" +
        "<ul>" + rows + "</ul>");
    }
    /* Path must be exactly a tracked file. No traversal is possible because
     * the name has to match the commit listing, not merely look safe. */
    if (!trackedFiles().includes(rel)) {
      return res.writeHead(404, headers).end(JSON.stringify({ error: "not a tracked file" }));
    }
    try {
      const body = fs.readFileSync(path.join(__dirname, "..", rel));
      const ct = /\.html?$/.test(rel) ? "text/plain; charset=utf-8"   /* shown, not rendered */
        : /\.json$/.test(rel) ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8";
      return res.writeHead(200, { "content-type": ct, "cache-control": "no-store" }).end(body);
    } catch (e) {
      return res.writeHead(404, headers).end(JSON.stringify({ error: "unreadable" }));
    }
  }

  /* git's HTTP transport: serving .git read-only makes the repo clonable. */
  if (u.pathname.startsWith("/git/")) {
    const rel = u.pathname.slice("/git/".length);
    if (/\.\./.test(rel)) return res.writeHead(400, headers).end(JSON.stringify({ error: "bad path" }));
    try {
      const body = fs.readFileSync(path.join(__dirname, "..", ".git", rel));
      return res.writeHead(200, {
        "content-type": "application/octet-stream", "cache-control": "no-store"
      }).end(body);
    } catch (e) {
      return res.writeHead(404, headers).end("");
    }
  }

  if (u.pathname === "/health") {
    return res.writeHead(200, headers).end(JSON.stringify({
      status: "up", chain: "arc", chainId: Z.ARC.chainId,
      rpc: Z.ARC.rpc, quoter: Z.ARC.quoter, poolManager: Z.ARC.poolManager,
      rateLimitPerMin: RATE_PER_MIN, maxPoolsPerRequest: MAX_POOLS, maxSizeUsdc: MAX_SIZE,
      readOnly: true
    }, null, 1));
  }

  if (u.pathname !== "/sellable") {
    return res.writeHead(404, headers).end(JSON.stringify({
      error: "unknown path",
      usage: "/sellable?token=0x...&size=5   |   /health"
    }, null, 1));
  }

  if (rateLimited(ip)) {
    return res.writeHead(429, headers).end(JSON.stringify({
      error: "rate limited", limit: RATE_PER_MIN + " requests per minute",
      why: "the public Arc RPC is shared; the limit protects it"
    }, null, 1));
  }

  const token = String(u.searchParams.get("token") || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return res.writeHead(400, headers).end(JSON.stringify({
      error: "invalid token address", expected: "0x followed by 40 hex characters"
    }, null, 1));
  }
  let size = Number(u.searchParams.get("size"));
  if (!Number.isFinite(size) || size <= 0) size = DEFAULT_SIZE;
  if (size > MAX_SIZE) {
    return res.writeHead(400, headers).end(JSON.stringify({
      error: "size above limit", limit: MAX_SIZE,
      why: "larger sizes cost more quote calls on a shared endpoint"
    }, null, 1));
  }

  try {
    const out = await measure(token, size);
    log(ip + "  " + token.slice(0, 10) + "  " + size + " USDC  -> " + out.result +
        (out.bestRoundTripPct != null ? "  " + out.bestRoundTripPct + "%" : "") + "  " + out.elapsedMs + "ms");
    res.writeHead(200, headers).end(JSON.stringify(out, null, 1));
  } catch (e) {
    log("error " + String(e && e.message).slice(0, 100));
    res.writeHead(500, headers).end(JSON.stringify({
      error: "internal error", result: "UNMEASURED",
      explanation: "The request failed on our side. This is not a verdict about the token."
    }, null, 1));
  }
});

server.listen(PORT, HOST, () => {
  log("listening on " + HOST + ":" + PORT);
  log("  GET /sellable?token=0x...&size=5");
  log("  GET /health");
  log("read-only: no wallet, no signing, no transactions");
});
