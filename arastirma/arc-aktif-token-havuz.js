"use strict";
/* ===========================================================================
 * arc-aktif-token-havuz.js — yonlendirme sorunu GERCEKTEN ne kadar yaygin?
 *
 *   node arc-aktif-token-havuz.js
 *
 * NEDEN VAR: arc-patoloji.js, Arc tokenlerinin %97.1'inin tek havuzu
 * oldugunu buldu. Bu, arc-depth'in bütün anlatisina ters: "bir tokenin
 * duzinelerce havuzu olur, hangisinden gececegini kimse soylemiyor."
 *
 * Ama payda yanlis olabilir. 189.783 tek havuzlu tokenin buyuk kismi olu
 * launch — kimse almiyor, dolayisiyla kimsenin yonlendirme sorunu da yok.
 * Dogru soru su: INSANLARIN GERCEKTEN ISLEM YAPTIGI tokenlerde kac havuz var?
 *
 * Bu, "bant analizinde gecilen durumu unutma" kuralinin ta kendisi: aktif
 * tokenler hayatta kalmis olanlardir ve tum nufusla ayni dagilima sahip
 * olmak zorunda degiller.
 *
 * YONTEM: GeckoTerminal'den Arc'in hacme gore en ustteki havuzlarini al,
 * oradaki tokenleri cikar, her birinin yerel indeksteki havuz sayisini say.
 * Kontrol grubu olarak ayni sayiyi rastgele tokenlerde de olc.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const https = require("https");

const INDEKS = process.env.ARC_HAVUZ_INDEKSI || path.join(__dirname, "arc-havuzlar.json");
const USDC = "0x3600000000000000000000000000000000000000";
const GT = "api.geckoterminal.com";
const AG = "arc";

function getJson(yol) {
  return new Promise((coz, red) => {
    const r = https.get({
      hostname: GT, path: yol, timeout: 25_000,
      headers: { accept: "application/json", "user-agent": "arc-depth-research" }
    }, (y) => {
      let s = "";
      y.on("data", (d) => { s += d; });
      y.on("end", () => {
        if (y.statusCode !== 200) return red(Object.assign(new Error("HTTP " + y.statusCode), { http: y.statusCode }));
        try { coz(JSON.parse(s)); } catch (e) { red(new Error("JSON degil")); }
      });
    });
    r.on("timeout", () => { r.destroy(); red(new Error("zaman asimi")); });
    r.on("error", red);
  });
}

/* GeckoTerminal serbest katmani dakikada ~30 istek veriyor. Araya bekleme
 * koymak, 429 yiyip yarim veriyle sonuc bildirmekten iyidir. */
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  console.log("AKTIF TOKENLERDE YONLENDIRME SORUNU");
  console.log("  indeks okunuyor...");
  const H = JSON.parse(fs.readFileSync(INDEKS, "utf8")).havuzlar;

  /* token -> havuz sayisi */
  const sayac = new Map();
  for (const id of Object.keys(H)) {
    const k = H[id];
    for (const c of [k.c0, k.c1]) {
      const a = c.toLowerCase();
      if (a === USDC) continue;
      sayac.set(a, (sayac.get(a) || 0) + 1);
    }
  }
  console.log("  indekste " + sayac.size.toLocaleString("en-US") + " tekil token");

  /* ---- aktif tokenler: hacme gore en ust havuzlar --------------------- */
  const aktif = new Map();                  /* token -> 24s hacim */
  const SAYFA = Number(process.env.GT_SAYFA || 5);
  for (let sayfa = 1; sayfa <= SAYFA; sayfa++) {
    let d;
    try { d = await getJson("/api/v2/networks/" + AG + "/pools?page=" + sayfa); }
    catch (e) {
      if (e.http === 429) {
        /* Hiz siniri gecicidir. Yarim veriyle sonuc bildirmek, yanlis sonuc
         * bildirmektir — orneklem kucuk kalirsa oran gurultuye bogulur. */
        console.log("  sayfa " + sayfa + " hiz siniri, 45sn bekleniyor...");
        await bekle(45000);
        try { d = await getJson("/api/v2/networks/" + AG + "/pools?page=" + sayfa); }
        catch (e2) { console.log("  sayfa " + sayfa + " yine alinamadi: " + e2.message); break; }
      } else { console.log("  sayfa " + sayfa + " alinamadi: " + e.message); break; }
    }
    const liste = (d && d.data) || [];
    if (!liste.length) break;
    for (const p of liste) {
      const a = p.attributes || {};
      const hacim = Number((a.volume_usd && a.volume_usd.h24) || 0);
      const rel = (p.relationships || {});
      for (const yan of ["base_token", "quote_token"]) {
        const t = rel[yan] && rel[yan].data && rel[yan].data.id;
        if (!t) continue;
        const adr = String(t).split("_").pop().toLowerCase();
        if (adr === USDC) continue;
        aktif.set(adr, Math.max(aktif.get(adr) || 0, hacim));
      }
    }
    await bekle(Number(process.env.GT_BEKLE || 2500));
  }
  console.log("  GeckoTerminal'den " + aktif.size + " aktif token bulundu");
  if (!aktif.size) { console.log("\n  Aktif token alinamadi, karsilastirma yapilamiyor."); return; }

  /* ---- karsilastirma -------------------------------------------------- */
  const dagilim = (liste) => {
    const n = liste.length;
    if (!n) return null;
    const s = liste.slice().sort((a, b) => a - b);
    const med = s[Math.floor(n / 2)];
    return {
      n,
      medyan: med,
      ortalama: (liste.reduce((a, b) => a + b, 0) / n).toFixed(1),
      tek: liste.filter((x) => x === 1).length,
      besArti: liste.filter((x) => x >= 5).length,
      onArti: liste.filter((x) => x >= 10).length,
      enCok: s[n - 1]
    };
  };

  const aktifSayilar = [];
  let indekstedegil = 0;
  for (const [adr] of aktif) {
    const c = sayac.get(adr);
    if (c === undefined) { indekstedegil++; continue; }
    aktifSayilar.push(c);
  }

  /* kontrol grubu: ayni buyuklukte rastgele ornek */
  const hepsi = [...sayac.values()];
  const kontrol = [];
  const adim = Math.max(1, Math.floor(hepsi.length / Math.max(aktifSayilar.length, 1)));
  for (let i = 0; i < hepsi.length && kontrol.length < aktifSayilar.length; i += adim) kontrol.push(hepsi[i]);

  const A = dagilim(aktifSayilar), K = dagilim(kontrol), T = dagilim(hepsi);

  const satir = (ad, d) => {
    if (!d) { console.log("  " + ad.padEnd(22) + "(veri yok)"); return; }
    console.log("  " + ad.padEnd(22) +
      "n=" + String(d.n).padStart(7) +
      "  medyan " + String(d.medyan).padStart(3) +
      "  ort " + String(d.ortalama).padStart(6) +
      "  tek havuzlu %" + String(((100 * d.tek) / d.n).toFixed(1)).padStart(5) +
      "  5+ %" + String(((100 * d.besArti) / d.n).toFixed(1)).padStart(5) +
      "  10+ %" + String(((100 * d.onArti) / d.n).toFixed(1)).padStart(5) +
      "  en cok " + d.enCok);
  };

  console.log("");
  console.log("TOKEN BASINA HAVUZ SAYISI");
  satir("aktif (hacimli)", A);
  satir("kontrol (rastgele)", K);
  satir("tum nufus", T);
  if (indekstedegil) console.log("  (" + indekstedegil + " aktif token yerel indekste yok — indeks geride kalmis olabilir)");

  console.log("");
  console.log("OKUMA");
  if (A && T) {
    const kat = (A.besArti / A.n) / Math.max((T.besArti / T.n), 1e-9);
    console.log("  Aktif tokenlerde 5+ havuzlu olma orani, tum nufusa gore " +
      kat.toFixed(1) + " kat.");
    console.log("  Yani yonlendirme sorunu nufusa esit dagilmis DEGIL: islem");
    console.log("  goren tokenlerde yogunlasiyor. Ama asil sayi su — aktif");
    console.log("  tokenlerin %" + ((100 * A.besArti) / A.n).toFixed(1) + "'i 5+ havuza sahip.");
    console.log("  Urun anlatisi bu sayinin uzerine kurulmali, 20 havuzlu tek");
    console.log("  bir ornegin uzerine degil.");
  }
})().catch((e) => { console.log("\nHATA: " + (e && e.message)); process.exit(1); });
