"use strict";
/* kontrol.js — prove the COMPILED contract agrees with the real chain.
 *
 *   node contracts/kontrol.js
 *
 * The question this answers is not "does my reasoning about abi.encode look
 * right". It is "does this exact bytecode, run by Arc's own EVM, return the
 * poolIds that Arc's PoolManager actually assigned". Those are different
 * questions and only the second one matters.
 *
 * It is answered without deploying anything, by using eth_call's state
 * override to place the contract's runtime code at a throwaway address for the
 * duration of one call. No transaction, no gas, no key. If the node does not
 * support state overrides the check says so plainly instead of passing
 * vacuously — a test that cannot run must never report success.
 */

const fs = require("fs");
const path = require("path");
const { AbiCoder, keccak256 } = require("ethers");
/* The RPC layer is reused, not rewritten. The first version of this file had
 * its own bare https call and promptly failed two of eight checks with HTTP
 * 429 — the same rate-limit mistake src/zincir.js already fixes with an
 * exponential backoff and a separate retry budget. Duplicating a transport is
 * how a fix stops applying to the code written after it. */
const Z = require("../src/zincir.js");

const RPC = Z.ARC.rpc;
const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "PoolKeyRegistry.json"), "utf8"));
/* Known-good (poolId, PoolKey) pairs, committed to the repository.
 *
 * The first version read data/poolkeys.json, which is the service's runtime
 * cache — disposable by design and gitignored. So this check crashed with
 * ENOENT on a fresh clone, which is precisely where someone evaluating the
 * project runs it. A verification that only works on the machine that wrote
 * the cache verifies nothing for anyone else.
 *
 * These eight pairs are public on-chain facts read from PoolManager.Initialize
 * events. They are a fixture, not a cache: the fee tiers span 1% to 90% on
 * purpose, because a mis-sized or reordered field shows up at the extremes. */
const FIXTURE = path.join(__dirname, "test-havuzlari.json");
const ANAHTARLAR = (() => {
  try { return JSON.parse(fs.readFileSync(FIXTURE, "utf8")); }
  catch (e) {
    console.log("contracts/test-havuzlari.json okunamadi: " + e.message);
    console.log("Bu dosya depoya islenmis olmali; onsuz hash dogrulamasi yapilamaz.");
    process.exit(1);
  }
})();

/* An address with no code and no balance on Arc. Only used as the slot the
 * override writes code into; nothing is ever sent to it. */
const SAHTE = "0x00000000000000000000000000000000000d3b71";

const coder = AbiCoder.defaultAbiCoder();
const SEL_idOf = "0x" + keccak256(Buffer.from("idOf((address,address,uint24,int24,address))")).slice(2, 10);
const SEL_total = "0x" + keccak256(Buffer.from("total()")).slice(2, 10);
const SEL_get = "0x" + keccak256(Buffer.from("get(bytes32)")).slice(2, 10);

const rpc = (method, params) => Z.rpcRetry(method, params);

let basarisiz = 0, atlanan = 0;
const satir = (ok, ad, ek) => console.log("  " + (ok === null ? "ATLA" : ok ? "GECTI" : "HATA") +
  "  " + ad + (ek ? "   " + ek : ""));
const kontrol = (ok, ad, ek) => { if (ok === false) basarisiz++; if (ok === null) atlanan++; satir(ok, ad, ek); };

/* A throttled RPC is not a failed check. Same reasoning as src/kontrol.js:
 * calling a closed rate-limit window a failure tells the reader the code is
 * broken when it is not, while still saying plainly it went unverified. */
const rateLimit = (e) => !!(e && (e.rateLimited || e.httpStatus === 429 ||
  /(429|503)|rate.?limit|too many requests/i.test(String(e.message || e))));
const checkE = (e, ad, ek) => {
  if (rateLimit(e)) { atlanan++; satir(null, ad, "RPC hiz siniri, dogrulanamadi"); return; }
  basarisiz++; satir(false, ad, ek);
};

async function main() {
  console.log("PoolKeyRegistry — derlenmis kod, Arc'in kendi EVM'inde");
  console.log("  rpc   " + RPC);
  console.log("  solc  " + ART.solc);
  console.log("  kod   " + ((ART.deployedBytecode.length - 2) / 2) + " bayt");

  /* ---- 1. state override destekleniyor mu ------------------------------- */
  console.log("\n1) state override destegi");
  const over = { [SAHTE]: { code: ART.deployedBytecode } };
  let destek = false;
  try {
    const r = await rpc("eth_call", [{ to: SAHTE, data: SEL_total }, "latest", over]);
    /* A fresh contract's `total` must be exactly zero. If the node ignored the
     * override we would get "0x" from an empty account instead, which is why
     * the value is checked and not merely the absence of an error. */
    destek = /^0x0{64}$/.test(r);
    kontrol(destek, "override ile total() = 0", destek ? "" : "beklenmeyen yanit: " + String(r).slice(0, 40));
  } catch (e) {
    kontrol(null, "override desteklenmiyor", (e.code ? "kod " + e.code + " " : "") + e.message.slice(0, 60));
  }

  if (!destek) {
    console.log("\n   Bu dugum state override vermiyor, dolayisiyla derlenmis kod");
    console.log("   zincir uzerinde calistirilamadi. Asagidaki hash karsilastirmasi");
    console.log("   yine yapiliyor ama YEREL bir referans coder ile — yani solc'un");
    console.log("   ayni sonucu verdigi ZINCIRDE DOGRULANMADI. Kesin kanit icin");
    console.log("   kontratin dagitilmasi ve idOf'un cagrilmasi gerekir.");
  }

  /* ---- 2. idOf, gercek Arc havuzlarinin kimlikleri ---------------------- */
  console.log("\n2) idOf, gercek Arc havuz kimlikleriyle  (n=" + Object.keys(ANAHTARLAR).length + ")");
  for (const [id, k] of Object.entries(ANAHTARLAR)) {
    const arg = coder.encode(["address", "address", "uint24", "int24", "address"],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]);
    const yerel = keccak256(arg);
    const etiket = "fee " + String(k.fee).padStart(6) + "  ts " + String(k.tickSpacing).padStart(5);

    if (destek) {
      let zincir;
      try {
        zincir = await rpc("eth_call", [{ to: SAHTE, data: SEL_idOf + arg.slice(2) }, "latest", over]);
      } catch (e) {
        kontrol(false, etiket, "eth_call hata: " + e.message.slice(0, 50));
        continue;
      }
      const uyum = zincir.toLowerCase() === id.toLowerCase();
      kontrol(uyum, etiket, uyum ? "zincirdeki EVM poolId'yi birebir uretti"
        : "\n       PoolManager : " + id + "\n       kontrat     : " + zincir);
      /* The local coder is a second, independent witness. If solc and ethers
       * ever disagreed, that disagreement is itself the bug and must surface. */
      if (uyum && yerel.toLowerCase() !== zincir.toLowerCase()) {
        kontrol(false, "  yerel coder ayrisiyor", yerel);
      }
    } else {
      const uyum = yerel.toLowerCase() === id.toLowerCase();
      kontrol(uyum, etiket, uyum ? "yerel coder eslesti (zincirde dogrulanmadi)"
        : "\n       beklenen " + id + "\n       hesaplanan " + yerel);
    }
  }

  /* ---- 3. the DEPLOYED contract ---------------------------------------- */
  console.log("\n3) dagitilmis kontrat  " + Z.ARC.registry);
  try {
    const kod = await rpc("eth_getCode", [Z.ARC.registry, "latest"]);
    const uyum = String(kod).toLowerCase() === ART.deployedBytecode.toLowerCase();
    kontrol(uyum, "zincirdeki kod derlenenle ayni",
      uyum ? ((kod.length - 2) / 2) + " bayt" : "zincir " + ((String(kod).length - 2) / 2) +
        " bayt, beklenen " + ((ART.deployedBytecode.length - 2) / 2));

    const t = await rpc("eth_call", [{ to: Z.ARC.registry, data: SEL_total }]);
    const kayitli = Number(BigInt(t));
    kontrol(kayitli > 0, "total()", kayitli + " havuz kayitli");

    /* Every fixture id is asked of the live contract and compared with the
     * fixture, so this fails if the registry ever returned a wrong key — the
     * one thing the contract is supposed to make impossible. */
    let dogru = 0, sorulan = 0;
    for (const [id, k] of Object.entries(ANAHTARLAR)) {
      sorulan++;
      const r = await rpc("eth_call", [{ to: Z.ARC.registry, data: SEL_get + id.slice(2) }]);
      const dd = String(r).slice(2);
      const w = (i) => dd.slice(i * 64, (i + 1) * 64);
      if (BigInt("0x" + w(0)) === 0n) continue;             /* not registered yet */
      const i24 = (h) => { const v = BigInt("0x" + h); return v >= (1n << 23n) ? Number(v - (1n << 24n)) : Number(v); };
      if (("0x" + w(1).slice(24)).toLowerCase() === k.currency0.toLowerCase()
        && ("0x" + w(2).slice(24)).toLowerCase() === k.currency1.toLowerCase()
        && Number(BigInt("0x" + w(3))) === k.fee
        && i24(w(4)) === k.tickSpacing
        && ("0x" + w(5).slice(24)).toLowerCase() === k.hooks.toLowerCase()) dogru++;
    }
    kontrol(dogru === sorulan, "get() geri okuma", dogru + "/" + sorulan + " anahtar dogru");

    /* An id nobody registered must answer found == false, not revert. */
    const bos = await rpc("eth_call", [{ to: Z.ARC.registry, data: SEL_get + "cd".repeat(32) }]);
    const bulundu = BigInt("0x" + String(bos).slice(2, 66)) !== 0n;
    kontrol(!bulundu, "bilinmeyen kimlik", "found = false, revert yok");
  } catch (e) {
    checkE(e, "dagitilmis kontrat", String(e.message).slice(0, 60));
  }

  console.log("\n" + (basarisiz ? basarisiz + " KONTROL BASARISIZ"
    : atlanan ? "basarisiz yok, " + atlanan + " kontrol calistirilamadi"
    : "tum kontroller gecti"));
  process.exit(basarisiz ? 1 : 0);
}

main().catch((e) => { console.log("\nbeklenmeyen hata: " + (e && e.message)); process.exit(1); });
