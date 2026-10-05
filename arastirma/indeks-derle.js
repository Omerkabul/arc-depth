"use strict";
/* ===========================================================================
 * indeks-derle.js — build a seekable PoolKey index
 *
 *   node arastirma/indeks-derle.js <kaynak.json> [cikti.bin]
 *
 * WHY THIS EXISTS
 *   Recovering a PoolKey from the chain is the slowest thing this service
 *   does. A v4 pool id is keccak(PoolKey) and is not reversible, so the key
 *   has to come from the Initialize event that created the pool — a binary
 *   search for the creation block followed by a narrow eth_getLogs window.
 *   Measured end to end on a token nobody had queried before: 45 seconds.
 *
 *   The events only need to be read once, ever. A PoolKey is immutable, so an
 *   index built today stays correct forever; the only thing that ages is its
 *   coverage of pools created after the build.
 *
 * WHY A BINARY FILE AND NOT JSON
 *   The source index is 66 MB of JSON for 216,839 pools. Parsing it costs a
 *   few hundred megabytes of heap, which is an absurd price for a service
 *   that otherwise runs in 21 MB and usually needs four keys per request.
 *
 *   So the records are written fixed-width and sorted by pool id. A lookup is
 *   then a binary search over the file: about eighteen 100-byte reads, no
 *   parsing, and nothing held in memory between requests. The file is
 *   disposable — deleting it costs speed, never correctness, because the log
 *   scan remains underneath it.
 *
 * RECORD LAYOUT (100 bytes, big-endian, sorted ascending by id)
 *   0  32  pool id
 *   32 20  currency0
 *   52 20  currency1
 *   72  4  fee          uint32  (v4 fee is uint24; 2^23 is the dynamic flag)
 *   76  4  tickSpacing  int32   (two's complement, can be negative)
 *   80 20  hooks
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { AbiCoder, keccak256 } = require("ethers");

const REC = 100;
const kaynak = process.argv[2];
const cikti = process.argv[3] || path.join(__dirname, "..", "data", "havuz-indeksi.bin");

const say = (n) => n.toLocaleString("en-US");
const hexBuf = (h, len) => {
  const b = Buffer.alloc(len);
  Buffer.from(String(h).replace(/^0x/, ""), "hex").copy(b, len - Math.min(len, (String(h).length - 2) / 2));
  return b;
};

function main() {
  if (!kaynak || !fs.existsSync(kaynak)) {
    console.log("kullanim: node arastirma/indeks-derle.js <kaynak.json> [cikti.bin]");
    console.log("");
    console.log("kaynak, Initialize olaylarindan toplanmis bir havuz sozlugudur:");
    console.log('  { "havuzlar": { "<poolId>": { "c0":"0x..", "c1":"0x..",');
    console.log('                                "f":10000, "t":200, "h":"0x.." } } }');
    console.log("");
    console.log("boyle bir dosyaniz yoksa PoolManager.Initialize olaylarini tarayarak");
    console.log("uretirsiniz; anahtarlar degismez oldugu icin tarama bir kez yapilir.");
    process.exit(1);
  }
  console.log("INDEKS DERLE");
  console.log("  kaynak " + kaynak + "  (" + say(Math.round(fs.statSync(kaynak).size / 1048576)) + " MB)");

  const j = JSON.parse(fs.readFileSync(kaynak, "utf8"));
  const h = j.havuzlar || j;
  const ids = Object.keys(h);
  console.log("  kayit  " + say(ids.length));

  /* Sorted by id so the reader can binary search. Sorting the hex strings is
   * the same order as sorting the raw bytes, because every id is the same
   * length and lowercase. */
  ids.sort();

  const coder = AbiCoder.defaultAbiCoder();
  const buf = Buffer.alloc(REC * ids.length);
  let yazilan = 0, eksik = 0, uyusmaz = 0;

  for (const id of ids) {
    const k = h[id];
    if (!k || !k.c0 || !k.c1 || k.f == null || k.t == null || !k.h) { eksik++; continue; }

    /* Every record is verified before it is written. The index is only worth
     * trusting if the key it stores actually hashes to the id it is filed
     * under — a wrong key would produce a confident, wrong quote, which is
     * worse than a slow one. This is a local keccak, so it costs nothing. */
    const enc = coder.encode(["tuple(address,address,uint24,int24,address)"],
      [[k.c0, k.c1, Number(k.f), Number(k.t), k.h]]);
    if (keccak256(enc).toLowerCase() !== String(id).toLowerCase()) { uyusmaz++; continue; }

    const o = yazilan * REC;
    hexBuf(id, 32).copy(buf, o);
    hexBuf(k.c0, 20).copy(buf, o + 32);
    hexBuf(k.c1, 20).copy(buf, o + 52);
    buf.writeUInt32BE(Number(k.f) >>> 0, o + 72);
    buf.writeInt32BE(Number(k.t) | 0, o + 76);
    hexBuf(k.h, 20).copy(buf, o + 80);
    yazilan++;
  }

  fs.mkdirSync(path.dirname(cikti), { recursive: true });
  const tmp = cikti + ".tmp";
  fs.writeFileSync(tmp, buf.subarray(0, yazilan * REC));
  fs.renameSync(tmp, cikti);

  console.log("");
  console.log("  yazildi    " + say(yazilan));
  console.log("  eksik alan " + say(eksik));
  console.log("  hash uyusmazligi " + say(uyusmaz) + (uyusmaz ? "   <-- atlandi" : ""));
  console.log("  dosya      " + cikti + "  (" + say(Math.round(yazilan * REC / 1048576)) + " MB)");
  console.log("");
  console.log("  servise baglamak icin:  ARC_POOL_INDEX=" + cikti);
}

main();
