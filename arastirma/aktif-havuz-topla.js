"use strict";
/* ===========================================================================
 * aktif-havuz-topla.js — collect the Arc pools that are actually traded
 *
 *   node arastirma/aktif-havuz-topla.js [cikti.json]
 *
 * WHY NOT ALL OF THEM
 *   Arc has 216,839 v4 pools. Writing every key into the on-chain registry
 *   would cost roughly 173 USDC at the gas price measured here, and most of
 *   those pools are dead launches nobody will ever quote. The registry is
 *   worth filling where lookups actually happen.
 *
 *   GeckoTerminal only lists pools that trade, which makes its listing a
 *   reasonable proxy for "someone might ask about this one". Three different
 *   listings are merged — top by volume, trending, and newest — because each
 *   answers a different version of the question and the overlap between them
 *   is small.
 *
 * OUTPUT
 *   { collectedAt, pools: [ { poolId, name, liquidityUsd, source } ] }
 *   deduplicated by pool id, sorted by liquidity descending.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const H = require("../src/havuz.js");

const cikti = process.argv[2] || path.join(__dirname, "..", "data", "aktif-havuzlar.json");
const say = (n) => n.toLocaleString("en-US");

/* GeckoTerminal caps paging at 10 pages of 20. Asking for more returns the
 * last page over and over, so the loop stops when a page adds nothing new. */
const SAYFA = 10;

async function topla(yol, etiket, bulunan) {
  let eklenen = 0;
  for (let p = 1; p <= SAYFA; p++) {
    let d;
    try { d = await H.gt(yol + (yol.indexOf("?") >= 0 ? "&" : "?") + "page=" + p); }
    catch (e) {
      console.log("  " + etiket + " sayfa " + p + ": " + String(e.message).slice(0, 50));
      break;
    }
    const list = (d && d.data) || [];
    if (!list.length) break;
    let yeni = 0;
    for (const x of list) {
      const a = x.attributes || {};
      const id = String(a.address || "").toLowerCase();
      if (!id || bulunan.has(id)) continue;
      bulunan.set(id, {
        poolId: id,
        name: a.name || null,
        liquidityUsd: Number(a.reserve_in_usd) || 0,
        volume24h: Number((a.volume_usd && a.volume_usd.h24) || 0),
        source: etiket
      });
      yeni++; eklenen++;
    }
    process.stdout.write("\r  " + etiket + " sayfa " + p + "  +" + yeni + "  (toplam " + bulunan.size + ")   ");
    if (!yeni) break;
  }
  console.log("");
  return eklenen;
}

(async function main() {
  console.log("AKTIF ARC HAVUZLARINI TOPLA");
  const bulunan = new Map();

  await topla("/networks/arc/pools", "hacim", bulunan);
  await topla("/networks/arc/trending_pools", "trend", bulunan);
  await topla("/networks/arc/new_pools", "yeni", bulunan);

  const pools = [...bulunan.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  fs.mkdirSync(path.dirname(cikti), { recursive: true });
  fs.writeFileSync(cikti, JSON.stringify({ collectedAt: new Date().toISOString(), pools }, null, 1));

  console.log("");
  console.log("  tekil havuz " + say(pools.length));
  if (pools.length) {
    const likit = pools.filter((p) => p.liquidityUsd >= 1000).length;
    console.log("  likidite >= $1.000: " + say(likit));
    console.log("  en likit: " + pools[0].name + "  $" + say(Math.round(pools[0].liquidityUsd)));
  }
  console.log("  yazildi " + cikti);
})().catch((e) => { console.log("HATA " + e.message); process.exit(1); });
