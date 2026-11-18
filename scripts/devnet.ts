// Devnet bring-up + live end-to-end check through the hosted relayer.
//   1. initialize the pool (once)
//   2. top up the relayer wallet
//   3. deposit a shielded note (public, signed by the deployer)
//   4. withdraw it to a fresh address via POST {RELAYER_URL}/relay (private, relayer pays gas)
//
// Usage: RELAYER_URL=https://... npx ts-node -P tsconfig.json scripts/devnet.ts
import * as anchor from "@anchor-lang/core";
import { BN, BorshCoder, EventParser, Program } from "@anchor-lang/core";
import {
  ComputeBudgetProgram, Connection, Keypair as SolKeypair, LAMPORTS_PER_SOL,
  PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { initPoseidon, Keypair, MerkleTree, Note, prove, fromBytes } from "../client/pool";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const RELAYER_URL = (process.env.RELAYER_URL || "").replace(/\/$/, "");
const idl = JSON.parse(readFileSync("target/idl/patula.json", "utf8"));
const deployer = SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/dev.json", "utf8"))));

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
  const program = new Program(idl, provider) as any;
  const pid = program.programId as PublicKey;
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool")], pid);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], pid);
  const nullifierPda = (n: number[]) => PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.from(n)], pid)[0];

  await initPoseidon();

  // 1. initialize
  if (!(await conn.getAccountInfo(poolPda))) {
    const sig = await program.methods.initialize().accountsPartial({ pool: poolPda, vault: vaultPda }).rpc();
    console.log("initialized pool:", sig);
  } else console.log("pool already initialized");

  // 2. relayer top-up
  const health: any = await (await fetch(RELAYER_URL + "/health")).json();
  const relayerKey = new PublicKey(health.relayer);
  const relBal = await conn.getBalance(relayerKey);
  if (relBal < 0.2 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: relayerKey, lamports: 0.3 * LAMPORTS_PER_SOL }));
    console.log("funded relayer:", await sendAndConfirmTransaction(conn, tx, [deployer]));
  }

  // Rebuild the Merkle tree from on-chain NewCommitments events (mini indexer).
  const tree = new MerkleTree();
  const parser = new EventParser(pid, new BorshCoder(idl));
  const sigs = (await conn.getSignaturesForAddress(pid, { limit: 1000 })).reverse();
  const found: { index: number; c: bigint[] }[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (const ev of parser.parseLogs(tx?.meta?.logMessages ?? [])) {
      if (ev.name === "newCommitments" || ev.name === "NewCommitments") {
        found.push({ index: Number(ev.data.index), c: (ev.data.commitments as number[][]).map(fromBytes) });
      }
    }
  }
  found.sort((a, b) => a.index - b.index).forEach((f) => f.c.forEach((c) => tree.insert(c)));
  console.log("tree leaves from chain:", tree.leaves.length);

  // 3. deposit 0.05 SOL
  const amount = BigInt(0.05 * LAMPORTS_PER_SOL);
  const me = new Keypair();
  const note = new Note(amount, me);
  const dep = await prove({ tree, inputs: [], outputs: [note], extAmount: amount, fee: 0n, recipient: deployer.publicKey, relayer: deployer.publicKey });
  const depSig = await program.methods
    .transact({ ...dep.args, extAmount: new BN(amount.toString()), fee: new BN(0) })
    .accountsPartial({
      pool: poolPda, vault: vaultPda,
      nullifier0: nullifierPda(dep.args.inputNullifiers[0]), nullifier1: nullifierPda(dep.args.inputNullifiers[1]),
      signer: deployer.publicKey, recipient: deployer.publicKey, systemProgram: SystemProgram.programId,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .rpc();
  dep.outputs.forEach((o) => { o.index = tree.leaves.length; tree.insert(o.commitment); });
  console.log(`deposit (public, ${dep.proveMs} ms proof):`, depSig);

  const pool = await program.account.pool.fetch(poolPda);
  const onchain = fromBytes(pool.roots[pool.currentRootIndex.toNumber()]);
  if (onchain !== tree.root()) throw new Error("local tree out of sync with chain");

  // 4. private withdraw via hosted relayer
  const fee = BigInt(health.minFeeLamports);
  const fresh = SolKeypair.generate().publicKey;
  const w = await prove({ tree, inputs: [dep.outputs[0]], outputs: [], extAmount: -(amount - fee), fee, recipient: fresh, relayer: relayerKey });
  const body = {
    recipient: fresh.toBase58(),
    args: { ...w.args, extAmount: w.args.extAmount.toString(), fee: w.args.fee.toString() },
  };
  const r = await fetch(RELAYER_URL + "/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out: any = await r.json();
  console.log(`relay response (${r.status}, ${w.proveMs} ms proof):`, out);
  if (!r.ok) process.exit(1);
  await conn.confirmTransaction(out.signature, "confirmed");
  console.log("fresh address", fresh.toBase58(), "received", (await conn.getBalance(fresh)) / LAMPORTS_PER_SOL, "SOL");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
