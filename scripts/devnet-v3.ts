// Launchpad v2 devnet bring-up: config + lookup table for private trades.
// Usage: npx ts-node -P tsconfig.json scripts/devnet-v3.ts
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";

const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const deployer = load(".keys/dev.json");
const relayer = load(".keys/relayer-devnet.json");
const SOL = LAMPORTS_PER_SOL;

async function main() {
  const lpIdl = JSON.parse(readFileSync("target/idl/launchpad.json", "utf8"));
  const poolIdl = JSON.parse(readFileSync("target/idl/patula.json", "utf8"));
  const lp = new Program(lpIdl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" })) as any;
  const poolId = new PublicKey(poolIdl.address);
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], lp.programId)[0];

  if (!(await conn.getAccountInfo(config))) {
    const sig = await lp.methods.initConfig({
      feeRecipient: deployer.publicKey,
      platformFeeBps: 50, // 0.5%
      maxTokenFeeBps: 1000, // creators may set up to 10% per side
      launchFee: new BN(0.01 * SOL),
      virtualSol: new BN(0.25 * SOL), // devnet-sized curve: graduates after ~0.8 SOL
      virtualToken: new BN("1050000000000000"),
      curveSupply: new BN("800000000000000"),
      totalSupply: new BN("1000000000000000"),
      maxCreatorBuyBps: 500,
      sniperSlots: new BN(10),
      sniperMaxBps: 100,
    }).rpc();
    console.log("config initialised:", sig);
  } else console.log("config exists");

  const pool = PublicKey.findProgramAddressSync([Buffer.from("pool2")], poolId)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault2")], poolId)[0];
  const slot = await conn.getSlot("finalized");
  const [create, alt] = AddressLookupTableProgram.createLookupTable({ authority: relayer.publicKey, payer: relayer.publicKey, recentSlot: slot });
  const extend = AddressLookupTableProgram.extendLookupTable({
    lookupTable: alt, authority: relayer.publicKey, payer: relayer.publicKey,
    addresses: [pool, vault, lp.programId, config, deployer.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, ComputeBudgetProgram.programId],
  });
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: [create, extend] }).compileToV0Message());
  tx.sign([relayer]);
  await conn.confirmTransaction(await conn.sendTransaction(tx), "confirmed");
  console.log("ALT_ADDRESS=" + alt.toBase58());
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
