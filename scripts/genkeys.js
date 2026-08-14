const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { initCrypto } = require("../witness-services/common/crypto");

const SERVICES = [
  { name: "custodian", envVar: "CUSTODIAN_PRIVKEY", port: 3001 },
  { name: "oracle", envVar: "ORACLE_PRIVKEY", port: 3002 },
  { name: "sanctions", envVar: "SANCTIONS_PRIVKEY", port: 3003 },
];

async function main() {
  const { eddsa, F } = await initCrypto();
  const registry = { generatedAt: new Date().toISOString(), witnesses: {} };

  for (const svc of SERVICES) {
    const dir = path.join(__dirname, "..", "witness-services", svc.name);
    const envPath = path.join(dir, ".env");

    if (fs.existsSync(envPath) && !process.argv.includes("--force")) {
      console.log(`Skip ${svc.name}: ${envPath} exists (use --force to overwrite)`);
      const existing = fs
        .readFileSync(envPath, "utf-8")
        .split("\n")
        .find((l) => l.startsWith(`${svc.envVar}=`));
      const hex = existing.split("=")[1].trim();
      const pub = eddsa.prv2pub(Buffer.from(hex, "hex"));
      registry.witnesses[svc.name] = {
        pubKey: [F.toString(pub[0]), F.toString(pub[1])],
        port: svc.port,
      };
      continue;
    }

    const privKey = crypto.randomBytes(32);
    const pub = eddsa.prv2pub(privKey);

    fs.writeFileSync(
      envPath,
      `${svc.envVar}=${privKey.toString("hex")}\n` +
        `PORT=${svc.port}\n`
    );

    registry.witnesses[svc.name] = {
      pubKey: [F.toString(pub[0]), F.toString(pub[1])],
      port: svc.port,
    };
    console.log(`Generated ${svc.name}: private key written to ${envPath}`);
  }

  const registryPath = path.join(__dirname, "..", "witness-services", "pubkeys.json");
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  console.log(`\nPublic-key registry: ${registryPath}`);
  console.log(JSON.stringify(registry.witnesses, null, 2));
}

main().catch((err) => {
  console.error("Key generation failed:", err);
  process.exit(1);
});