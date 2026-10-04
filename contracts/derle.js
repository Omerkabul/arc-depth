"use strict";
/* derle.js — compile PoolKeyRegistry.sol with the local solc.
 *
 *   node contracts/derle.js
 *
 * Writes contracts/PoolKeyRegistry.json (abi + bytecode). Nothing is sent to a
 * network here. The compiler runs locally and needs no account or service, so
 * this step stays available even with no budget at all.
 */

const fs = require("fs");
const path = require("path");
const solc = require("solc");

const AD = "PoolKeyRegistry";
const KAYNAK = path.join(__dirname, AD + ".sol");
const CIKTI = path.join(__dirname, AD + ".json");

const girdi = {
  language: "Solidity",
  sources: { [AD + ".sol"]: { content: fs.readFileSync(KAYNAK, "utf8") } },
  settings: {
    /* Optimizer on, and the run count set high because every function here is
     * called far more often than the contract is deployed — this is permanent
     * public infrastructure, so read cost matters more than deploy cost. */
    optimizer: { enabled: true, runs: 20000 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] } }
  }
};

const cikti = JSON.parse(solc.compile(JSON.stringify(girdi)));

const hatalar = (cikti.errors || []).filter((e) => e.severity === "error");
const uyarilar = (cikti.errors || []).filter((e) => e.severity !== "error");
for (const u of uyarilar) console.log("UYARI: " + u.formattedMessage.trim().split("\n")[0]);
if (hatalar.length) {
  for (const h of hatalar) console.log("\nHATA:\n" + h.formattedMessage);
  process.exit(1);
}

const c = cikti.contracts[AD + ".sol"][AD];
const bytecode = "0x" + c.evm.bytecode.object;
const deployed = "0x" + c.evm.deployedBytecode.object;

fs.writeFileSync(CIKTI, JSON.stringify({
  ad: AD,
  solc: solc.version(),
  abi: c.abi,
  bytecode,
  deployedBytecode: deployed
}, null, 2));

console.log("derlendi: " + AD);
console.log("  solc            " + solc.version());
console.log("  deploy bytecode " + ((bytecode.length - 2) / 2) + " bayt");
console.log("  calisan kod     " + ((deployed.length - 2) / 2) + " bayt (EIP-170 siniri 24576)");
console.log("  fonksiyonlar    " + c.abi.filter((x) => x.type === "function").map((x) => x.name).join(", "));
console.log("  yazildi         " + CIKTI);
