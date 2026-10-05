"use strict";
/* ===========================================================================
 * ters-indeks-derle.js — build a token -> pools index
 *
 *   node arastirma/ters-indeks-derle.js <kaynak.json> [cikti.bin]
 *
 * WHY
 *   Listing a token's pools is the last thing this service cannot do by
 *   itself. It asks GeckoTerminal, which is free and keyless but rate limits
 *   hard: measured cold requests of 10 s and 33 s, all of it spent in backoff
 *   waiting for a listing the machine could have produced locally.
 *
 *   Every pool's two currencies are already in the key index. Inverting it
 *   gives "which pools does this token have" without a network call at all.
 *
 *   The local answer is also WIDER than the remote one. GeckoTerminal only
 *   lists pools that trade, so a pool with no volume is invisible there — and
 *   an untraded pool is exactly the kind a honeypot check should look at. The
 *   local index knows every pool that was ever initialised.
 *
 *   What it does NOT know is liquidity, which is why this is a fallback and
 *   an addition rather than a replacement: without it there is no honest way
 *   to rank pools when a token has more than can be quoted in one request.
 *
 * WHAT IS OMITTED
 *   Entries for the quote asset itself. Almost every pool is paired against
 *   USDC, so indexing USDC would file 200k+ pools under one key that nobody
 *   will ever usefully query. Every other currency gets an entry, so a pool
 *   between two non-USDC tokens appears under both.
 *
 * RECORD LAYOUT (52 bytes, sorted ascending by token then pool id)
 *   0  20  token address
 *   20 32  pool id
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const Z = require("../src/zincir.js");

const REC = 52;
const kaynak = process.argv[2];
const cikti = process.argv[3] || path.join(__dirname, "..", "data", "token-havuz.bin");
const say = (n) => n.toLocaleString("en-US");

function main() {
  if (!kaynak || !fs.existsSync(kaynak)) {
    console.log("kullanim: node arastirma/ters-indeks-derle.js <kaynak.json> [cikti.bin]");
    console.log("kaynak, indeks-derle.js ile ayni bicimdedir.");
    process.exit(1);
  }
  console.log("TERS INDEKS DERLE  (token -> havuzlar)");
  console.log("  kaynak " + kaynak);

  const j = JSON.parse(fs.readFileSync(kaynak, "utf8"));
  const h = j.havuzlar || j;
  const ids = Object.keys(h);
  console.log("  havuz  " + say(ids.length));

  const usdc = String(Z.ARC.usdc).toLowerCase();
  const kayitlar = [];
  let atlanan = 0;

  for (const id of ids) {
    const k = h[id];
    if (!k || !k.c0 || !k.c1) { atlanan++; continue; }
    const idBuf = Buffer.from(String(id).replace(/^0x/, ""), "hex");
    if (idBuf.length !== 32) { atlanan++; continue; }
    for (const cur of [k.c0, k.c1]) {
      const c = String(cur).toLowerCase();
      if (c === usdc) continue;                 /* see note above */
      const b = Buffer.alloc(REC);
      Buffer.from(c.replace(/^0x/, ""), "hex").copy(b, 0);
      idBuf.copy(b, 20);
      kayitlar.push(b);
    }
  }

  /* Sorting the whole record works: the token occupies the leading bytes, so
   * ordering by the full buffer orders by token first and pool id second,
   * which is exactly what the reader's binary search needs. */
  kayitlar.sort(Buffer.compare);

  const buf = Buffer.concat(kayitlar);
  fs.mkdirSync(path.dirname(cikti), { recursive: true });
  const tmp = cikti + ".tmp";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, cikti);

  /* How many pools a token actually has, from the whole population rather
   * than from the handful that happen to trade. */
  const sayac = new Map();
  for (const b of kayitlar) {
    const t = b.subarray(0, 20).toString("hex");
    sayac.set(t, (sayac.get(t) || 0) + 1);
  }
  const dagilim = [...sayac.values()].sort((a, b) => a - b);
  const yuzde = (p) => dagilim[Math.min(dagilim.length - 1, Math.floor(dagilim.length * p))];

  console.log("");
  console.log("  kayit      " + say(kayitlar.length));
  console.log("  tekil token " + say(sayac.size));
  console.log("  atlanan    " + say(atlanan));
  console.log("  havuz/token  medyan " + yuzde(0.5) + "   p90 " + yuzde(0.9) + "   en fazla " + dagilim[dagilim.length - 1]);
  console.log("  dosya      " + cikti + "  (" + say(Math.round(buf.length / 1048576)) + " MB)");
  console.log("");
  console.log("  servise baglamak icin:  ARC_TOKEN_INDEX=" + cikti);
}

main();
