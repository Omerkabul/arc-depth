"use strict";
/* dagit.js — deploy PoolKeyRegistry to Arc mainnet and seed it.
 *
 *   node contracts/dagit.js              dry run: prints what would happen
 *   node contracts/dagit.js --onayla     actually deploys
 *
 * The key is read from the environment or from C:\bot\.env and is never
 * printed, logged, or written anywhere. Only the address derived from it is
 * shown, and that address is checked against the one this deployment is meant
 * to come from — a key resolving to a different wallet aborts the run instead
 * of quietly spending from somewhere unexpected.
 *
 * What this sends: one contract creation, then one registerMany. Nothing else.
 * The contract has no owner, no admin function and no upgrade path, so a
 * mistake here cannot be exploited later; it can only waste the gas.
 */

const fs = require("fs");
const path = require("path");
const { Wallet, JsonRpcProvider, ContractFactory, Contract } = require("ethers");
const Z = require("../src/zincir.js");

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "PoolKeyRegistry.json"), "utf8"));
const ANAHTAR_YOL = path.join(__dirname, "..", "data", "poolkeys.json");
const CIKTI = path.join(__dirname, "dagitim.json");

/* The wallet this deployment is expected to come from. Hard-coded on purpose:
 * it turns "whatever key happens to be in the environment" into a decision
 * made once, deliberately, that can be reviewed in the diff.
 *
 * This guard already earned itself. The first version named the address found
 * by grepping the first 40-hex string out of .env, which turned out to be
 * PAYOUT_ADDRESS — the withdrawal address, not the operating wallet. The run
 * aborted instead of deploying from an account chosen by accident. The correct
 * wallet is the one TRADER_PRIVATE_KEY derives to. */
const BEKLENEN_ADRES = "0x89189C84DC95d0520AEeC9c8cF3BA5B9d42611D0";

const ONAY = process.argv.includes("--onayla");
const usdc = (v) => (Number(v) / 1e18).toFixed(6) + " USDC";

function gizliAnahtar() {
  if (process.env.TRADER_PRIVATE_KEY) return process.env.TRADER_PRIVATE_KEY.trim();
  for (const f of ["C:/bot/.env", "C:/bot/.env.local"]) {
    try {
      const m = fs.readFileSync(f, "utf8").match(/^TRADER_PRIVATE_KEY\s*=\s*(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch (e) { /* next */ }
  }
  return null;
}

(async function main() {
  console.log("PoolKeyRegistry -> Arc mainnet");
  console.log("  rpc    " + Z.ARC.rpc);
  console.log("  solc   " + ART.solc);
  console.log("  kod    " + ((ART.deployedBytecode.length - 2) / 2) + " bayt");
  console.log("  mod    " + (ONAY ? "GERCEK DAGITIM" : "kuru calisma (--onayla verilmedi)"));

  const pk = gizliAnahtar();
  if (!pk) { console.log("\nTRADER_PRIVATE_KEY bulunamadi. Dagitim yapilamaz."); process.exit(1); }

  const saglayici = new JsonRpcProvider(Z.ARC.rpc, { chainId: 5042, name: "arc" }, { staticNetwork: true });
  const cuzdan = new Wallet(pk, saglayici);

  console.log("\n  cuzdan " + cuzdan.address);
  if (cuzdan.address.toLowerCase() !== BEKLENEN_ADRES.toLowerCase()) {
    console.log("  DUR: beklenen adres " + BEKLENEN_ADRES);
    console.log("  Anahtar baska bir cuzdana ait. Hicbir sey gonderilmedi.");
    process.exit(1);
  }
  console.log("  -> beklenen cuzdanla ayni");

  const bakiye = await saglayici.getBalance(cuzdan.address);
  const gasFiyat = (await saglayici.getFeeData()).gasPrice;
  const dagitimGas = BigInt(await Z.rpcRetry("eth_estimateGas", [{ from: cuzdan.address, data: ART.bytecode }]));
  const dagitimMaliyet = dagitimGas * gasFiyat;

  console.log("\n  bakiye        " + usdc(bakiye));
  console.log("  dagitim gas   " + dagitimGas.toString());
  console.log("  dagitim bedel " + usdc(dagitimMaliyet));

  /* Three times the deploy cost, because registerMany still has to run after
   * it. Deploying a registry and then being unable to put anything in it is
   * the one failure mode worth refusing up front. */
  if (bakiye <= dagitimMaliyet * 3n) {
    console.log("\n  DUR: bakiye dagitim bedelinin 3 katindan az. Kayit icin de pay kalmali.");
    process.exit(1);
  }

  if (!ONAY) {
    console.log("\nKuru calisma bitti. Gercekten dagitmak icin:");
    console.log("  node contracts/dagit.js --onayla");
    return;
  }

  console.log("\ndagitiliyor...");
  const fabrika = new ContractFactory(ART.abi, ART.bytecode, cuzdan);
  const kontrat = await fabrika.deploy();
  const islem = kontrat.deploymentTransaction();
  console.log("  islem " + islem.hash);
  const makbuz = await islem.wait(1);
  const adres = await kontrat.getAddress();
  console.log("  adres " + adres);
  console.log("  blok  " + makbuz.blockNumber + "   kullanilan gas " + makbuz.gasUsed.toString());

  /* The deployed code is compared byte for byte with what was compiled and
   * tested. A receipt with status 1 only says the transaction did not revert;
   * it does not say the chain now holds the code that passed the checks. */
  const zincirKod = await saglayici.getCode(adres);
  const uyum = zincirKod.toLowerCase() === ART.deployedBytecode.toLowerCase();
  console.log("  zincirdeki kod derlenenle " + (uyum ? "BIREBIR AYNI" : "FARKLI (!)"));
  if (!uyum) {
    console.log("    zincir   " + ((zincirKod.length - 2) / 2) + " bayt");
    console.log("    beklenen " + ((ART.deployedBytecode.length - 2) / 2) + " bayt");
  }

  /* Seed with the keys already recovered off-chain, so the registry is useful
   * the moment it exists rather than being an empty promise. */
  const K = JSON.parse(fs.readFileSync(ANAHTAR_YOL, "utf8"));
  const liste = Object.values(K).map((k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]);
  console.log("\n" + liste.length + " anahtar kaydediliyor...");
  const c = new Contract(adres, ART.abi, cuzdan);
  const t2 = await c.registerMany(liste);
  console.log("  islem " + t2.hash);
  const m2 = await t2.wait(1);
  const toplam = await c.total();
  console.log("  kullanilan gas " + m2.gasUsed.toString() + "   kayitli havuz " + toplam.toString());

  /* Independent read-back: every id we believed is asked of the contract. */
  let dogru = 0;
  for (const [id, k] of Object.entries(K)) {
    const r = await c.get(id);
    if (r[0] && r[1].fee === BigInt(k.fee) && String(r[1].hooks).toLowerCase() === k.hooks.toLowerCase()) dogru++;
  }
  console.log("  geri okuma: " + dogru + "/" + Object.keys(K).length + " anahtar dogru dondu");

  const sonBakiye = await saglayici.getBalance(cuzdan.address);
  console.log("\n  harcanan " + usdc(bakiye - sonBakiye) + "   kalan " + usdc(sonBakiye));
  console.log("  explorer https://explorer.arc.io/address/" + adres);

  fs.writeFileSync(CIKTI, JSON.stringify({
    zincir: "arc", chainId: 5042,
    adres, dagitimIslem: islem.hash, blok: makbuz.blockNumber,
    kayitIslem: t2.hash, kayitliHavuz: Number(toplam),
    solc: ART.solc, kodUyumlu: uyum, geriOkuma: dogru,
    zaman: new Date().toISOString()
  }, null, 2));
  console.log("  yazildi " + CIKTI);
})().catch((e) => {
  /* Never let an error path print anything derived from the key. */
  console.log("\nHATA: " + String(e && (e.shortMessage || e.message)).slice(0, 300));
  process.exit(1);
});
