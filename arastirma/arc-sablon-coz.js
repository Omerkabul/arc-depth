"use strict";
/* ===========================================================================
 * arc-sablon-coz.js — Arc'in hooklarinin %98'ini olusturan tek sablonu coz.
 *
 *   node arc-sablon-coz.js
 *
 * NEDEN VAR: arc-hook-parmakizi.js once "160 bin hook, 160 bin farkli kod"
 * dedi. Yanlisti. Baytkod hashi her dagitimi farkli gosteriyor cunku
 * immutable degerler kodun icine gomuluyor. Boyuta bakinca gercek cikti:
 * uzun kuyruktaki 150 hookun 148'i TAM 5.175 bayt — yani tek bir program.
 *
 * O program ne yapiyor? Cevap, Arc'ta bir token almadan once bilinmesi
 * gereken seyin ta kendisi: hook satisi engelleyebilir, vergi alabilir,
 * ucreti swap aninda belirleyebilir.
 *
 * YONTEM: baytkoddan fonksiyon seciciler cikarilir. Solidity dispatcher'i
 * seciciyi PUSH4 ile yukleyip karsilastirir, yani `63xxxxxxxx` kaliplari
 * neredeyse her zaman gercek secicilerdir. Bilinen imzalarla eslestirilir.
 *
 * NE IDDIA ETMIYOR: seciciler fonksiyonun VARLIGINI gosterir, davranisini
 * degil. "transfer var" demek "vergi aliyor" demek degildir. Davranis
 * ancak calistirarak olculur — ve o arc-depth servisinin isidir.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { keccak256 } = require("ethers");
const Z = require(path.join("C:", "arc-depth", "src", "zincir.js"));

const INDEKS = process.env.ARC_HAVUZ_INDEKSI || path.join(__dirname, "arc-havuzlar.json");
const HEDEF_BOYUT = Number(process.env.SABLON_BOYUT || 5175);
const CIKTI = path.join(__dirname, "arc-sablon.json");

/* v4 hook arayuzu + yaygin ERC20/sahiplik/vergi imzalari. Eslesmeyen
 * seciciler "bilinmeyen" olarak sayilir ve gizlenmez — bir sablonun
 * anlamadigimiz kismi, anladigimiz kismi kadar onemlidir. */
const IMZALAR = [
  "beforeInitialize(address,(address,address,uint24,int24,address),uint160)",
  "afterInitialize(address,(address,address,uint24,int24,address),uint160,int24)",
  "beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)",
  "afterAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)",
  "beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)",
  "afterRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)",
  "beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)",
  "afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)",
  "beforeDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)",
  "afterDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)",
  "getHookPermissions()",
  "poolManager()",
  "owner()", "transferOwnership(address)", "renounceOwnership()",
  "name()", "symbol()", "decimals()", "totalSupply()",
  "balanceOf(address)", "transfer(address,uint256)", "transferFrom(address,address,uint256)",
  "approve(address,uint256)", "allowance(address,address)",
  "buyTax()", "sellTax()", "setTax(uint256,uint256)", "fee()", "setFee(uint24)",
  "paused()", "pause()", "unpause()",
  "blacklist(address)", "isBlacklisted(address)",
  "claim()", "claimable(address)", "treasury()", "creator()",
  "swapFee()", "totalFee()", "withdraw()", "initialize()", "locked()"
];
const SOZLUK = new Map();
for (const s of IMZALAR) SOZLUK.set("0x" + keccak256(Buffer.from(s)).slice(2, 10), s);

const say = (n) => n.toLocaleString("en-US");

(async function main() {
  const H = JSON.parse(fs.readFileSync(INDEKS, "utf8")).havuzlar;
  const hookHavuz = new Map();
  for (const id of Object.keys(H)) {
    const h = H[id].h.toLowerCase();
    if (/^0x0{40}$/.test(h)) continue;
    hookHavuz.set(h, (hookHavuz.get(h) || 0) + 1);
  }
  const hooklar = [...hookHavuz.entries()].sort((a, b) => b[1] - a[1]);
  console.log("ARC SABLON HOOK COZUMLEMESI");
  console.log("  hedef kod boyutu : " + say(HEDEF_BOYUT) + " bayt");

  /* Hedef boyutta bir ornek bul. Uzun kuyruktan basliyoruz cunku sablon
   * orada yogun; en ustteki hooklar gercek protokoller. */
  let ornekAdres = null, ornekKod = null, bakilan = 0;
  const adim = Math.max(1, Math.floor((hooklar.length - 200) / 60));
  for (let i = 200; i < hooklar.length && !ornekAdres; i += adim) {
    const a = hooklar[i][0];
    bakilan++;
    let kod;
    try { kod = await Z.rpcRetry("eth_getCode", [a, "latest"]); } catch (e) { continue; }
    if (!kod || kod === "0x") continue;
    if ((kod.length - 2) / 2 === HEDEF_BOYUT) { ornekAdres = a; ornekKod = kod; }
  }
  if (!ornekAdres) { console.log("  " + bakilan + " adrese bakildi, hedef boyutta ornek bulunamadi."); return; }

  console.log("  ornek adres      : " + ornekAdres + "   (" + bakilan + " adreste bulundu)");
  console.log("");

  /* ---- secici cikarimi --------------------------------------------------
   * PUSH4 (0x63) + 4 bayt. Rastgele veri de bu kalibi uretebilir, bu yuzden
   * sayim ham degil: eslesen/eslesmeyen ayri raporlanir. */
  const kod = ornekKod.slice(2);
  const bulunan = new Set();
  for (let i = 0; i + 10 <= kod.length; i += 2) {
    if (kod.slice(i, i + 2) !== "63") continue;
    bulunan.add("0x" + kod.slice(i + 2, i + 10));
  }

  const eslesen = [], bilinmeyen = [];
  for (const s of bulunan) (SOZLUK.has(s) ? eslesen : bilinmeyen).push(s);

  console.log("BULUNAN FONKSIYONLAR  (PUSH4 kaliplarindan)");
  console.log("  aday secici      " + bulunan.size + "   taninan " + eslesen.length +
              "   taninmayan " + bilinmeyen.length);
  console.log("");
  const v4 = eslesen.filter((s) => /^(before|after)|getHookPermissions|poolManager/.test(SOZLUK.get(s)));
  const digerler = eslesen.filter((s) => !v4.includes(s));
  console.log("  v4 hook arayuzu:");
  if (!v4.length) console.log("    (hicbiri)");
  for (const s of v4) console.log("    " + s + "  " + SOZLUK.get(s).split("(")[0]);
  console.log("");
  console.log("  digerleri:");
  if (!digerler.length) console.log("    (hicbiri)");
  for (const s of digerler) console.log("    " + s + "  " + SOZLUK.get(s));

  /* ---- bu sablon kac havuzu yonetiyor ----------------------------------
   * Ornekleme ile tahmin: uzun kuyrukta %98.7 oraninda gorulduyse, uzun
   * kuyruktaki havuzlarin o kadarini yonetiyor demektir. Bu bir TAHMIN ve
   * oyle etiketlenir — her hooku okumak binlerce cagri eder. */
  const ustHavuz = hooklar.slice(0, 200).reduce((a, b) => a + b[1], 0);
  const kuyrukHavuz = hooklar.slice(200).reduce((a, b) => a + b[1], 0);
  console.log("");
  console.log("KAPSAM TAHMINI");
  console.log("  en yogun 200 hook  " + say(ustHavuz).padStart(8) + " havuz  (gercek protokoller, ayri kodlar)");
  console.log("  uzun kuyruk        " + say(kuyrukHavuz).padStart(8) + " havuz  (" + say(hooklar.length - 200) + " adres)");
  console.log("  -> orneklemde uzun kuyrugun %98.7'si bu sablon. Dogruysa bu tek");
  console.log("     program yaklasik " + say(Math.round(kuyrukHavuz * 0.987)) + " havuzu yonetiyor.");
  console.log("     Bu bir TAHMIN: 150 hookluk ornekten genelleme.");

  fs.writeFileSync(CIKTI, JSON.stringify({
    zaman: new Date().toISOString(),
    hedefBoyut: HEDEF_BOYUT, ornekAdres,
    kodHash: keccak256(ornekKod),
    adaySecici: bulunan.size,
    taninan: eslesen.map((s) => ({ secici: s, imza: SOZLUK.get(s) })),
    taninmayanSayisi: bilinmeyen.length,
    taninmayan: bilinmeyen.slice(0, 40),
    ustHavuz, kuyrukHavuz,
    tahminiKapsam: Math.round(kuyrukHavuz * 0.987)
  }, null, 2));
  console.log("\n  yazildi " + CIKTI);
  console.log("\n  SINIR: secici VARLIK gosterir, DAVRANIS degil. Bir fonksiyonun");
  console.log("  bulunmasi onun calistirildigi anlamina gelmez.");
})().catch((e) => { console.log("\nHATA: " + (e && e.message)); process.exit(1); });
