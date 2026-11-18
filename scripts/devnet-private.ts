// Live check on devnet through a relayer (launchpad v2):
// deposit -> pay for an anonymous launch privately -> launch with creator fees
// -> private buy -> private sell -> private withdraw.
// Usage: RELAYER_URL=http://localhost:8790 npx ts-node -P tsconfig.json scripts/devnet-private.ts
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { ComputeBudgetProgram, Connection, Keypair as SolKeypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { buyHash, initPoseidon, Keypair, MerkleTree, Note, prove, sellHash, transactHash } from "../client/pool";

const RELAYER = (process.env.RELAYER_URL || "http://localhost:8790").replace(/\/$/, "");
const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
const deployer = SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/dev.json", "utf8"))));
const WASM = "build/circuits/spend_js/spend.wasm", ZKEY = "build/circuits/spend.zkey";
const SOL = BigInt(LAMPORTS_PER_SOL);

const post = async (path: string, body: unknown) => {
  const r = await fetch(RELAYER + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(j)}`);
  return j;
};
const getTree = async () => new MerkleTree(((await (await fetch(RELAYER + "/tree")).json()) as any).leaves.map((h: string) => BigInt("0x" + h)));
async function locate(notes: Note[]) {
  for (let i = 0; i < 10; i++) {
    const t = await getTree();
    notes.forEach((n) => { n.index = t.leaves.findIndex((l) => l === n.commitment); });
    if (notes.every((n) => n.amount === 0n || n.index >= 0)) return t;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("notes not indexed yet");
}

async function main() {
  await initPoseidon();
  const health: any = await (await fetch(RELAYER + "/health")).json();
  const relayer = new PublicKey(health.relayer);
  const fee = BigInt(health.minFeeLamports);
  const price = BigInt(health.privateLaunchPriceLamports);
  const lpIdl = JSON.parse(readFileSync("target/idl/launchpad.json", "utf8"));
  const poolIdl = JSON.parse(readFileSync("target/idl/patula.json", "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
  const lp = new Program(lpIdl, provider) as any;
  const pool = new Program(poolIdl, provider) as any;
  const nul = (p: any) => ({
    nullifier0: PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.from(p.inputNullifiers[0])], pool.programId)[0],
    nullifier1: PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.from(p.inputNullifiers[1])], pool.programId)[0],
  });
  const me = new Keypair();

  // 1. deposit 0.3 SOL
  const amt = 3n * SOL / 10n;
  let tree = await getTree();
  const dep = await prove({ tree, inputs: [], outputs: [new Note(amt, me)], publicSol: amt, publicToken: 0n, extHash: transactHash(deployer.publicKey, deployer.publicKey, amt, 0n), wasm: WASM, zkey: ZKEY });
  await pool.methods.transact(dep.proof, new BN(amt.toString()), new BN(0))
    .accountsPartial({ ...nul(dep.proof), signer: deployer.publicKey, recipient: deployer.publicKey })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
  console.log("deposit 0.3 SOL");
  let sol = dep.outputs[0];

  // 2. pay for the anonymous launch with a private withdrawal to the relayer
  tree = await locate([sol]);
  const payChange = new Note(sol.amount - price - fee, me);
  const pay = await prove({ tree, inputs: [sol], outputs: [payChange], publicSol: -price - fee, publicToken: 0n, extHash: transactHash(relayer, relayer, -price, fee), wasm: WASM, zkey: ZKEY });
  const payment = (await post("/relay/transact", { proof: pay.proof, extAmount: -price, fee, recipient: relayer.toBase58() })).signature;
  console.log("paid launch privately:", payment);
  sol = pay.outputs[0];

  // 3. anonymous launch with creator fees: 1% buy, 2% sell, 50% to stakers
  const creator = SolKeypair.generate(), mint = SolKeypair.generate();
  const prep = await post("/launch/prepare", {
    name: "Night Marigold", symbol: "NOIR", uri: "", creator: creator.publicKey.toBase58(), mint: mint.publicKey.toBase58(),
    fees: { buyFeeBps: 100, sellFeeBps: 200, holderShareBps: 5000 }, payment,
  });
  const tx = Transaction.from(Buffer.from(prep.tx, "base64"));
  tx.partialSign(mint, creator);
  const launch = await post("/launch/submit", { tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  console.log("anonymous launch:", mint.publicKey.toBase58(), launch.signature);
  const launchSlot = await conn.getSlot("confirmed");

  // 4. private buy (2% of supply)
  while ((await conn.getSlot("confirmed")) < launchSlot + 12) await new Promise((r) => setTimeout(r, 500));
  const curvePda = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.publicKey.toBuffer()], lp.programId)[0];
  const cfg = await lp.account.config.fetch(PublicKey.findProgramAddressSync([Buffer.from("config")], lp.programId)[0]);
  let c = await lp.account.curve.fetch(curvePda);
  const vs = BigInt(c.virtualSol.toString()), vt = BigInt(c.virtualToken.toString());
  const tokensOut = 20_000_000n * 1_000_000n;
  const net = (vs * vt + (vt - tokensOut) - 1n) / (vt - tokensOut) - vs;
  const totalBps = BigInt(cfg.platformFeeBps + c.fees.buyFeeBps);
  const maxSol = (net * 10000n / (10000n - totalBps)) * 102n / 100n;
  tree = await locate([sol]);
  const tok = new Note(tokensOut, me, mint.publicKey);
  const buy = await prove({ tree, inputs: [sol], outputs: [tok, new Note(sol.amount - maxSol - fee, me)], mint: mint.publicKey,
    publicSol: -(maxSol + fee), publicToken: tokensOut, extHash: buyHash(mint.publicKey, relayer, tokensOut, maxSol, fee), wasm: WASM, zkey: ZKEY });
  console.log("private buy:", (await post("/relay/buy", { proof: buy.proof, mint: mint.publicKey.toBase58(), tokensOut, maxSol, fee })).signature);
  const [tokNote, solChange] = buy.outputs;

  // 5. private sell of half
  tree = await locate([tokNote, solChange]);
  c = await lp.account.curve.fetch(curvePda);
  const vs2 = BigInt(c.virtualSol.toString()), vt2 = BigInt(c.virtualToken.toString());
  const tokensIn = tokNote.amount / 2n;
  const gross = vs2 - (vs2 * vt2 + (vt2 + tokensIn) - 1n) / (vt2 + tokensIn);
  const minSol = (gross - gross * BigInt(cfg.platformFeeBps + c.fees.sellFeeBps) / 10000n) * 98n / 100n;
  const sell = await prove({ tree, inputs: [tokNote], outputs: [new Note(minSol - fee, me), new Note(tokNote.amount - tokensIn, me, mint.publicKey)], mint: mint.publicKey,
    publicSol: minSol - fee, publicToken: -tokensIn, extHash: sellHash(mint.publicKey, relayer, tokensIn, minSol, fee), wasm: WASM, zkey: ZKEY });
  console.log("private sell:", (await post("/relay/sell", { proof: sell.proof, mint: mint.publicKey.toBase58(), tokensIn, minSol, fee })).signature);

  // 6. withdraw the SOL notes to a fresh address
  const solFromSell = sell.outputs[0];
  tree = await locate([solChange, solFromSell]);
  const total = solChange.amount + solFromSell.amount;
  const fresh = SolKeypair.generate().publicKey;
  const ext = -(total - fee);
  const w = await prove({ tree, inputs: [solChange, solFromSell], outputs: [], publicSol: ext - fee, publicToken: 0n, extHash: transactHash(fresh, relayer, ext, fee), wasm: WASM, zkey: ZKEY });
  const wd = await post("/relay/transact", { proof: w.proof, extAmount: ext, fee, recipient: fresh.toBase58() });
  await conn.confirmTransaction(wd.signature, "confirmed");
  console.log("private withdraw ->", fresh.toBase58(), (await conn.getBalance(fresh)) / LAMPORTS_PER_SOL, "SOL");
  c = await lp.account.curve.fetch(curvePda);
  console.log("creator fees", Number(c.creatorFeesTotal) / 1e9, "SOL · holder rewards", Number(c.holderRewardsTotal) / 1e9, "SOL");
  console.log("MINT=" + mint.publicKey.toBase58());
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
