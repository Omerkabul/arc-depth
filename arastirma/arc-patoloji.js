"use strict";
/* ===========================================================================
 * arc-patoloji.js — Arc'in havuz nufusunda neyin bozuk oldugunu sayar.
 *
 *   node arc-patoloji.js
 *   node arc-patoloji.js --json
 *
 * NEDEN VAR: "Arc'in baska neye ihtiyaci var" sorusu tahminle degil olcumle
 * cevaplanir. Elimizde 216.091 dogrulanmis PoolKey var — bu veri baska
 * kimsede yok, cunku Initialize olaylarini blok blok toplamak gerekiyor.
 * Bu betik o veriden "burada bir bosluk var" diyebilecegimiz sayilari cikarir.
 *
 * NE OLCMUYOR: likidite, hacim, fiyat. Indeks bunlari tasimiyor. Dolayisiyla
 * "bu havuz olu" diyemeyiz, yalnizca "bu havuzun yapisi su" diyebiliriz.
 * Yapisal patoloji ile olu havuzu karistirmamak icin bu sinir her ciktida
 * tekrar yazilir.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");

const INDEKS = process.env.ARC_HAVUZ_INDEKSI || path.join(__dirname, "arc-havuzlar.json");
const JSON_CIKTI = process.argv.includes("--json");

const DINAMIK = 8388608;           /* 2^23, v4 dinamik ucret bayragi */
const USDC = "0x3600000000000000000000000000000000000000";

const ham = JSON.parse(fs.readFileSync(INDEKS, "utf8"));
const H = ham.havuzlar;
const sonBlok = ham.sonBlok;
const ids = Object.keys(H);

const yuzde = (a, b) => (b ? (100 * a / b).toFixed(1) : "0.0");
const say = (n) => n.toLocaleString("en-US");

/* ---- 1. ucret dagilimi --------------------------------------------------
 * v4'te ucret 1e6 tabanli: 10000 = %1. Ucret tavani yok, ve Arc'ta bunun
 * sonucu goruluyor. */
const ucretKova = { "0-1%": 0, "1-3%": 0, "3-10%": 0, "10-50%": 0, "50-90%": 0, "90%+": 0, "dinamik": 0 };
let dinamik = 0, yuksekUcret = 0;
for (const id of ids) {
  const f = H[id].f;
  if (f === DINAMIK) { ucretKova.dinamik++; dinamik++; continue; }
  const p = f / 10000;
  if (p <= 1) ucretKova["0-1%"]++;
  else if (p <= 3) ucretKova["1-3%"]++;
  else if (p <= 10) ucretKova["3-10%"]++;
  else if (p <= 50) ucretKova["10-50%"]++;
  else if (p <= 90) ucretKova["50-90%"]++;
  else ucretKova["90%+"]++;
  if (p >= 50) yuksekUcret++;
}

/* ---- 2. token basina kac havuz -----------------------------------------
 * Yonlendirme sorununun buyuklugu. Bir tokenin tek havuzu varsa secim yok;
 * on havuzu varsa dogru olani bulmak kullanicinin isi ve hicbir yerde
 * yazmiyor. */
const tokenHavuz = new Map();
for (const id of ids) {
  const k = H[id];
  for (const c of [k.c0, k.c1]) {
    if (c.toLowerCase() === USDC) continue;     /* karsi para, token degil */
    tokenHavuz.set(c, (tokenHavuz.get(c) || 0) + 1);
  }
}
const havuzSayilari = [...tokenHavuz.values()].sort((a, b) => a - b);
const medyan = havuzSayilari[Math.floor(havuzSayilari.length / 2)];
const cokHavuzlu = havuzSayilari.filter((n) => n >= 5).length;
const tekHavuzlu = havuzSayilari.filter((n) => n === 1).length;

/* ---- 3. hook yogunlasmasi ----------------------------------------------
 * Bir hook havuzun davranisini degistirebilir: ucreti swap aninda belirler,
 * satisi engelleyebilir, transferi vergilendirebilir. Az sayida hook cok
 * sayida havuzu kontrol ediyorsa, o hook'u incelemek binlerce havuzu birden
 * anlamak demektir. */
const hookSay = new Map();
let hooksuz = 0;
for (const id of ids) {
  const h = H[id].h.toLowerCase();
  if (/^0x0{40}$/.test(h)) { hooksuz++; continue; }
  hookSay.set(h, (hookSay.get(h) || 0) + 1);
}
const hookTop = [...hookSay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

/* ---- 4. karsi para: USDC disi havuzlar ----------------------------------
 * Arc'ta USDC hem gas hem karsi para. USDC'si olmayan bir havuz, girmek icin
 * once baska bir takas gerektirir — yani gizli bir ek maliyet. */
let usdcli = 0;
for (const id of ids) {
  const k = H[id];
  if (k.c0.toLowerCase() === USDC || k.c1.toLowerCase() === USDC) usdcli++;
}

/* ---- 5. dogum hizi ------------------------------------------------------ */
const g1 = ids.filter((id) => H[id].b > sonBlok - 172800).length;
const g7 = ids.filter((id) => H[id].b > sonBlok - 1209600).length;

/* ---- 6. tickSpacing / ucret tutarsizligi --------------------------------
 * Uniswap'in standart kademelerinde tickSpacing ucretle birlikte artar.
 * Alisilmadik eslesmeler ya ozel bir tasarim ya da ozensiz bir kopya demek;
 * ikisi de "bu havuza dikkat" isareti. */
const standart = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
let standartDisi = 0;
for (const id of ids) {
  const k = H[id];
  if (k.f === DINAMIK) continue;
  if (standart[k.f] !== undefined && standart[k.f] !== k.t) standartDisi++;
}

const sonuc = {
  kaynak: INDEKS, sonBlok,
  toplamHavuz: ids.length,
  tekilToken: tokenHavuz.size,
  ucretKova, yuksekUcret, dinamik,
  tokenBasinaMedyanHavuz: medyan,
  cokHavuzlu, tekHavuzlu,
  hooksuz, tekilHook: hookSay.size, hookTop,
  usdcli, usdcsiz: ids.length - usdcli,
  dogum24s: g1, dogum7g: g7,
  standartDisiTickSpacing: standartDisi
};

if (JSON_CIKTI) { console.log(JSON.stringify(sonuc, null, 2)); process.exit(0); }

console.log("ARC HAVUZ PATOLOJISI");
console.log("  kaynak  " + INDEKS);
console.log("  havuz   " + say(ids.length) + "   tekil token " + say(tokenHavuz.size) +
            "   son blok " + say(sonBlok));
console.log("  dogum   son 24s " + say(g1) + "   son 7g " + say(g7));
console.log("");

console.log("1) UCRET DAGILIMI   (v4'te ucret tavani YOK)");
for (const [k, v] of Object.entries(ucretKova)) {
  const bar = "#".repeat(Math.round(60 * v / ids.length));
  console.log("   " + k.padEnd(9) + say(v).padStart(8) + "  %" + yuzde(v, ids.length).padStart(5) + "  " + bar);
}
console.log("   -> %50 ve uzeri ucret alan havuz: " + say(yuksekUcret) +
            "  (%" + yuzde(yuksekUcret, ids.length) + ")");
console.log("   -> dinamik ucretli (hook swap aninda belirliyor): " + say(dinamik));
console.log("      Dinamik ucretli havuzun fiyati ONCEDEN bilinemez. Hicbir");
console.log("      tarayici bunu durust gosteremez; en fazla isaretleyebilir.");
console.log("");

console.log("2) YONLENDIRME SORUNUNUN BUYUKLUGU");
console.log("   token basina medyan havuz   " + medyan);
console.log("   5+ havuzu olan token        " + say(cokHavuzlu) + "  (%" + yuzde(cokHavuzlu, tokenHavuz.size) + ")");
console.log("   tek havuzu olan token       " + say(tekHavuzlu) + "  (%" + yuzde(tekHavuzlu, tokenHavuz.size) + ")");
console.log("   -> 5+ havuzlu her token icin birisi dogru yolu secmek zorunda");
console.log("      ve bu bilgi Arc'ta hicbir yerde yayinlanmiyor.");
console.log("");

console.log("3) HOOK YOGUNLASMASI");
console.log("   hooksuz havuz   " + say(hooksuz) + "  (%" + yuzde(hooksuz, ids.length) + ")");
console.log("   tekil hook      " + say(hookSay.size));
console.log("   en cok havuzu kontrol eden hook'lar:");
for (const [h, n] of hookTop) {
  console.log("     " + h + "  " + say(n).padStart(7) + " havuz  (%" + yuzde(n, ids.length) + ")");
}
console.log("   -> Tek bir hook binlerce havuzu yonetiyorsa, o hook'un kodunu");
console.log("      bir kez okumak binlerce havuzu birden aciklar.");
console.log("");

console.log("4) KARSI PARA");
console.log("   USDC iceren havuz   " + say(usdcli) + "  (%" + yuzde(usdcli, ids.length) + ")");
console.log("   USDC icermeyen      " + say(ids.length - usdcli) + "  (%" + yuzde(ids.length - usdcli, ids.length) + ")");
console.log("   -> USDC'siz havuza girmek icin once baska bir takas gerekir;");
console.log("      bu gizli maliyet hicbir arayuzde gosterilmiyor.");
console.log("");

console.log("5) STANDART DISI TICKSPACING");
console.log("   standart ucret kademesinde beklenmeyen tickSpacing: " + say(standartDisi));
console.log("");

console.log("OLCUMUN SINIRI");
console.log("  Bu indeks likidite, hacim ve fiyat TASIMIYOR. Dolayisiyla hicbir");
console.log("  satir 'bu havuz olu' ya da 'bu havuz dolandiricilik' demiyor.");
console.log("  Soylenen tek sey yapisal: ucret su, hook su, karsi para su.");
console.log("  Bir havuzun gercekten islem gorup gormedigi ayri bir olcumdur.");
