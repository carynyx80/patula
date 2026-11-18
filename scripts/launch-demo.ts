// Launch tokens with full metadata on devnet: one public (deployer is creator,
// with a first buy) and one anonymous (via the relayer).
// Usage: RELAYER_URL=https://... npx ts-node -P tsconfig.json scripts/launch-demo.ts
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "fs";
import { deflateSync } from "zlib";

const RELAYER = (process.env.RELAYER_URL || "").replace(/\/$/, "");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/dev.json", "utf8"))));

// tiny PNG encoder: radial "flower" gradient
function png(w: number, h: number, c1: number[], c2: number[]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2, dy = y - h / 2, r = Math.sqrt(dx * dx + dy * dy) / (w / 2);
      const petals = 0.5 + 0.5 * Math.cos(Math.atan2(dy, dx) * 8);
      const t = Math.min(1, r * (0.75 + 0.35 * petals));
      for (let k = 0; k < 3; k++) raw[y * (w * 3 + 1) + 1 + x * 3 + k] = Math.round(c1[k] * (1 - t) + c2[k] * t);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const dataUrl = (b: Buffer) => "data:image/png;base64," + b.toString("base64");

async function post(path: string, body: unknown) {
  const r = await fetch(RELAYER + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j;
}

async function main() {
  const idl = JSON.parse(readFileSync("target/idl/launchpad.json", "utf8"));
  const lp = new Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" })) as any;
  const pda = (s: string, k?: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(s), ...(k ? [k.toBuffer()] : [])], lp.programId)[0];
  const cfg = await lp.account.config.fetch(pda("config"));

  // public launch with full metadata + bundled first buy
  const meta = await post("/metadata", {
    name: "Golden Hour", symbol: "GOLD",
    description: "A marigold for every trader. Launched in the open on Patula's devnet launchpad, with fixed supply and locked liquidity.",
    website: "https://patula.vercel.app", twitter: "@solana", telegram: "t.me/solana",
    image: dataUrl(png(512, 512, [255, 214, 120], [150, 50, 200])), banner: dataUrl(png(900, 300, [255, 170, 60], [40, 20, 60])),
  });
  console.log("metadata:", meta.uri);
  const mint = Keypair.generate();
  const curve = pda("curve", mint.publicKey);
  const accts = { config: pda("config"), curve, mint: mint.publicKey, curveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true), solVault: pda("sol_vault", mint.publicKey), feeRecipient: cfg.feeRecipient };
  const sig = await lp.methods.createToken("Golden Hour", "GOLD", meta.uri)
    .accountsPartial({ ...accts, payer: deployer.publicKey, creator: deployer.publicKey })
    .postInstructions([await lp.methods.buy(new BN(2_000_000), new BN(0)).accountsPartial({ ...accts, buyer: deployer.publicKey, creator: deployer.publicKey }).instruction()])
    .signers([mint]).rpc();
  console.log("public launch GOLD:", mint.publicKey.toBase58(), sig);

  // anonymous launch with metadata
  const meta2 = await post("/metadata", {
    name: "Moonlit Petal", symbol: "PETAL", description: "Launched anonymously: the creator is a fresh key with no history. Trade it privately from your shielded balance.",
    discord: "discord.gg/solana", image: dataUrl(png(512, 512, [255, 120, 170], [30, 20, 80])),
  });
  const creator = Keypair.generate(), m2 = Keypair.generate();
  const prep = await post("/launch/prepare", { name: "Moonlit Petal", symbol: "PETAL", uri: meta2.uri, creator: creator.publicKey.toBase58(), mint: m2.publicKey.toBase58() });
  const tx = Transaction.from(Buffer.from(prep.tx, "base64"));
  tx.partialSign(m2, creator);
  const sub = await post("/launch/submit", { tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  console.log("anonymous launch PETAL:", m2.publicKey.toBase58(), sub.signature);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
