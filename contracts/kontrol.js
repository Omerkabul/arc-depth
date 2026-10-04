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
const ANAHTARLAR = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "poolkeys.json"), "utf8"));

/* An address with no code and no balance on Arc. Only used as the slot the
 * override writes code into; nothing is ever sent to it. */
const SAHTE = "0x00000000000000000000000000000000000d3b71";

const coder = AbiCoder.defaultAbiCoder();
const SEL_idOf = "0x" + keccak256(Buffer.from("idOf((address,address,uint24,int24,address))")).slice(2, 10);
const SEL_total = "0x" + keccak256(Buffer.from("total()")).slice(2, 10);

const rpc = (method, params) => Z.rpcRetry(method, params);

let basarisiz = 0, atlanan = 0;
const satir = (ok, ad, ek) => console.log("  " + (ok === null ? "ATLA" : ok ? "GECTI" : "HATA") +
  "  " + ad + (ek ? "   " + ek : ""));
const kontrol = (ok, ad, ek) => { if (ok === false) basarisiz++; if (ok === null) atlanan++; satir(ok, ad, ek); };

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

  console.log("\n" + (basarisiz ? basarisiz + " KONTROL BASARISIZ"
    : atlanan ? "basarisiz yok, " + atlanan + " kontrol calistirilamadi"
    : "tum kontroller gecti"));
  process.exit(basarisiz ? 1 : 0);
}

main().catch((e) => { console.log("\nbeklenmeyen hata: " + (e && e.message)); process.exit(1); });
