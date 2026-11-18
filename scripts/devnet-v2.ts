// Phase 1b devnet bring-up: initialise pool v2, fund the relayer, create the
// address lookup table that private trades use (relayer is its authority).
// Usage: npx ts-node -P tsconfig.json scripts/devnet-v2.ts
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";

const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const deployer = load(".keys/dev.json");
const relayer = load(".keys/relayer-devnet.json");

async function main() {
  const poolIdl = JSON.parse(readFileSync("target/idl/patula.json", "utf8"));
  const lpIdl = JSON.parse(readFileSync("target/idl/launchpad.json", "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
  const pool = new Program(poolIdl, provider) as any;
  const lpId = new PublicKey(lpIdl.address);
  const poolPda = PublicKey.findProgramAddressSync([Buffer.from("pool2")], pool.programId)[0];
  const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("vault2")], pool.programId)[0];
  const lpConfig = PublicKey.findProgramAddressSync([Buffer.from("config")], lpId)[0];

  if (!(await conn.getAccountInfo(poolPda))) {
    const sig = await pool.methods.initialize().accountsPartial({ pool: poolPda, vault: vaultPda })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
    console.log("pool v2 initialised:", sig);
  } else console.log("pool v2 exists");

  if ((await conn.getBalance(relayer.publicKey)) < 1.5 * LAMPORTS_PER_SOL) {
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
      fromPubkey: deployer.publicKey, toPubkey: relayer.publicKey, lamports: 1.5 * LAMPORTS_PER_SOL,
    })), [deployer]);
    console.log("relayer funded");
  }

  const feeRecipient = (await (new Program(lpIdl, provider) as any).account.config.fetch(lpConfig)).feeRecipient as PublicKey;
  const slot = await conn.getSlot("finalized");
  const [create, alt] = AddressLookupTableProgram.createLookupTable({ authority: relayer.publicKey, payer: relayer.publicKey, recentSlot: slot });
  const extend = AddressLookupTableProgram.extendLookupTable({
    lookupTable: alt, authority: relayer.publicKey, payer: relayer.publicKey,
    addresses: [poolPda, vaultPda, lpId, lpConfig, feeRecipient, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId, ComputeBudgetProgram.programId],
  });
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: [create, extend] }).compileToV0Message());
  tx.sign([relayer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("ALT_ADDRESS=" + alt.toBase58());
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
