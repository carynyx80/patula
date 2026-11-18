// Shielded pool v2 (Phase 1b): private launch, private buy, private sell.
// Runs after tests/launchpad.ts on the same validator (launchpad config exists).
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Keypair as SolKeypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import * as path from "path";
import { Patula } from "../target/types/patula";
import { Launchpad } from "../target/types/launchpad";
import {
  buyHash, fromBytes, initPoseidon, Keypair, MerkleTree, Note, prove, sellHash, transactHash,
} from "../client/pool";

const SOL = BigInt(LAMPORTS_PER_SOL);
const WASM = path.join(__dirname, "..", "build/circuits/spend_js/spend.wasm");
const ZKEY = path.join(__dirname, "..", "build/circuits/spend.zkey");
const metrics: Record<string, unknown>[] = [];

describe("shielded pool v2 (phase 1b): private trading", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const pool = anchor.workspace.patula as Program<Patula>;
  const lp = anchor.workspace.launchpad as Program<Launchpad>;
  const conn = provider.connection;

  const pda = (prog: PublicKey, ...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, prog)[0];
  const poolPda = pda(pool.programId, Buffer.from("pool2"));
  const vaultPda = pda(pool.programId, Buffer.from("vault2"));
  const nullifierPda = (n: number[]) => pda(pool.programId, Buffer.from("nullifier"), Buffer.from(n));
  const lpConfig = pda(lp.programId, Buffer.from("config"));

  let tree: MerkleTree;
  const depositor = SolKeypair.generate();
  const relayer = SolKeypair.generate();
  const anonCreator = SolKeypair.generate(); // never funded, never linked
  const mint = SolKeypair.generate();
  const alice = new Keypair();
  let feeRecipient: PublicKey;
  let alt: PublicKey;
  let solNote: Note;
  let tokenNote: Note;
  let lastBuyProof: any;

  const curve = pda(lp.programId, Buffer.from("curve"), mint.publicKey.toBuffer());
  const lpAccounts = () => ({
    mint: mint.publicKey,
    poolToken: getAssociatedTokenAddressSync(mint.publicKey, vaultPda, true),
    lpConfig,
    lpCurve: curve,
    lpCurveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true),
    lpSolVault: pda(lp.programId, Buffer.from("sol_vault"), mint.publicKey.toBuffer()),
    lpRewards: pda(lp.programId, Buffer.from("rewards"), mint.publicKey.toBuffer()),
    lpFeeRecipient: feeRecipient,
    lpCreator: anonCreator.publicKey,
    launchpadProgram: lp.programId,
  });

  /** v0 transaction through the address lookup table (private trades exceed 1232 bytes without it). */
  async function sendV0(label: string, ixs: TransactionInstruction[], signers: SolKeypair[], extra: Record<string, unknown> = {}) {
    const table = (await conn.getAddressLookupTable(alt)).value!;
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs],
    }).compileToV0Message([table]);
    const tx = new VersionedTransaction(msg);
    tx.sign(signers);
    const size = tx.serialize().length;
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
    const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (info?.meta?.err) throw new Error(JSON.stringify(info.meta.err));
    metrics.push({ tx: label, computeUnits: info!.meta!.computeUnitsConsumed, txBytes: size, ...extra });
    return sig;
  }

  const record = (outputs: Note[]) => outputs.forEach((o) => { o.index = tree.leaves.length; tree.insert(o.commitment); });
  async function onchainRoot() {
    const p = await pool.account.pool.fetch(poolPda);
    return fromBytes(p.roots[p.currentRootIndex.toNumber()]);
  }
  async function quoteCost(tokens: bigint) {
    const c = await lp.account.curve.fetch(curve);
    const cfg = await lp.account.config.fetch(lpConfig);
    const vs = BigInt(c.virtualSol.toString()), vt = BigInt(c.virtualToken.toString());
    const newVs = (vs * vt + (vt - tokens) - 1n) / (vt - tokens);
    const net = newVs - vs;
    const total = BigInt(cfg.platformFeeBps + c.fees.buyFeeBps);
    return net + (net * total + (10000n - total) - 1n) / (10000n - total);
  }
  async function quoteSellOut(tokens: bigint) {
    const c = await lp.account.curve.fetch(curve);
    const vs = BigInt(c.virtualSol.toString()), vt = BigInt(c.virtualToken.toString());
    const gross = vs - (vs * vt + (vt + tokens) - 1n) / (vt + tokens);
    const cfg = await lp.account.config.fetch(lpConfig);
    return gross - (gross * BigInt(cfg.platformFeeBps + c.fees.sellFeeBps)) / 10000n;
  }

  before(async () => {
    await initPoseidon();
    tree = new MerkleTree();
    for (const kp of [depositor, relayer]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
    }
    feeRecipient = (await lp.account.config.fetch(lpConfig)).feeRecipient;
  });

  it("initializes pool v2", async () => {
    await pool.methods.initialize().accountsPartial({ pool: poolPda, vault: vaultPda }).rpc({ commitment: "confirmed" });
    expect((await onchainRoot()).toString()).to.eq(tree.root().toString());
  });

  it("launches a token privately: relayer pays, an unfunded fresh key is the creator", async () => {
    // The relayer funds the creator key's rent so creator fees can land in it.
    const rent = await conn.getMinimumBalanceForRentExemption(0);
    await lp.methods
      .createToken("Shadow Bloom", "SHDW", "", { buyFeeBps: 100, sellFeeBps: 100, holderShareBps: 5000 })
      .accountsPartial({
        payer: relayer.publicKey,
        creator: anonCreator.publicKey,
        mint: mint.publicKey,
        curve,
        curveTokenVault: lpAccounts().lpCurveTokenVault,
        solVault: lpAccounts().lpSolVault,
        feeRecipient,
      })
      .preInstructions([SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: anonCreator.publicKey, lamports: rent })])
      .signers([relayer, anonCreator, mint])
      .rpc({ commitment: "confirmed" });
    const c = await lp.account.curve.fetch(curve);
    expect(c.creator.toBase58()).to.eq(anonCreator.publicKey.toBase58());
    expect(await conn.getBalance(anonCreator.publicKey)).to.eq(rent); // only rent, from the relayer
  });

  it("creates the address lookup table used by private trades", async () => {
    const slot = await conn.getSlot("finalized");
    const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: relayer.publicKey, payer: relayer.publicKey, recentSlot: slot });
    alt = table;
    const a = lpAccounts();
    const extend = AddressLookupTableProgram.extendLookupTable({
      lookupTable: table, authority: relayer.publicKey, payer: relayer.publicKey,
      addresses: [poolPda, vaultPda, lp.programId, lpConfig, feeRecipient, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        SystemProgram.programId, a.mint, a.poolToken, a.lpCurve, a.lpCurveTokenVault, a.lpSolVault, a.lpRewards, a.lpCreator],
    });
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: [create, extend] }).compileToV0Message());
    tx.sign([relayer]);
    await conn.confirmTransaction(await conn.sendTransaction(tx), "confirmed");
    await new Promise((r) => setTimeout(r, 1200)); // lookup tables activate after one slot
  });

  it("deposits 1 SOL into a shielded note", async () => {
    solNote = new Note(SOL, alice);
    const { proof, outputs, proveMs } = await prove({
      tree, inputs: [], outputs: [solNote], publicSol: SOL, publicToken: 0n,
      extHash: transactHash(depositor.publicKey, depositor.publicKey, SOL, 0n), wasm: WASM, zkey: ZKEY,
    });
    const ix = await pool.methods.transact(proof as any, new BN(SOL.toString()), new BN(0))
      .accountsPartial({
        pool: poolPda, vault: vaultPda, nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]),
        signer: depositor.publicKey, recipient: depositor.publicKey,
      }).instruction();
    await sendV0("deposit 1 SOL", [ix], [depositor], { proveMs });
    record(outputs);
    solNote = outputs[0];
    expect((await onchainRoot()).toString()).to.eq(tree.root().toString());
  });

  it("buys tokens privately: the pool vault is the buyer, no user wallet signs", async () => {
    // wait out the anti-sniper window
    const launch = (await lp.account.curve.fetch(curve)).launchSlot.toNumber();
    while ((await conn.getSlot("confirmed")) < launch + 11) await new Promise((r) => setTimeout(r, 400));

    const tokensOut = 50_000_000n * 1_000_000n; // 50M tokens (5%)
    const cost = await quoteCost(tokensOut);
    const maxSol = (cost * 101n) / 100n; // 1% slippage room
    const fee = 2_000_000n;
    const change = new Note(SOL - maxSol - fee, alice);
    tokenNote = new Note(tokensOut, alice, mint.publicKey);
    const relayerBefore = await conn.getBalance(relayer.publicKey);

    const { proof, outputs, proveMs } = await prove({
      tree, inputs: [solNote], outputs: [tokenNote, change], mint: mint.publicKey,
      publicSol: -(maxSol + fee), publicToken: tokensOut,
      extHash: buyHash(mint.publicKey, relayer.publicKey, tokensOut, maxSol, fee), wasm: WASM, zkey: ZKEY,
    });
    lastBuyProof = { proof, tokensOut, maxSol, fee };
    const ix = await pool.methods.privateBuy(proof as any, new BN(tokensOut.toString()), new BN(maxSol.toString()), new BN(fee.toString()))
      .accountsPartial({
        pool: poolPda, vault: vaultPda, nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]),
        relayer: relayer.publicKey, ...lpAccounts(),
      }).instruction();
    await sendV0("private buy", [ix], [relayer], { proveMs });
    record(outputs);
    tokenNote = outputs[0];
    solNote = outputs[1];

    expect((await getAccount(conn, lpAccounts().poolToken)).amount.toString()).to.eq(tokensOut.toString());
    expect((await onchainRoot()).toString()).to.eq(tree.root().toString());
    metrics[metrics.length - 1].relayerNetLamports = (await conn.getBalance(relayer.publicKey)) - relayerBefore;
  });

  it("rejects the same buy proof replayed (nullifiers spent)", async () => {
    const { proof, tokensOut, maxSol, fee } = lastBuyProof;
    let msg = "";
    try {
      const ix = await pool.methods.privateBuy(proof, new BN(tokensOut.toString()), new BN(maxSol.toString()), new BN(fee.toString()))
        .accountsPartial({ pool: poolPda, vault: vaultPda, nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]), relayer: relayer.publicKey, ...lpAccounts() })
        .instruction();
      await sendV0("replay", [ix], [relayer]);
    } catch (e) { msg = String(e); }
    expect(msg).to.match(/already in use|0x0|custom program error/);
  });

  it("rejects a proof submitted with a larger token amount than it proves", async () => {
    // fresh dummy proof bound to a 1-token buy, submitted as a 2-token buy
    const { proof } = await prove({
      tree, inputs: [], outputs: [], mint: mint.publicKey, publicSol: 0n, publicToken: 0n,
      extHash: buyHash(mint.publicKey, relayer.publicKey, 1n, 0n, 0n), wasm: WASM, zkey: ZKEY,
    });
    let msg = "";
    try {
      const ix = await pool.methods.privateBuy(proof as any, new BN(2), new BN(0), new BN(0))
        .accountsPartial({ pool: poolPda, vault: vaultPda, nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]), relayer: relayer.publicKey, ...lpAccounts() })
        .instruction();
      await sendV0("tampered", [ix], [relayer]);
    } catch (e) { msg = String(e); }
    expect(msg).to.match(/InvalidProof|0x1773|6003/);
  });

  it("sells half the tokens privately for SOL", async () => {
    const tokensIn = tokenNote.amount / 2n;
    const minSol = ((await quoteSellOut(tokensIn)) * 99n) / 100n;
    const fee = 2_000_000n;
    const solOut = new Note(minSol - fee, alice);
    const tokenChange = new Note(tokenNote.amount - tokensIn, alice, mint.publicKey);
    const poolTokensBefore = (await getAccount(conn, lpAccounts().poolToken)).amount;

    const { proof, outputs, proveMs } = await prove({
      tree, inputs: [tokenNote], outputs: [solOut, tokenChange], mint: mint.publicKey,
      publicSol: minSol - fee, publicToken: -tokensIn,
      extHash: sellHash(mint.publicKey, relayer.publicKey, tokensIn, minSol, fee), wasm: WASM, zkey: ZKEY,
    });
    const ix = await pool.methods.privateSell(proof as any, new BN(tokensIn.toString()), new BN(minSol.toString()), new BN(fee.toString()))
      .accountsPartial({ pool: poolPda, vault: vaultPda, nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]), relayer: relayer.publicKey, ...lpAccounts() })
      .instruction();
    await sendV0("private sell", [ix], [relayer], { proveMs });
    record(outputs);
    const poolTokensAfter = (await getAccount(conn, lpAccounts().poolToken)).amount;
    expect((poolTokensBefore - poolTokensAfter).toString()).to.eq(tokensIn.toString());
    // merge the two SOL notes next
    solNote = solNote; // change from the buy
    tokenNote = outputs[1];
    (globalThis as any).__sellSol = outputs[0];
  });

  it("merges two SOL notes and withdraws to a brand-new address", async () => {
    const a = solNote, b = (globalThis as any).__sellSol as Note;
    const fee = 2_000_000n;
    const total = a.amount + b.amount;
    const fresh = SolKeypair.generate().publicKey;
    const ext = -(total - fee);
    const { proof, proveMs } = await prove({
      tree, inputs: [a, b], outputs: [], publicSol: ext - fee, publicToken: 0n,
      extHash: transactHash(fresh, relayer.publicKey, ext, fee), wasm: WASM, zkey: ZKEY,
    });
    const ix = await pool.methods.transact(proof as any, new BN(ext.toString()), new BN(fee.toString()))
      .accountsPartial({ pool: poolPda, vault: vaultPda, nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]), signer: relayer.publicKey, recipient: fresh })
      .instruction();
    await sendV0("withdraw (2 notes merged)", [ix], [relayer], { proveMs });
    expect(BigInt(await conn.getBalance(fresh))).to.eq(total - fee);
  });

  after(() => {
    console.log("\n=== Phase 1b metrics ===");
    console.table(metrics);
  });
});
