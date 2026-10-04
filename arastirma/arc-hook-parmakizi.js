"use strict";
/* ===========================================================================
 * arc-hook-parmakizi.js — Arc'ta 160.568 hook adresi var. Kac tane KOD var?
 *
 *   node arc-hook-parmakizi.js [--ornek 200]
 *
 * NEDEN VAR: Havuz indeksi 216.101 havuzda 160.568 FARKLI hook adresi
 * gosteriyor — neredeyse havuz basina bir tane. Iki ihtimal var ve ikisi
 * tamamen farkli dunyalar:
 *
 *   (a) Gercekten 160 bin farkli hook yazilmis. O zaman Arc'ta hicbir
 *       havuzun davranisi onceden bilinemez ve her biri tek tek okunmali.
 *   (b) Ayni kod on binlerce kez dagitilmis. O zaman Arc'in tamami birkac
 *       sablonla aciklanir: bir kez okursun, binlerce havuzu anlarsin.
 *
 * Fark olculebilir: adres farkli olabilir ama CALISAN KOD ayni olabilir.
 * eth_getCode ile baytkodu alip keccak'ini almak, "bu iki hook ayni mi"
 * sorusunu kesin cevaplar.
 *
 * v4'te hook adresinin SON baytlari izinleri kodlar (beforeSwap, afterSwap,
 * ...). Yani ayni koddan turetilmis hooklar farkli adreslerde durur ama ayni
 * baytkodu tasir. Indekste gorulen ...cc / ...44 / ...dc gibi tekrar eden
 * sonlar da bunun isareti.
 *
 * NE OLCMUYOR: hookun ne YAPTIGI. Bu betik yalnizca "kac farkli kod var ve
 * hangisi kac havuzu yonetiyor" der. Davranis analizi ayri bir istir ve
 * burada iddia edilmez.
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { keccak256 } = require("ethers");

const Z = require(path.join("C:", "arc-depth", "src", "zincir.js"));
const INDEKS = process.env.ARC_HAVUZ_INDEKSI || path.join(__dirname, "arc-havuzlar.json");
const CIKTI = path.join(__dirname, "arc-hook-parmakizi.json");

const arg = process.argv.slice(2);
const i = arg.indexOf("--ornek");
const ORNEK = i >= 0 ? Number(arg[i + 1]) : 200;

const say = (n) => n.toLocaleString("en-US");

(async function main() {
  const H = JSON.parse(fs.readFileSync(INDEKS, "utf8")).havuzlar;

  /* hook -> kac havuz */
  const hookHavuz = new Map();
  for (const id of Object.keys(H)) {
    const h = H[id].h.toLowerCase();
    if (/^0x0{40}$/.test(h)) continue;
    hookHavuz.set(h, (hookHavuz.get(h) || 0) + 1);
  }
  const hooklar = [...hookHavuz.entries()].sort((a, b) => b[1] - a[1]);
  console.log("ARC HOOK PARMAK IZI");
  console.log("  tekil hook adresi : " + say(hooklar.length));
  console.log("  hooklu havuz      : " + say([...hookHavuz.values()].reduce((a, b) => a + b, 0)));

  /* Ornekleme: en cok havuzu olanlardan yarisi, rastgeleden yarisi.
   * Yalniz en ustten almak, "populer hooklar ayni koddan" diye yaniltici bir
   * sonuc verir; yalniz rastgele almak uzun kuyrugu temsil eder ama hacmi
   * kacirir. Ikisi birden olculur ve AYRI raporlanir. */
  const yari = Math.floor(ORNEK / 2);
  const ust = hooklar.slice(0, yari);
  const kuyruk = [];
  const adim = Math.max(1, Math.floor((hooklar.length - yari) / Math.max(ORNEK - yari, 1)));
  for (let j = yari; j < hooklar.length && kuyruk.length < ORNEK - yari; j += adim) kuyruk.push(hooklar[j]);

  console.log("  ornek             : " + ust.length + " en yogun + " + kuyruk.length + " uzun kuyruk");
  console.log("");

  const parmak = new Map();           /* kodHash -> {adres:[], havuz:n, boyut} */
  let okunan = 0, bos = 0, hata = 0;

  async function olc(liste, etiket) {
    const yerel = new Map();
    for (const [adr, havuzSayisi] of liste) {
      let kod;
      try { kod = await Z.rpcRetry("eth_getCode", [adr, "latest"]); }
      catch (e) { hata++; continue; }
      okunan++;
      if (!kod || kod === "0x") { bos++; continue; }
      const h = keccak256(kod);
      const boyut = (kod.length - 2) / 2;
      for (const m of [parmak, yerel]) {
        const k = m.get(h) || { adres: [], havuz: 0, boyut };
        if (k.adres.length < 4) k.adres.push(adr);
        k.havuz += havuzSayisi;
        m.set(h, k);
      }
    }
    return yerel;
  }

  console.log("  en yogun hooklar okunuyor...");
  const ustP = await olc(ust, "ust");
  console.log("  uzun kuyruk okunuyor...");
  const kuyrukP = await olc(kuyruk, "kuyruk");

  console.log("");
  console.log("SONUC");
  console.log("  okunan hook            " + okunan + "   (kodsuz " + bos + ", hata " + hata + ")");
  console.log("  FARKLI BAYTKOD         " + parmak.size);
  console.log("    en yogun ornekte     " + ustP.size + " farkli kod / " + ust.length + " adres");
  console.log("    uzun kuyrukta        " + kuyrukP.size + " farkli kod / " + kuyruk.length + " adres");
  console.log("");

  const sirali = [...parmak.entries()].sort((a, b) => b.havuz - a.havuz || b[1].havuz - a[1].havuz);
  sirali.sort((a, b) => b[1].havuz - a[1].havuz);
  console.log("EN COK HAVUZU YONETEN KODLAR");
  console.log("  kodHash(ilk10)  boyut   adres  bu ornekteki havuz   ornek adres");
  for (const [h, v] of sirali.slice(0, 12)) {
    console.log("  " + h.slice(0, 12) + "  " + String(v.boyut).padStart(6) + "  " +
      String(v.adres.length).padStart(5) + "  " + String(v.havuz).padStart(18) + "   " + v.adres[0]);
  }

  const toplamOrnekHavuz = [...parmak.values()].reduce((a, b) => a + b.havuz, 0);
  const enBuyuk = sirali.length ? sirali[0][1].havuz : 0;
  console.log("");
  console.log("OKUMA");
  if (okunan === 0) {
    console.log("  Hicbir hook okunamadi; sonuc cikarilamaz.");
  } else if (parmak.size <= okunan * 0.2) {
    console.log("  " + okunan + " adres " + parmak.size + " farkli koda dusuyor. Yani Arc'taki");
    console.log("  hooklarin buyuk cogunlugu AYNI kodun tekrar tekrar dagitilmis");
    console.log("  halleri. Bu, her havuzu tek tek incelemek yerine sablonlari");
    console.log("  siniflandirmanin mumkun oldugu anlamina gelir.");
    console.log("  En yaygin tek kod, bu ornekteki havuzlarin %" +
      ((100 * enBuyuk) / Math.max(toplamOrnekHavuz, 1)).toFixed(1) + "'ini yonetiyor.");
  } else {
    console.log("  " + okunan + " adres " + parmak.size + " farkli kod veriyor — tekrar orani dusuk.");
    console.log("  Yani hooklar gercekten birbirinden farkli ve sablon");
    console.log("  siniflandirmasi tek basina yetmez.");
  }
  console.log("");
  console.log("  SINIR: bu betik kodun NE YAPTIGINI soylemiyor. Yalnizca ayni mi");
  console.log("  farkli mi onu soyluyor. Davranis analizi ayri bir istir.");

  fs.writeFileSync(CIKTI, JSON.stringify({
    zaman: new Date().toISOString(),
    tekilHookAdresi: hooklar.length,
    okunan, bos, hata,
    farkliBaytkod: parmak.size,
    ustOrnek: { adres: ust.length, kod: ustP.size },
    kuyrukOrnek: { adres: kuyruk.length, kod: kuyrukP.size },
    kodlar: sirali.slice(0, 30).map(([h, v]) => ({ kodHash: h, boyut: v.boyut, adresSayisi: v.adres.length, havuz: v.havuz, ornekAdres: v.adres }))
  }, null, 2));
  console.log("\n  yazildi " + CIKTI);
})().catch((e) => { console.log("\nHATA: " + (e && e.message)); process.exit(1); });
