// Patula shielded-pool client (v2: multi-asset notes, private trading).
// Runs in Node (tests, scripts, relayer) and in the browser (web app).
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildPoseidon } = require("circomlibjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const snarkjs = require("snarkjs");

export const LEVELS = 20;
export const FIELD_R = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
const FIELD_Q = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");

let poseidonImpl: any;
export async function initPoseidon() {
  if (!poseidonImpl) poseidonImpl = await buildPoseidon();
}
export function poseidon(inputs: bigint[]): bigint {
  return poseidonImpl.F.toObject(poseidonImpl(inputs));
}

const randomBytes = (n: number) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const randomField = () => BigInt("0x" + hex(randomBytes(31)));
export const fromBytes = (b: Uint8Array | number[]) => BigInt("0x" + hex(Uint8Array.from(b)) || "0");
export function toBytes32(x: bigint): number[] {
  const h = x.toString(16).padStart(64, "0");
  return Array.from({ length: 32 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}
const mod = (x: bigint, m: bigint) => ((x % m) + m) % m;

/** A token's asset id inside notes: its mint with the top byte cleared. */
export function mintField(mint: PublicKey): bigint {
  const b = mint.toBytes();
  b[0] = 0;
  return fromBytes(b);
}

export class Keypair {
  constructor(public privkey: bigint = randomField()) {}
  get pubkey(): bigint {
    return poseidon([this.privkey]);
  }
}

/** A shielded note. `mint` undefined = SOL. */
export class Note {
  index = 0;
  constructor(
    public amount: bigint,
    public keypair: Keypair = new Keypair(),
    public mint?: PublicKey,
    public blinding: bigint = randomField()
  ) {}
  get asset(): bigint {
    return this.mint ? mintField(this.mint) : 0n;
  }
  get commitment(): bigint {
    return poseidon([this.amount, this.keypair.pubkey, this.blinding, this.asset]);
  }
  get nullifier(): bigint {
    const c = this.commitment;
    const sig = poseidon([this.keypair.privkey, c, BigInt(this.index)]);
    return poseidon([c, BigInt(this.index), sig]);
  }
  toJSON() {
    return {
      amount: this.amount.toString(), privkey: this.keypair.privkey.toString(), blinding: this.blinding.toString(),
      mint: this.mint?.toBase58() ?? null, index: this.index,
    };
  }
  static fromJSON(j: any): Note {
    const n = new Note(BigInt(j.amount), new Keypair(BigInt(j.privkey)), j.mint ? new PublicKey(j.mint) : undefined, BigInt(j.blinding));
    n.index = j.index;
    return n;
  }
}

/** Off-chain mirror of the on-chain incremental Merkle tree. */
export class MerkleTree {
  leaves: bigint[] = [];
  zeros: bigint[] = [];
  constructor(leaves: bigint[] = []) {
    let z = 0n;
    for (let i = 0; i <= LEVELS; i++) {
      this.zeros.push(z);
      z = poseidon([z, z]);
    }
    this.leaves = [...leaves];
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
        next.push(poseidon([prev[2 * i], 2 * i + 1 < prev.length ? prev[2 * i + 1] : this.zeros[l]]));
      }
      layers.push(next);
    }
    return layers;
  }
  root(): bigint {
    return this.leaves.length === 0 ? this.zeros[LEVELS] : this.layers()[LEVELS][0];
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

// ---- external data hashes (must match programs/patula ext_data_hash) ----

const le64 = (v: bigint, signed = false) => {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  signed ? dv.setBigInt64(0, v, true) : dv.setBigUint64(0, v, true);
  return b;
};
function extHash(parts: Uint8Array[]): bigint {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  const h = sha256(buf);
  h[0] = 0;
  return fromBytes(h);
}
export const transactHash = (recipient: PublicKey, relayer: PublicKey, extAmount: bigint, fee: bigint) =>
  extHash([Uint8Array.of(0), recipient.toBytes(), relayer.toBytes(), le64(extAmount, true), le64(fee)]);
export const buyHash = (mint: PublicKey, relayer: PublicKey, tokensOut: bigint, maxSol: bigint, fee: bigint) =>
  extHash([Uint8Array.of(1), mint.toBytes(), relayer.toBytes(), le64(tokensOut), le64(maxSol), le64(fee)]);
export const sellHash = (mint: PublicKey, relayer: PublicKey, tokensIn: bigint, minSol: bigint, fee: bigint) =>
  extHash([Uint8Array.of(2), mint.toBytes(), relayer.toBytes(), le64(tokensIn), le64(minSol), le64(fee)]);

// ---- proving ----

function g1Bytes(p: string[], negate = false): number[] {
  const y = negate ? mod(FIELD_Q - BigInt(p[1]), FIELD_Q) : BigInt(p[1]);
  return [...toBytes32(BigInt(p[0])), ...toBytes32(y)];
}
function g2Bytes(p: string[][]): number[] {
  return [...toBytes32(BigInt(p[0][1])), ...toBytes32(BigInt(p[0][0])), ...toBytes32(BigInt(p[1][1])), ...toBytes32(BigInt(p[1][0]))];
}

export interface ProveInput {
  tree: MerkleTree;
  inputs: Note[];
  outputs: Note[];
  mint?: PublicKey; // token asset for this transaction (all token notes must use it)
  publicSol: bigint; // signed
  publicToken: bigint; // signed
  extHash: bigint;
  wasm: string | Uint8Array; // path (Node) or URL/bytes (browser)
  zkey: string | Uint8Array;
}

export async function prove(p: ProveInput) {
  const inputs = [...p.inputs];
  while (inputs.length < 2) inputs.push(new Note(0n));
  const outputs = [...p.outputs];
  while (outputs.length < 2) outputs.push(new Note(0n));
  const asset = p.mint ? mintField(p.mint) : 0n;
  for (const n of [...inputs, ...outputs]) {
    if (n.mint && (!p.mint || !n.mint.equals(p.mint))) throw new Error("note asset does not match transaction asset");
  }
  const root = p.tree.root();
  const w: Record<string, unknown> = {
    root,
    publicAmountSol: mod(p.publicSol, FIELD_R),
    publicAmountToken: mod(p.publicToken, FIELD_R),
    assetToken: asset,
    extDataHash: p.extHash,
    inputNullifier: inputs.map((n) => n.nullifier),
    outputCommitment: outputs.map((n) => n.commitment),
    inAmount: inputs.map((n) => n.amount),
    inPrivateKey: inputs.map((n) => n.keypair.privkey),
    inBlinding: inputs.map((n) => n.blinding),
    inIsToken: inputs.map((n) => (n.mint ? 1n : 0n)),
    inPathIndices: inputs.map((n) => n.index),
    inPathElements: inputs.map((n) => (n.amount > 0n ? p.tree.path(n.index) : new Array(LEVELS).fill(0n))),
    outAmount: outputs.map((n) => n.amount),
    outPubkey: outputs.map((n) => n.keypair.pubkey),
    outBlinding: outputs.map((n) => n.blinding),
    outIsToken: outputs.map((n) => (n.mint ? 1n : 0n)),
  };
  const str = (v: any): any => (Array.isArray(v) ? v.map(str) : typeof v === "bigint" ? v.toString() : v);
  const t0 = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(str(w), p.wasm, p.zkey);
  return {
    proveMs: Date.now() - t0,
    outputs,
    proof: {
      a: g1Bytes(proof.pi_a, true),
      b: g2Bytes(proof.pi_b),
      c: g1Bytes(proof.pi_c),
      root: toBytes32(root),
      inputNullifiers: inputs.map((n) => toBytes32(n.nullifier)),
      outputCommitments: outputs.map((n) => toBytes32(n.commitment)),
    },
  };
}

/** Pick SOL or token notes covering `amount` (largest first, at most 2). */
export function selectNotes(notes: Note[], amount: bigint, mint?: PublicKey): Note[] {
  const pool = notes
    .filter((n) => n.amount > 0n && (mint ? n.mint?.equals(mint) : !n.mint))
    .sort((a, b) => (b.amount > a.amount ? 1 : -1));
  if (pool[0] && pool[0].amount >= amount) return [pool[0]];
  if (pool.length >= 2 && pool[0].amount + pool[1].amount >= amount) return [pool[0], pool[1]];
  throw new Error("not enough shielded balance (max 2 notes per transaction)");
}
