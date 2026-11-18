// Initialise the launchpad config on devnet and seed one demo token with a few trades.
// Usage: npx ts-node -P tsconfig.json scripts/launchpad-devnet.ts
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "fs";

const SOL = LAMPORTS_PER_SOL;
const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/dev.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/launchpad.json", "utf8"));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new Program(idl, provider) as any;
const pda = (seed: string, key?: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...(key ? [key.toBuffer()] : [])], program.programId)[0];

async function main() {
  if (!(await conn.getAccountInfo(pda("config")))) {
    const sig = await program.methods
      .initConfig({
        feeRecipient: deployer.publicKey,
        tradeFeeBps: 70,
        creatorFeeBps: 30,
        launchFee: new BN(0.01 * SOL),
        virtualSol: new BN(0.25 * SOL), // devnet-sized: a curve graduates after ~0.8 SOL
        virtualToken: new BN("1050000000000000"),
        curveSupply: new BN("800000000000000"),
        totalSupply: new BN("1000000000000000"),
        maxCreatorBuyBps: 500,
        sniperSlots: new BN(10),
        sniperMaxBps: 100,
      })
      .rpc();
    console.log("config initialised:", sig);
  } else console.log("config exists");

  if (process.argv.includes("--no-demo")) return;

  const mint = Keypair.generate();
  const curve = pda("curve", mint.publicKey);
  const accts = {
    curve, mint: mint.publicKey,
    curveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true),
    solVault: pda("sol_vault", mint.publicKey),
    feeRecipient: deployer.publicKey,
  };
  const sig = await program.methods
    .createToken("Marigold", "MARI", "")
    .accountsPartial({ ...accts, creator: deployer.publicKey })
    .signers([mint])
    .rpc();
  console.log("demo token", mint.publicKey.toBase58(), sig);

  const trader = Keypair.generate();
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: trader.publicKey, lamports: 0.12 * SOL })), [deployer]);
  await new Promise((r) => setTimeout(r, 6000)); // past the sniper window
  const tp = new Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(trader), { commitment: "confirmed" })) as any;
  for (const amt of [0.03, 0.05, 0.02]) {
    await tp.methods.buy(new BN(amt * SOL), new BN(0))
      .accountsPartial({ ...accts, creator: deployer.publicKey, buyer: trader.publicKey }).rpc();
    console.log("buy", amt, "SOL");
  }
  await program.methods.buy(new BN(0.01 * SOL), new BN(0))
    .accountsPartial({ ...accts, creator: deployer.publicKey, buyer: deployer.publicKey }).rpc();
  console.log("creator buy 0.01 SOL");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
