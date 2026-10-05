"use strict";
/* ===========================================================================
 * doldur.js — write PoolKeys into the on-chain registry
 *
 *   node contracts/doldur.js                      # dry run, costs nothing
 *   node contracts/doldur.js --uygula --butce 1.5 # spend at most 1.5 USDC
 *
 * WHAT THIS IS FOR
 *   A v4 pool id is keccak(PoolKey) and is not reversible, so anyone holding
 *   an id and nothing else must recover the key from the Initialize event
 *   that created the pool — a binary search for the creation block and a log
 *   scan, measured at 45 seconds. The registry turns that into one eth_call,
 *   for everyone, permanently. A key only has to be read from the chain once
 *   in the history of the chain.
 *
 * WHICH POOLS
 *   Not all of them. Arc has 216,839 v4 pools and most are dead launches
 *   nobody will ever quote; writing every key would cost around 173 USDC at
 *   the gas price measured here. The input is therefore a list of pools that
 *   actually trade — see arastirma/aktif-havuz-topla.js.
 *
 * SAFETY
 *   - Dry run by default. Nothing is sent without --uygula.
 *   - A hard budget ceiling in USDC. The run stops before the batch that
 *     would cross it, rather than after.
 *   - Every key is hashed locally and checked against its pool id before it
 *     is sent. The contract derives the id from the key anyway, so a wrong
 *     key cannot corrupt an existing entry — but it would waste gas storing
 *     a key for a pool id nobody asked about.
 *   - registerMany skips ids already present, so re-running is safe and
 *     cheap rather than a double charge.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { Wallet, JsonRpcProvider, Contract, AbiCoder, keccak256 } = require("ethers");
const Z = require("../src/zincir.js");
const H = require("../src/havuz.js");
const ART = require("./PoolKeyRegistry.json");

const arg = process.argv.slice(2);
const has = (f) => arg.indexOf(f) >= 0;
const val = (f, d) => { const i = arg.indexOf(f); return i >= 0 ? arg[i + 1] : d; };

const UYGULA = has("--uygula");
const BUTCE = Number(val("--butce", 1.0));            /* USDC ceiling */
const PARTI = Number(val("--parti", 150));            /* keys per transaction */
const KAYNAK = val("--kaynak", path.join(__dirname, "..", "data", "aktif-havuzlar.json"));
const LIMIT = Number(val("--limit", 0));              /* 0 = all of them */

const say = (n) => n.toLocaleString("en-US");
const coder = AbiCoder.defaultAbiCoder();

function anahtarKimligi(k) {
  return keccak256(coder.encode(["tuple(address,address,uint24,int24,address)"],
    [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])).toLowerCase();
}

function ozelAnahtar() {
  if (process.env.TRADER_PRIVATE_KEY) return process.env.TRADER_PRIVATE_KEY.trim();
  for (const f of [path.join("C:", "bot", ".env"), path.join(__dirname, "..", ".env")]) {
    try {
      const m = fs.readFileSync(f, "utf8").match(/^TRADER_PRIVATE_KEY\s*=\s*(.+)$/m);
      if (m) return m[1].trim();
    } catch (e) { /* next */ }
  }
  return null;
}

(async function main() {
  console.log("KAYIT DEFTERINI DOLDUR");
  console.log("  kontrat " + Z.ARC.registry);
  console.log("  kip     " + (UYGULA ? "UYGULA (gercek islem)" : "KURU CALISMA (hicbir sey gonderilmez)"));
  console.log("  butce   " + BUTCE.toFixed(4) + " USDC");
  console.log("");

  if (!fs.existsSync(KAYNAK)) {
    console.log("kaynak bulunamadi: " + KAYNAK);
    console.log("once: node arastirma/aktif-havuz-topla.js");
    process.exit(1);
  }
  let liste = JSON.parse(fs.readFileSync(KAYNAK, "utf8"));
  liste = (liste.pools || liste).map((p) => (typeof p === "string" ? { poolId: p } : p));
  if (LIMIT > 0) liste = liste.slice(0, LIMIT);
  console.log("  aday havuz " + say(liste.length));

  /* Resolve every key locally. A pool whose key we cannot produce without
   * going to the chain is skipped rather than looked up one at a time:
   * filling the registry is a bulk job and should not itself cost 45 s a
   * pool. */
  const anahtarlar = [];
  let cozulemedi = 0, uyusmaz = 0;
  for (const p of liste) {
    const k = H.localIndexLookup(p.poolId);
    if (!k) { cozulemedi++; continue; }
    if (anahtarKimligi(k) !== String(p.poolId).toLowerCase()) { uyusmaz++; continue; }
    anahtarlar.push({ poolId: p.poolId, key: k });
  }
  console.log("  yerel indeksten cozuldu " + say(anahtarlar.length));
  if (cozulemedi) console.log("  indekste yok            " + say(cozulemedi));
  if (uyusmaz) console.log("  hash uyusmazligi        " + say(uyusmaz) + "   <-- atlandi");
  if (!anahtarlar.length) { console.log("\nyazilacak anahtar yok."); return; }

  const oncekiToplam = BigInt(await Z.rpcRetry("eth_call", [{ to: Z.ARC.registry, data: "0x2ddbd13a" }]));
  console.log("  defterde su an          " + say(Number(oncekiToplam)));
  console.log("");

  const pk = ozelAnahtar();
  if (UYGULA && !pk) { console.log("TRADER_PRIVATE_KEY bulunamadi, gonderim yapilamaz."); process.exit(1); }

  const saglayici = new JsonRpcProvider(Z.ARC.rpc, { chainId: 5042, name: "arc" }, { staticNetwork: true });
  const cuzdan = pk ? new Wallet(pk, saglayici) : null;
  const reg = new Contract(Z.ARC.registry, ART.abi, cuzdan || saglayici);

  if (cuzdan) {
    const bakiye = BigInt(await Z.rpcRetry("eth_getBalance", [cuzdan.address, "latest"]));
    console.log("  cuzdan  " + cuzdan.address);
    console.log("  bakiye  " + (Number(bakiye) / 1e18).toFixed(6) + " USDC");
    console.log("");
  }

  const partiler = [];
  for (let i = 0; i < anahtarlar.length; i += PARTI) partiler.push(anahtarlar.slice(i, i + PARTI));

  let harcanan = 0, yazilan = 0, gonderilen = 0;
  for (let i = 0; i < partiler.length; i++) {
    const b = partiler[i];
    const tuples = b.map((x) => [x.key.currency0, x.key.currency1, x.key.fee, x.key.tickSpacing, x.key.hooks]);

    let gas;
    try {
      gas = await reg.registerMany.estimateGas(tuples, cuzdan ? { from: cuzdan.address } : {});
    } catch (e) {
      console.log("  parti " + (i + 1) + ": gas tahmini basarisiz, atlandi (" + String(e.message).slice(0, 60) + ")");
      continue;
    }
    const gasPrice = BigInt(await Z.rpcRetry("eth_gasPrice", []));
    const maliyet = Number(gas * gasPrice) / 1e18;

    if (harcanan + maliyet > BUTCE) {
      console.log("  parti " + (i + 1) + ": " + maliyet.toFixed(4) + " USDC butceyi asardi " +
        "(" + harcanan.toFixed(4) + " + " + maliyet.toFixed(4) + " > " + BUTCE.toFixed(4) + "), DURDURULDU");
      break;
    }

    if (!UYGULA) {
      harcanan += maliyet; yazilan += b.length;
      console.log("  parti " + String(i + 1).padStart(3) + "  " + String(b.length).padStart(4) +
        " anahtar  gas " + say(Number(gas)).padStart(10) + "  " + maliyet.toFixed(5) + " USDC  (kuru)");
      continue;
    }

    const tx = await reg.registerMany(tuples, { gasLimit: (gas * 12n) / 10n });
    const rc = await tx.wait();
    const gercek = Number(BigInt(rc.gasUsed) * BigInt(rc.gasPrice || gasPrice)) / 1e18;
    harcanan += gercek; yazilan += b.length; gonderilen++;
    console.log("  parti " + String(i + 1).padStart(3) + "  " + String(b.length).padStart(4) +
      " anahtar  gas " + say(Number(rc.gasUsed)).padStart(10) + "  " + gercek.toFixed(5) +
      " USDC  blok " + rc.blockNumber);
  }

  console.log("");
  const sonrakiToplam = BigInt(await Z.rpcRetry("eth_call", [{ to: Z.ARC.registry, data: "0x2ddbd13a" }]));
  console.log("SONUC");
  console.log("  islem        " + gonderilen);
  console.log("  anahtar      " + say(yazilan));
  console.log("  harcanan     " + harcanan.toFixed(5) + " USDC" + (UYGULA ? "" : "  (tahmin, hicbir sey gonderilmedi)"));
  if (yazilan) console.log("  anahtar basi " + (harcanan / yazilan).toFixed(6) + " USDC");
  console.log("  defter       " + say(Number(oncekiToplam)) + " -> " + say(Number(sonrakiToplam)) +
    "   (+" + say(Number(sonrakiToplam - oncekiToplam)) + ")");
  if (!UYGULA) console.log("\n  gercekten yazmak icin: --uygula");
})().catch((e) => { console.log("\nHATA: " + (e && e.message)); process.exit(1); });
