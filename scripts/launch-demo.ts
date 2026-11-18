// Devnet demo for launchpad v2: launch a token with full metadata and creator
// fees, trade it, stake, trade again, and claim the holders fee.
// Usage: RELAYER_URL=https://... npx ts-node -P tsconfig.json scripts/launch-demo.ts
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
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
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2, dy = y - h / 2, r = Math.sqrt(dx * dx + dy * dy) / (w / 2);
      const t = Math.min(1, r * (0.75 + 0.35 * (0.5 + 0.5 * Math.cos(Math.atan2(dy, dx) * 8))));
      for (let k = 0; k < 3; k++) raw[y * (w * 3 + 1) + 1 + x * 3 + k] = Math.round(c1[k] * (1 - t) + c2[k] * t);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const dataUrl = (b: Buffer) => "data:image/png;base64," + b.toString("base64");

async function main() {
  const idl = JSON.parse(readFileSync("target/idl/launchpad.json", "utf8"));
  const lp = new Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" })) as any;
  const pda = (s: string, ...k: PublicKey[]) => PublicKey.findProgramAddressSync([Buffer.from(s), ...k.map((x) => x.toBuffer())], lp.programId)[0];
  const cfg = await lp.account.config.fetch(pda("config"));

  const r = await fetch(RELAYER + "/metadata", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Golden Hour", symbol: "GOLD",
      description: "A marigold for every trader. 2% buy and 3% sell fee, and half of it goes to holders who stake. Liquidity locks forever at graduation.",
      website: "https://patula.vercel.app", twitter: "@solana", telegram: "t.me/solana",
      image: dataUrl(png(512, 512, [255, 214, 120], [150, 50, 200])), banner: dataUrl(png(900, 300, [255, 170, 60], [40, 20, 60])),
    }),
  });
  const meta: any = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(meta));

  const mint = Keypair.generate();
  const curve = pda("curve", mint.publicKey);
  const accts = {
    config: pda("config"), curve, mint: mint.publicKey, curveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true),
    solVault: pda("sol_vault", mint.publicKey), rewards: pda("rewards", mint.publicKey), feeRecipient: cfg.feeRecipient, creator: deployer.publicKey,
  };
  const fees = { buyFeeBps: 200, sellFeeBps: 300, holderShareBps: 5000 };
  await lp.methods.createToken("Golden Hour", "GOLD", meta.uri, fees)
    .accountsPartial({ ...accts, payer: deployer.publicKey })
    .postInstructions([await lp.methods.buy(new BN(2_000_000), new BN(0)).accountsPartial({ ...accts, buyer: deployer.publicKey }).instruction()])
    .signers([mint]).rpc();
  console.log("GOLD:", mint.publicKey.toBase58());

  // a separate trader, then the creator stakes and the trader buys again
  const trader = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: trader.publicKey, lamports: 150_000_000 })), [deployer]);
  await new Promise((res) => setTimeout(res, 6000));
  const tp = new Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(trader), { commitment: "confirmed" })) as any;
  await tp.methods.buy(new BN(40_000_000), new BN(0)).accountsPartial({ ...accts, buyer: trader.publicKey }).rpc();
  const myTokens = (await getAccount(conn, getAssociatedTokenAddressSync(mint.publicKey, deployer.publicKey))).amount;
  const stakeAccts = {
    curve, mint: mint.publicKey, position: pda("stake", mint.publicKey, deployer.publicKey), stakeVault: pda("stake_vault", mint.publicKey),
    ownerToken: getAssociatedTokenAddressSync(mint.publicKey, deployer.publicKey), rewards: pda("rewards", mint.publicKey), owner: deployer.publicKey,
  };
  await lp.methods.stake(new BN(myTokens.toString())).accountsPartial(stakeAccts).rpc();
  console.log("staked", Number(myTokens) / 1e6, "GOLD");
  await tp.methods.buy(new BN(60_000_000), new BN(0)).accountsPartial({ ...accts, buyer: trader.publicKey }).rpc();
  const traderTokens = (await getAccount(conn, getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey))).amount;
  await tp.methods.sell(new BN((traderTokens / 3n).toString()), new BN(0)).accountsPartial({ ...accts, seller: trader.publicKey }).rpc();
  const before = await conn.getBalance(deployer.publicKey);
  await lp.methods.claim().accountsPartial({ curve, mint: mint.publicKey, position: stakeAccts.position, rewards: stakeAccts.rewards, owner: deployer.publicKey }).rpc();
  console.log("claimed holders fee:", ((await conn.getBalance(deployer.publicKey)) - before + 5000) / 1e9, "SOL");
  const c = await lp.account.curve.fetch(curve);
  console.log("creator fees", Number(c.creatorFeesTotal) / 1e9, "· stakers", Number(c.holderRewardsTotal) / 1e9, "· volume", Number(c.volumeSol) / 1e9);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
