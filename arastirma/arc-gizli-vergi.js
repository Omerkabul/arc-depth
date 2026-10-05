"use strict";
/* ===========================================================================
 * arc-gizli-vergi.js — ilan edilen ucret, gercek maliyet mi?
 *
 *   node arc-gizli-vergi.js [--adet 12] [--boyut 5]
 *
 * NEDEN VAR: Arc'in hooklu havuzlarinin tahminen %93'u tek bir sablondan
 * geliyor ve o sablonda `afterSwap` ile `treasury()` var — her takastan sonra
 * calisip bir hazineye pay gonderen bir kod. Oyleyse havuzun ilan ettigi
 * ucret gercek maliyeti ANLATMIYOR.
 *
 * Test: bir gidis-donusun (al + sat) teorik alt siniri iki bacagin ucretidir.
 *
 *   fazla = olculenGidisDonus - 2 * ilanEdilenUcret
 *
 * KONTROL GRUBU sart. Hooksuz havuzlarda da fazla buyukse sebep hook degil,
 * fiyat etkisi ya da olcum yontemidir. Kontrolsuz tek kohort, kendi
 * hipotezini dogrulamaktan baska bir sey yapmaz.
 *
 * ADAY SECIMI — iki basarisiz denemenin dersi:
 *   1. "En yeni havuzlar" denendi: 165 adayin 165'i kota veremedi.
 *   2. "Yas araligina yayilmis" denendi: 240'in 238'i kota veremedi.
 *   Sebep ayni: Arc havuzlarinin ezici cogunlugunda likidite yok ve indeks
 *   likidite tasimiyor, yani indeksten bakarak canli havuz secilemiyor.
 *
 * Bu surum adaylari GeckoTerminal'in hacim siralamasindan aliyor — yani
 * gercekten islem goren havuzlardan. Likidite bilgisi disaridan geliyor
 * cunku zincir indeksinde yok; vekil degil, dogrudan olcum.
 *
 * NE IDDIA ETMIYOR: "bu havuzlar dolandiricilik." Vergi aciklanmis ve mesru
 * olabilir. Iddia sudur: ucret alanina bakip maliyet hesaplamak yaniltici.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const https = require("https");
const Z = require(path.join("C:", "arc-depth", "src", "zincir.js"));
const Hv = require(path.join("C:", "arc-depth", "src", "havuz.js"));

const INDEKS = process.env.ARC_HAVUZ_INDEKSI || path.join(__dirname, "arc-havuzlar.json");
const DINAMIK = 8388608;
const GT = "api.geckoterminal.com";

const arg = process.argv.slice(2);
const sayi = (ad, v) => { const i = arg.indexOf(ad); return i >= 0 ? Number(arg[i + 1]) : v; };
const ADET = sayi("--adet", 12);
const BOYUT = sayi("--boyut", 5);

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (x) => (x == null ? "-" : x.toFixed(2));

function gt(yol) {
  return new Promise((coz, red) => {
    const r = https.get({ hostname: GT, path: yol, timeout: 25_000,
      headers: { accept: "application/json", "user-agent": "arc-depth-research" } }, (y) => {
      let s = ""; y.on("data", (d) => { s += d; });
      y.on("end", () => {
        if (y.statusCode !== 200) return red(Object.assign(new Error("HTTP " + y.statusCode), { http: y.statusCode }));
        try { coz(JSON.parse(s)); } catch (e) { red(new Error("JSON degil")); }
      });
    });
    r.on("timeout", () => { r.destroy(); red(new Error("zaman asimi")); });
    r.on("error", red);
  });
}

(async function main() {
  console.log("GIZLI VERGI TESTI   (boyut " + BOYUT + " USDC)");
  const H = JSON.parse(fs.readFileSync(INDEKS, "utf8")).havuzlar;

  /* ---- hacimli havuzlari topla ---------------------------------------- */
  const canli = [];
  const SAYFA = Number(process.env.GT_SAYFA || 6);
  for (let sayfa = 1; sayfa <= SAYFA; sayfa++) {
    let d;
    try { d = await gt("/api/v2/networks/arc/pools?page=" + sayfa); }
    catch (e) {
      if (e.http === 429) { console.log("  sayfa " + sayfa + " hiz siniri, 45sn..."); await bekle(45000);
        try { d = await gt("/api/v2/networks/arc/pools?page=" + sayfa); } catch (e2) { break; } }
      else break;
    }
    for (const p of (d && d.data) || []) {
      const adr = String(p.id || "").split("_").pop().toLowerCase();
      const a = p.attributes || {};
      const lik = Number(a.reserve_in_usd || 0);
      const hac = Number((a.volume_usd && a.volume_usd.h24) || 0);
      if (adr) canli.push({ adr, lik, hac });
    }
    await bekle(8000);
  }
  console.log("  GeckoTerminal'den " + canli.length + " hacimli havuz");
  if (!canli.length) { console.log("\n  Aday alinamadi, test calistirilamiyor."); return; }

  /* GT havuz adresi veriyor, indeks poolId ile anahtarli. Eslesme icin
   * indeksin tamamini adres bazli taramak gerekiyor — v4'te havuz adresi
   * yok, dolayisiyla GT'nin "adresi" aslinda poolId. */
  const hookluL = [], hooksuzL = [];
  for (const c of canli) {
    const k = H[c.adr] || H["0x" + c.adr.replace(/^0x/, "")];
    if (!k) continue;
    if (k.f === DINAMIK) continue;
    /* Ucret tavani: varsayilan %3. Hooksuz havuz likit nufusta nadir
     * oldugu icin kontrol grubunu buyutmek adina gevsetilebilir; tuzak
     * havuzlari (>%50) disarida birakmak yine de dogru, cunku orada fiyat
     * etkisi ve ucret ayristirilamaz. */
    if (k.f > Number(process.env.UCRET_TAVAN || 30000)) continue;
    const hooksuz = /^0x0{40}$/.test(k.h.toLowerCase());
    (hooksuz ? hooksuzL : hookluL).push({ id: c.adr, k, lik: c.lik, hac: c.hac });
  }
  console.log("  indekste eslesen: hooklu " + hookluL.length + "   hooksuz " + hooksuzL.length);
  if (!hookluL.length || !hooksuzL.length) {
    console.log("\n  Iki kohorttan biri bos. Karsilastirma yapilamaz, sonuc bildirilmiyor.");
    return;
  }

  async function kohort(liste, ad) {
    const fazlalar = [], ucretler = [], gds = [];
    let olculen = 0, basarisiz = 0;
    const blok = await Z.blockNumber();
    for (const { id, k, lik } of liste) {
      if (olculen >= ADET) break;
      const key = { poolId: id, currency0: k.c0, currency1: k.c1, fee: k.f, tickSpacing: k.t, hooks: k.h };
      let rt;
      try { rt = await Hv.roundTrip(key, BOYUT, blok); } catch (e) { basarisiz++; continue; }
      if (!rt || rt.status !== "MEASURED" || rt.roundTripBps == null) { basarisiz++; continue; }
      olculen++;
      const ucretBps = (k.f / 10000) * 100;
      fazlalar.push(rt.roundTripBps - 2 * ucretBps);
      ucretler.push(ucretBps);
      gds.push(rt.roundTripBps);
    }
    console.log("\n  " + ad);
    console.log("    olculen havuz        " + olculen + "   (kota veremeyen " + basarisiz + ")");
    if (!olculen) { console.log("    (sonuc yok)"); return null; }
    console.log("    medyan ilan ucret    " + f2(med(ucretler) / 100) + "%  (iki bacak " + f2(2 * med(ucretler) / 100) + "%)");
    console.log("    medyan gidis-donus   " + f2(med(gds) / 100) + "%");
    console.log("    medyan FAZLA         " + f2(med(fazlalar) / 100) + "%");
    return { olculen, fazla: med(fazlalar) };
  }

  const hk = await kohort(hookluL, "HOOKLU");
  const hs = await kohort(hooksuzL, "HOOKSUZ (kontrol)");

  console.log("\nOKUMA");
  if (!hk || !hs) {
    console.log("  Iki kohorttan biri olculemedi; karsilastirma yapilamaz.");
    console.log("  Tek kohortla sonuc bildirmek kontrolsuz iddia olurdu.");
    return;
  }
  /* Kucuk orneklemde medyan farki gurultulu olabilir. Esik keyfi degil:
   * ucretin kendisi mertebesinde (100 bps = %1) bir fark, "ucret alani
   * yaniltiyor" demek icin anlamlidir; altindaki fark degildir. */
  const fark = (hk.fazla - hs.fazla) / 100;
  console.log("  hooklu fazla   " + f2(hk.fazla / 100) + "%   (n=" + hk.olculen + ")");
  console.log("  hooksuz fazla  " + f2(hs.fazla / 100) + "%   (n=" + hs.olculen + ")");
  console.log("  fark           " + f2(fark) + " puan");
  console.log("");
  /* Iki ayri soru, iki ayri kanit esigi.
   *
   * (1) "Hook buyuk bir pay aliyor mu?" — bunun icin kontrol GEREKMEZ.
   *     Hooklu kohortun kendi fazlasi kucukse, buyuk bir gizli vergi zaten
   *     yoktur. Sablonda afterSwap ve treasury bulunmasi fonksiyonun VAR
   *     oldugunu gosterir, her takasta buyuk pay alindigini degil.
   *
   * (2) "Kalan fazla hooktan mi, fiyat etkisinden mi?" — bunun icin kontrol
   *     SART. Hooksuz havuz likit nufusta nadir oldugu icin bu soru acik
   *     kalabilir, ama birinciyi bloke etmemeli. */
  const hookluFazlaYuzde = hk.fazla / 100;
  if (hk.olculen >= 5 && hookluFazlaYuzde < 1) {
    console.log("  (1) BUYUK GIZLI VERGI YOK. Hooklu havuzlarda ucretle");
    console.log("      aciklanmayan kisim medyan %" + f2(hookluFazlaYuzde) + " — ilan edilen");
    console.log("      ucretin kendisinin cok altinda. Sablonda afterSwap ve");
    console.log("      treasury bulunmasi, her takasta buyuk pay alindigi");
    console.log("      anlamina GELMIYOR. Hipotez bu boyutta dogrulanmadi.");
    console.log("");
    if (hs.olculen < 5) {
      console.log("  (2) Kalan %" + f2(hookluFazlaYuzde) + "'in kaynagi ACIK: hooktan mi fiyat");
      console.log("      etkisinden mi ayirmak icin kontrol grubu gerekiyor ve");
      console.log("      hooksuz likit havuz Arc'ta nadir (bu kosuda " + hs.olculen + " tane).");
      console.log("      Fark " + f2(fark) + " puan ama bu orneklemde gurultudur.");
    } else if (fark > 1) {
      console.log("  (2) Kalan fazla hooktan geliyor: kontrol grubu belirgin");
      console.log("      sekilde daha dusuk.");
    } else {
      console.log("  (2) Kalan fazla hooktan GELMIYOR: kontrol grubu da benzer,");
      console.log("      yani fiyat etkisi ve olcum yontemiyle aciklaniyor.");
    }
  } else if (hk.olculen < 5) {
    console.log("  Hooklu kohort 5 altinda. Hicbir sonuc cikarilmiyor.");
  } else if (fark > 1 && hs.olculen >= 5) {
    console.log("  Hooksuz havuzlarda ucretle aciklanmayan kisim kucuk, hooklu");
    console.log("  havuzlarda buyuk. Fark hookun aldigi paydir. Yani Arc'ta bir");
    console.log("  havuzun ucret alanina bakip maliyet hesaplamak YANLIS sonuc");
    console.log("  verir; gercek maliyet ancak hooku da calistiran bir kota ile");
    console.log("  olculur.");
  } else {
    console.log("  Iki kohort benzer. Fazla maliyet hooktan GELMIYOR — fiyat");
    console.log("  etkisi ya da olcum yontemiyle aciklaniyor. Gizli vergi");
    console.log("  hipotezi bu orneklemde DOGRULANMADI.");
  }
  console.log("\n  SINIR: boyut " + BOYUT + " USDC. Buyuk islemlerde fiyat etkisi baskin");
  console.log("  hale gelir ve bu ayrim bulanir.");
})().catch((e) => { console.log("\nHATA: " + (e && e.message)); process.exit(1); });
