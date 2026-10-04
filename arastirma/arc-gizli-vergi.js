"use strict";
/* ===========================================================================
 * arc-gizli-vergi.js — ilan edilen ucret, gercek maliyet mi?
 *
 *   node arc-gizli-vergi.js [--adet 24]
 *
 * NEDEN VAR: Arc'in hooklu havuzlarinin tahminen %93'u tek bir sablondan
 * geliyor ve o sablonda `afterSwap` ile `treasury()` var. Yani her takastan
 * sonra calisip bir hazineye pay gonderen bir kod. Eger oyleyse, havuzun
 * ilan ettigi ucret gercek maliyeti ANLATMIYOR.
 *
 * Bu test edilebilir. Bir gidis-donusun (al + sat) teorik alt siniri iki
 * bacagin ucretidir. Fiyat etkisi kucuk tutulursa, olculen maliyet ile
 * 2x ucret arasindaki fark hookun aldigi paydir.
 *
 *   fazla = olculenGidisDonus - 2 * ilanEdilenUcret
 *
 * KONTROL GRUBU sart: hooksuz havuzlarda ayni fark olculur. Orada da buyuk
 * cikiyorsa sebep hook degil, fiyat etkisi ya da olcum hatasidir. Kontrolsuz
 * tek kohort, kendi hipotezini dogrulamaktan baska bir sey yapmaz.
 *
 * NE IDDIA ETMIYOR: "bu havuzlar dolandiricilik." Vergi aciklanmis ve mesru
 * olabilir. Iddia yalnizca sudur: ucret alani gercek maliyeti gostermiyor,
 * dolayisiyla ucrete bakip karar vermek yaniltici.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const Z = require(path.join("C:", "arc-depth", "src", "zincir.js"));
const Hv = require(path.join("C:", "arc-depth", "src", "havuz.js"));

const INDEKS = process.env.ARC_HAVUZ_INDEKSI || path.join(__dirname, "arc-havuzlar.json");
const USDC = "0x3600000000000000000000000000000000000000";
const DINAMIK = 8388608;
const arg = process.argv.slice(2);
const ai = arg.indexOf("--adet");
const ADET = ai >= 0 ? Number(arg[ai + 1]) : 24;
const BOYUT = 5;                       /* USDC; kucuk tutuluyor ki fiyat etkisi bastirmasin */

const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (x) => (x == null ? "-" : x.toFixed(2));

(async function main() {
  const H = JSON.parse(fs.readFileSync(INDEKS, "utf8")).havuzlar;
  const ids = Object.keys(H);

  /* Iki kohort: hooklu ve hooksuz. Ikisi de USDC'li ve standart ucretli
   * olmali ki tek degisken hook olsun. Dinamik ucretliler disarida: onlarin
   * ilan edilen ucreti zaten yok. */
  const hookluL = [], hooksuzL = [];
  for (const id of ids) {
    const k = H[id];
    if (k.f === DINAMIK) continue;
    const usdcVar = k.c0.toLowerCase() === USDC || k.c1.toLowerCase() === USDC;
    if (!usdcVar) continue;
    if (k.f > 30000) continue;                 /* %3 ustu: tuzak havuzlar ayri konu */
    const hooksuz = /^0x0{40}$/.test(k.h.toLowerCase());
    (hooksuz ? hooksuzL : hookluL).push({ id, k });
  }
  /* Ilk surum en yeni havuzlari seciyordu ve 165 adayin 165i basarisiz
   * oldu: yeni dogan havuzlarin cogunda likidite yok, kota geri donuyor.
   * "Yeni" ile "canli" ayni sey degil.
   *
   * Yas araligina yayilmis ornekleme daha iyi: eski havuzlar hayatta
   * kalmis olanlardir ve likidite tasima ihtimalleri yuksektir. Yine de
   * bu bir vekil — indekste likidite yok, dolayisiyla "bu havuz canli"
   * diye bilemiyoruz, yalnizca ihtimali artiriyoruz. */
  const yay = (L) => {
    const s = L.slice().sort((a, b) => a.k.b - b.k.b);
    const n = Math.min(ADET * 12, s.length);
    const adim = Math.max(1, Math.floor(s.length / Math.max(n, 1)));
    const c = [];
    for (let i = 0; i < s.length && c.length < n; i += adim) c.push(s[i]);
    return c;
  };
  const A = yay(hookluL), B = yay(hooksuzL);
  console.log("GIZLI VERGI TESTI   (boyut " + BOYUT + " USDC)");
  console.log("  aday havuz: hooklu " + A.length + "   hooksuz " + B.length);
  console.log("");

  async function kohort(liste, ad) {
    const fazlalar = [], ucretler = [], gidisDonusler = [];
    let olculen = 0, basarisiz = 0;
    const blok = await Z.blockNumber();
    for (const { id, k } of liste) {
      if (olculen >= ADET) break;
      const key = { poolId: id, currency0: k.c0, currency1: k.c1, fee: k.f, tickSpacing: k.t, hooks: k.h };
      let rt;
      try { rt = await Hv.roundTrip(key, BOYUT, blok); }
      catch (e) { basarisiz++; continue; }
      if (!rt || rt.status !== "MEASURED" || rt.roundTripBps == null) { basarisiz++; continue; }
      olculen++;
      const ucretBps = (k.f / 10000) * 100;          /* f=10000 -> %1 -> 100 bps */
      const gd = rt.roundTripBps;
      fazlalar.push(gd - 2 * ucretBps);
      ucretler.push(ucretBps);
      gidisDonusler.push(gd);
    }
    console.log("  " + ad);
    console.log("    olculen havuz        " + olculen + "   (basarisiz " + basarisiz + ")");
    if (!olculen) { console.log("    (sonuc yok)"); return null; }
    console.log("    medyan ilan ucret    " + f2(med(ucretler) / 100) + "%  (iki bacak " + f2(2 * med(ucretler) / 100) + "%)");
    console.log("    medyan gidis-donus   " + f2(med(gidisDonusler) / 100) + "%");
    console.log("    medyan FAZLA         " + f2(med(fazlalar) / 100) + "%   <- ucretle aciklanmayan kisim");
    return { olculen, fazla: med(fazlalar), gd: med(gidisDonusler), ucret: med(ucretler) };
  }

  const hk = await kohort(A, "HOOKLU");
  console.log("");
  const hs = await kohort(B, "HOOKSUZ (kontrol)");

  console.log("");
  console.log("OKUMA");
  if (!hk || !hs) {
    console.log("  Iki kohorttan biri olculemedi; karsilastirma yapilamaz.");
    console.log("  Tek kohortla sonuc bildirmek, kontrolsuz iddia olurdu.");
    return;
  }
  const fark = (hk.fazla - hs.fazla) / 100;
  console.log("  hooklu fazla   " + f2(hk.fazla / 100) + "%");
  console.log("  hooksuz fazla  " + f2(hs.fazla / 100) + "%   (kontrol)");
  console.log("  aradaki fark   " + f2(fark) + " puan");
  console.log("");
  if (fark > 1) {
    console.log("  Hooksuz havuzlarda ucretle aciklanmayan kisim kucuk, hooklu");
    console.log("  havuzlarda buyuk. Fark hookun aldigi pay. Yani Arc'ta bir");
    console.log("  havuzun ucret alanina bakip maliyeti hesaplamak YANLIS sonuc");
    console.log("  verir; gercek maliyet ancak hooku da calistiran bir kota ile");
    console.log("  olculur. arc-depth tam bunu yapiyor.");
  } else {
    console.log("  Iki kohort benzer. Yani fazla maliyet hooktan gelmiyor —");
    console.log("  fiyat etkisi ya da olcum yontemiyle aciklaniyor. Gizli vergi");
    console.log("  hipotezi bu orneklemde DOGRULANMADI.");
  }
  console.log("");
  console.log("  SINIR: orneklem kucuk ve yalnizca " + BOYUT + " USDC boyutunda. Buyuk");
  console.log("  islemlerde fiyat etkisi baskin hale gelir ve bu ayrim bulanir.");
})().catch((e) => { console.log("\nHATA: " + (e && e.message)); process.exit(1); });
