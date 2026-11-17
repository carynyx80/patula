import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair as SolKeypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";
import { Patula } from "../target/types/patula";
import {
  initPoseidon,
  Keypair,
  MerkleTree,
  Note,
  prove,
  fromBytes,
  TxPlan,
} from "../client/pool";

const SOL = BigInt(LAMPORTS_PER_SOL);
const metrics: Record<string, any>[] = [];

describe("patula shielded pool (phase 0)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.patula as Program<Patula>;
  const conn = provider.connection;

  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool")], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId);
  const nullifierPda = (n: number[]) =>
    PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.from(n)], program.programId)[0];

  let tree: MerkleTree;
  const depositor = SolKeypair.generate();
  const relayer = SolKeypair.generate();
  const freshRecipient = SolKeypair.generate().publicKey; // never funded, never linked
  const alice = new Keypair(); // shielded identities
  const bob = new Keypair();
  let aliceNote: Note;
  let bobNote: Note;
  let lastBobArgs: any;

  async function send(label: string, plan: TxPlan, signer: SolKeypair) {
    const { args, proveMs, outputs } = await prove(plan);
    const sig = await program.methods
      .transact({
        ...args,
        extAmount: new BN(args.extAmount.toString()),
        fee: new BN(args.fee.toString()),
      } as any)
      .accountsPartial({
        pool: poolPda,
        vault: vaultPda,
        nullifier0: nullifierPda(args.inputNullifiers[0]),
        nullifier1: nullifierPda(args.inputNullifiers[1]),
        signer: signer.publicKey,
        recipient: plan.recipient,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .signers([signer])
      .rpc({ commitment: "confirmed" });
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const size = tx!.transaction.message.serialize().length + 64 * tx!.transaction.signatures.length;
    metrics.push({
      tx: label,
      proveMs,
      computeUnits: tx!.meta!.computeUnitsConsumed,
      txBytes: size,
      feeLamports: tx!.meta!.fee,
    });
    // Mirror the on-chain tree.
    outputs.forEach((o) => {
      o.index = tree.leaves.length;
      tree.insert(o.commitment);
    });
    return { args, outputs };
  }

  async function onchainRoot(): Promise<bigint> {
    const pool = await program.account.pool.fetch(poolPda);
    return fromBytes(pool.roots[pool.currentRootIndex.toNumber()]);
  }

  before(async () => {
    await initPoseidon();
    tree = new MerkleTree();
    for (const kp of [depositor, relayer]) {
      const s = await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(s, "confirmed");
    }
  });

  it("initializes the pool with the same empty root as the client", async () => {
    await program.methods.initialize().accountsPartial({ pool: poolPda, vault: vaultPda }).rpc();
    expect((await onchainRoot()).toString()).to.eq(tree.root().toString());
  });

  it("deposits 1 SOL into a shielded note (public deposit)", async () => {
    aliceNote = new Note(SOL, alice);
    await send(
      "deposit 1 SOL",
      {
        tree,
        inputs: [],
        outputs: [aliceNote],
        extAmount: SOL,
        fee: BigInt(0),
        recipient: depositor.publicKey,
        relayer: depositor.publicKey,
      },
      depositor
    );
    expect((await onchainRoot()).toString()).to.eq(tree.root().toString());
    expect(await conn.getBalance(vaultPda)).to.be.greaterThan(LAMPORTS_PER_SOL);
  });

  it("sends 0.4 SOL privately to Bob via a relayer (no public wallet signs)", async () => {
    const fee = BigInt(1_000_000); // 0.001 SOL to the relayer
    bobNote = new Note((SOL * BigInt(4)) / BigInt(10), bob);
    const change = new Note(SOL - bobNote.amount - fee, alice);
    const relayerBefore = await conn.getBalance(relayer.publicKey);
    const { outputs } = await send(
      "private transfer (relayed)",
      {
        tree,
        inputs: [aliceNote],
        outputs: [bobNote, change],
        extAmount: BigInt(0),
        fee,
        recipient: relayer.publicKey,
        relayer: relayer.publicKey,
      },
      relayer
    );
    bobNote = outputs[0];
    expect((await onchainRoot()).toString()).to.eq(tree.root().toString());
    const relayerAfter = await conn.getBalance(relayer.publicKey);
    metrics[metrics.length - 1].relayerNetLamports = relayerAfter - relayerBefore;
  });

  it("withdraws Bob's note to a brand-new address", async () => {
    const fee = BigInt(1_000_000);
    const extAmount = -(bobNote.amount - fee);
    const { args } = await send(
      "withdraw to fresh address (relayed)",
      {
        tree,
        inputs: [bobNote],
        outputs: [],
        extAmount,
        fee,
        recipient: freshRecipient,
        relayer: relayer.publicKey,
      },
      relayer
    );
    lastBobArgs = args;
    expect(BigInt(await conn.getBalance(freshRecipient))).to.eq(bobNote.amount - fee);
  });

  it("rejects a double spend of the same note", async () => {
    let failed = false;
    try {
      await send(
        "double spend",
        {
          tree,
          inputs: [bobNote],
          outputs: [],
          extAmount: -(bobNote.amount - BigInt(1_000_000)),
          fee: BigInt(1_000_000),
          recipient: freshRecipient,
          relayer: relayer.publicKey,
        },
        relayer
      );
    } catch (e: any) {
      failed = true;
      expect(String(e)).to.match(/already in use|0x0/);
    }
    expect(failed).to.eq(true);
  });

  it("rejects a valid proof replayed with a different recipient", async () => {
    // Fresh valid proof for Alice's change note, but submitted with another recipient.
    const aliceChange = new Note(BigInt(0)); // dummy spend → proof is valid, recipient bound
    const attacker = SolKeypair.generate().publicKey;
    const { args } = await prove({
      tree,
      inputs: [aliceChange],
      outputs: [],
      extAmount: BigInt(0),
      fee: BigInt(0),
      recipient: freshRecipient,
      relayer: relayer.publicKey,
    });
    let msg = "";
    try {
      await program.methods
        .transact({ ...args, extAmount: new BN(0), fee: new BN(0) } as any)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifier0: nullifierPda(args.inputNullifiers[0]),
          nullifier1: nullifierPda(args.inputNullifiers[1]),
          signer: relayer.publicKey,
          recipient: attacker,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .signers([relayer])
        .rpc();
    } catch (e: any) {
      msg = String(e);
    }
    expect(msg).to.match(/InvalidProof|Invalid zero-knowledge proof/);
  });

  after(async () => {
    console.log("\n=== Phase 0 metrics ===");
    console.table(metrics);
    const rent = await conn.getMinimumBalanceForRentExemption(8);
    console.log(`Nullifier rent per tx: ${(2 * rent) / LAMPORTS_PER_SOL} SOL (2 PDAs)`);
    require("fs").writeFileSync("build/metrics.json", JSON.stringify(metrics, null, 2));
  });
});
