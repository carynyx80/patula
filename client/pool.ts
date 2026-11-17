// Patula shielded-pool client helpers (Phase 0 prototype).
import { createHash, randomBytes } from "crypto";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildPoseidon } = require("circomlibjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const snarkjs = require("snarkjs");

export const LEVELS = 20;
/** BN254 scalar field (circuit field). */
export const FIELD_R = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);
/** BN254 base field (curve coordinates). */
const FIELD_Q = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583"
);

const BUILD = path.join(__dirname, "..", "build", "circuits");
const WASM = path.join(BUILD, "transaction_js", "transaction.wasm");
const ZKEY = path.join(BUILD, "transaction.zkey");

let poseidonImpl: any;
export async function initPoseidon() {
  if (!poseidonImpl) poseidonImpl = await buildPoseidon();
}
export function poseidon(inputs: bigint[]): bigint {
  return poseidonImpl.F.toObject(poseidonImpl(inputs));
}

export const randomField = () => BigInt("0x" + randomBytes(31).toString("hex"));

export function toBytes32(x: bigint): number[] {
  return [...Buffer.from(x.toString(16).padStart(64, "0"), "hex")];
}
export const fromBytes = (b: Uint8Array | number[]) =>
  BigInt("0x" + Buffer.from(b).toString("hex"));

export class Keypair {
  constructor(public privkey: bigint = randomField()) {}
  get pubkey(): bigint {
    return poseidon([this.privkey]);
  }
}

export class Note {
  index = 0;
  constructor(
    public amount: bigint,
    public keypair: Keypair = new Keypair(),
    public blinding: bigint = randomField()
  ) {}
  get commitment(): bigint {
    return poseidon([this.amount, this.keypair.pubkey, this.blinding]);
  }
  get nullifier(): bigint {
    const c = this.commitment;
    const sig = poseidon([this.keypair.privkey, c, BigInt(this.index)]);
    return poseidon([c, BigInt(this.index), sig]);
  }
}

/** Off-chain mirror of the on-chain incremental Merkle tree. */
export class MerkleTree {
  leaves: bigint[] = [];
  zeros: bigint[] = [];
  constructor() {
    let z = BigInt(0);
    for (let i = 0; i <= LEVELS; i++) {
      this.zeros.push(z);
      z = poseidon([z, z]);
    }
  }
  insert(leaf: bigint) {
    this.leaves.push(leaf);
  }
  private layers(): bigint[][] {
    const layers = [this.leaves.slice()];
    for (let l = 0; l < LEVELS; l++) {
      const prev = layers[l];
      const next: bigint[] = [];
      for (let i = 0; i < Math.ceil(prev.length / 2); i++) {
        const left = prev[2 * i];
        const right = 2 * i + 1 < prev.length ? prev[2 * i + 1] : this.zeros[l];
        next.push(poseidon([left, right]));
      }
      layers.push(next);
    }
    return layers;
  }
  root(): bigint {
    if (this.leaves.length === 0) return this.zeros[LEVELS];
    return this.layers()[LEVELS][0];
  }
  path(index: number): bigint[] {
    const layers = this.layers();
    const out: bigint[] = [];
    let idx = index;
    for (let l = 0; l < LEVELS; l++) {
      const sib = idx ^ 1;
      out.push(sib < layers[l].length ? layers[l][sib] : this.zeros[l]);
      idx >>= 1;
    }
    return out;
  }
}

export function extDataHash(
  recipient: PublicKey,
  relayer: PublicKey,
  extAmount: bigint,
  fee: bigint
): bigint {
  const ext = Buffer.alloc(8);
  ext.writeBigInt64LE(extAmount);
  const f = Buffer.alloc(8);
  f.writeBigUInt64LE(fee);
  const h = createHash("sha256")
    .update(Buffer.concat([recipient.toBuffer(), relayer.toBuffer(), ext, f]))
    .digest();
  h[0] = 0;
  return fromBytes(h);
}

const mod = (x: bigint, m: bigint) => ((x % m) + m) % m;

function g1Bytes(p: string[], negate = false): number[] {
  const x = BigInt(p[0]);
  const y = negate ? mod(FIELD_Q - BigInt(p[1]), FIELD_Q) : BigInt(p[1]);
  return [...toBytes32(x), ...toBytes32(y)];
}
function g2Bytes(p: string[][]): number[] {
  return [
    ...toBytes32(BigInt(p[0][1])),
    ...toBytes32(BigInt(p[0][0])),
    ...toBytes32(BigInt(p[1][1])),
    ...toBytes32(BigInt(p[1][0])),
  ];
}

export interface TxPlan {
  tree: MerkleTree;
  inputs: Note[]; // padded to 2 with zero notes
  outputs: Note[]; // padded to 2 with zero notes
  extAmount: bigint;
  fee: bigint;
  recipient: PublicKey;
  relayer: PublicKey;
}

export async function prove(plan: TxPlan) {
  const inputs = [...plan.inputs];
  while (inputs.length < 2) inputs.push(new Note(BigInt(0)));
  const outputs = [...plan.outputs];
  while (outputs.length < 2) outputs.push(new Note(BigInt(0)));

  const root = plan.tree.root();
  const publicAmount = mod(plan.extAmount - plan.fee, FIELD_R);
  const edh = extDataHash(plan.recipient, plan.relayer, plan.extAmount, plan.fee);

  const witness = {
    root,
    publicAmount,
    extDataHash: edh,
    inputNullifier: inputs.map((n) => n.nullifier),
    outputCommitment: outputs.map((n) => n.commitment),
    inAmount: inputs.map((n) => n.amount),
    inPrivateKey: inputs.map((n) => n.keypair.privkey),
    inBlinding: inputs.map((n) => n.blinding),
    inPathIndices: inputs.map((n) => n.index),
    inPathElements: inputs.map((n) =>
      n.amount > BigInt(0) ? plan.tree.path(n.index) : new Array(LEVELS).fill(BigInt(0))
    ),
    outAmount: outputs.map((n) => n.amount),
    outPubkey: outputs.map((n) => n.keypair.pubkey),
    outBlinding: outputs.map((n) => n.blinding),
  };
  const toStr = (v: any): any =>
    Array.isArray(v) ? v.map(toStr) : typeof v === "bigint" ? v.toString() : v;
  const sw: any = {};
  for (const k of Object.keys(witness)) sw[k] = toStr((witness as any)[k]);

  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(sw, WASM, ZKEY);
  const proveMs = Date.now() - t0;

  return {
    proveMs,
    outputs,
    args: {
      proofA: g1Bytes(proof.pi_a, true),
      proofB: g2Bytes(proof.pi_b),
      proofC: g1Bytes(proof.pi_c),
      root: toBytes32(root),
      publicAmount: toBytes32(publicAmount),
      extAmount: plan.extAmount,
      fee: plan.fee,
      inputNullifiers: inputs.map((n) => toBytes32(n.nullifier)),
      outputCommitments: outputs.map((n) => toBytes32(n.commitment)),
    },
  };
}
