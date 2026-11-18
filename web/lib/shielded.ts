// Browser side of the Patula shielded pool: notes, Merkle tree, proofs
// (snarkjs in the browser), encrypted local note storage and relayer calls.
// Mirrors client/pool.ts and programs/patula.
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { poseidon1, poseidon2, poseidon3, poseidon4 } from "poseidon-lite";
import { API_URL } from "./api";

export const LEVELS = 20;
const FIELD_R = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
const FIELD_Q = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");
const mod = (x: bigint, m: bigint) => ((x % m) + m) % m;

export function poseidon(xs: bigint[]): bigint {
  switch (xs.length) {
    case 1: return poseidon1(xs);
    case 2: return poseidon2(xs);
    case 3: return poseidon3(xs);
    case 4: return poseidon4(xs);
    default: throw new Error("poseidon arity");
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromBytes = (b: Uint8Array | number[]) => BigInt("0x" + (hex(Uint8Array.from(b)) || "0"));
export function toBytes32(x: bigint): number[] {
  const h = x.toString(16).padStart(64, "0");
  return Array.from({ length: 32 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}
export function randomField(): bigint {
  const b = new Uint8Array(31);
  crypto.getRandomValues(b);
  return fromBytes(b);
}
export function mintField(mint: PublicKey): bigint {
  const b = mint.toBytes();
  b[0] = 0;
  return fromBytes(b);
}

export class Note {
  index = -1;
  constructor(public amount: bigint, public privkey: bigint, public mint?: string, public blinding: bigint = randomField()) {}
  get pubkey() { return poseidon([this.privkey]); }
  get asset() { return this.mint ? mintField(new PublicKey(this.mint)) : 0n; }
  get commitment() { return poseidon([this.amount, this.pubkey, this.blinding, this.asset]); }
  get nullifier() {
    const c = this.commitment;
    return poseidon([c, BigInt(this.index), poseidon([this.privkey, c, BigInt(this.index)])]);
  }
  toJSON() { return { a: this.amount.toString(), k: this.privkey.toString(), b: this.blinding.toString(), m: this.mint ?? null, i: this.index }; }
  static fromJSON(j: { a: string; k: string; b: string; m: string | null; i: number }) {
    const n = new Note(BigInt(j.a), BigInt(j.k), j.m ?? undefined, BigInt(j.b));
    n.index = j.i;
    return n;
  }
}

export class MerkleTree {
  zeros: bigint[] = [];
  private layers: bigint[][];
  constructor(public leaves: bigint[]) {
    let z = 0n;
    for (let i = 0; i <= LEVELS; i++) { this.zeros.push(z); z = poseidon([z, z]); }
    this.layers = [leaves.slice()];
    for (let l = 0; l < LEVELS; l++) {
      const prev = this.layers[l];
      const next: bigint[] = [];
      for (let i = 0; i < Math.ceil(prev.length / 2); i++) {
        next.push(poseidon([prev[2 * i], 2 * i + 1 < prev.length ? prev[2 * i + 1] : this.zeros[l]]));
      }
      this.layers.push(next);
    }
  }
  root() { return this.leaves.length ? this.layers[LEVELS][0] : this.zeros[LEVELS]; }
  path(index: number) {
    const out: bigint[] = [];
    let idx = index;
    for (let l = 0; l < LEVELS; l++) {
      const sib = idx ^ 1;
      out.push(sib < this.layers[l].length ? this.layers[l][sib] : this.zeros[l]);
      idx >>= 1;
    }
    return out;
  }
}

// ---- external data hashes (must match programs/patula) ----

const le64 = (v: bigint, signed = false) => {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  if (signed) dv.setBigInt64(0, v, true); else dv.setBigUint64(0, v, true);
  return b;
};
function extHash(parts: Uint8Array[]) {
  const buf = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  const h = sha256(buf);
  h[0] = 0;
  return fromBytes(h);
}
export const transactHash = (recipient: PublicKey, relayer: PublicKey, ext: bigint, fee: bigint) =>
  extHash([Uint8Array.of(0), recipient.toBytes(), relayer.toBytes(), le64(ext, true), le64(fee)]);
export const buyHash = (mint: PublicKey, relayer: PublicKey, tokensOut: bigint, maxSol: bigint, fee: bigint) =>
  extHash([Uint8Array.of(1), mint.toBytes(), relayer.toBytes(), le64(tokensOut), le64(maxSol), le64(fee)]);
export const sellHash = (mint: PublicKey, relayer: PublicKey, tokensIn: bigint, minSol: bigint, fee: bigint) =>
  extHash([Uint8Array.of(2), mint.toBytes(), relayer.toBytes(), le64(tokensIn), le64(minSol), le64(fee)]);

// ---- proving (snarkjs loaded from /zk on first use) ----

declare global { interface Window { snarkjs?: { groth16: { fullProve: (w: unknown, wasm: string, zkey: string) => Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] } }> } } } }
let snarkjsLoading: Promise<void> | null = null;
function loadSnarkjs() {
  if (window.snarkjs) return Promise.resolve();
  snarkjsLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/zk/snarkjs.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load the prover"));
    document.head.appendChild(s);
  });
  return snarkjsLoading;
}

export type ProofArgs = { a: number[]; b: number[]; c: number[]; root: number[]; inputNullifiers: number[][]; outputCommitments: number[][] };

export async function prove(p: {
  tree: MerkleTree; inputs: Note[]; outputs: Note[]; mint?: string; publicSol: bigint; publicToken: bigint; extHash: bigint;
}): Promise<{ proof: ProofArgs; outputs: Note[]; ms: number }> {
  await loadSnarkjs();
  const dummyKey = randomField();
  const inputs = [...p.inputs];
  while (inputs.length < 2) { const d = new Note(0n, dummyKey); d.index = 0; inputs.push(d); }
  const outputs = [...p.outputs];
  while (outputs.length < 2) outputs.push(new Note(0n, randomField()));
  const asset = p.mint ? mintField(new PublicKey(p.mint)) : 0n;
  const w = {
    root: p.tree.root(), publicAmountSol: mod(p.publicSol, FIELD_R), publicAmountToken: mod(p.publicToken, FIELD_R),
    assetToken: asset, extDataHash: p.extHash,
    inputNullifier: inputs.map((n) => n.nullifier), outputCommitment: outputs.map((n) => n.commitment),
    inAmount: inputs.map((n) => n.amount), inPrivateKey: inputs.map((n) => n.privkey), inBlinding: inputs.map((n) => n.blinding),
    inIsToken: inputs.map((n) => (n.mint ? 1n : 0n)), inPathIndices: inputs.map((n) => n.index),
    inPathElements: inputs.map((n) => (n.amount > 0n ? p.tree.path(n.index) : new Array(LEVELS).fill(0n))),
    outAmount: outputs.map((n) => n.amount), outPubkey: outputs.map((n) => n.pubkey), outBlinding: outputs.map((n) => n.blinding),
    outIsToken: outputs.map((n) => (n.mint ? 1n : 0n)),
  };
  const str = (v: unknown): unknown => (Array.isArray(v) ? v.map(str) : typeof v === "bigint" ? v.toString() : v);
  const t0 = performance.now();
  const { proof } = await window.snarkjs!.groth16.fullProve(str(w), "/zk/spend.wasm", "/zk/spend.zkey");
  const g1 = (pt: string[], neg = false) => [...toBytes32(BigInt(pt[0])), ...toBytes32(neg ? mod(FIELD_Q - BigInt(pt[1]), FIELD_Q) : BigInt(pt[1]))];
  const g2 = (pt: string[][]) => [...toBytes32(BigInt(pt[0][1])), ...toBytes32(BigInt(pt[0][0])), ...toBytes32(BigInt(pt[1][1])), ...toBytes32(BigInt(pt[1][0]))];
  return {
    ms: Math.round(performance.now() - t0),
    outputs,
    proof: {
      a: g1(proof.pi_a, true), b: g2(proof.pi_b), c: g1(proof.pi_c), root: toBytes32(p.tree.root()),
      inputNullifiers: inputs.map((n) => toBytes32(n.nullifier)), outputCommitments: outputs.map((n) => toBytes32(n.commitment)),
    },
  };
}

// ---- encrypted local storage ----

export const UNLOCK_MESSAGE = "Patula shielded notes v1 (devnet)\n\nSigning this derives the key that encrypts your private notes in this browser. It does not authorise any transaction.";

export async function deriveKey(signature: Uint8Array) {
  const raw = sha256(signature);
  return crypto.subtle.importKey("raw", raw.buffer.slice(0) as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export function shieldedSecret(signature: Uint8Array): bigint {
  // Stable spending key for this wallet's notes, derived from the same signature.
  return mod(fromBytes(sha256(new Uint8Array([...signature, 1]))), FIELD_R);
}

export type Vault = { notes: ReturnType<Note["toJSON"]>[]; creators: { mint: string; secret: number[] }[] };

const storageKey = (wallet: string) => `patula:vault:${wallet}`;
export async function saveVault(wallet: string, key: CryptoKey, v: Vault) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(v))));
  const blob = JSON.stringify({ v: 1, iv: Array.from(iv), ct: btoa(String.fromCharCode(...ct)) });
  try { localStorage.setItem(storageKey(wallet), blob); } catch { /* storage unavailable */ }
  return blob;
}
export async function loadVault(wallet: string, key: CryptoKey, blob?: string): Promise<Vault> {
  let raw: string | null = blob ?? null;
  if (!raw) { try { raw = localStorage.getItem(storageKey(wallet)); } catch { raw = null; } }
  if (!raw) return { notes: [], creators: [] };
  const { iv, ct } = JSON.parse(raw);
  const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(iv) }, key, bytes);
  return JSON.parse(new TextDecoder().decode(pt));
}
export function exportVaultBlob(wallet: string) {
  try { return localStorage.getItem(storageKey(wallet)); } catch { return null; }
}

// ---- relayer ----

export async function relayerPost<T = { signature: string }>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || j.error || `relayer error ${r.status}`);
  return j as T;
}
export async function fetchTree(): Promise<MerkleTree> {
  const r = await fetch(API_URL + "/tree", { cache: "no-store" });
  if (!r.ok) throw new Error("could not load the note tree");
  const j = await r.json();
  return new MerkleTree((j.leaves as string[]).map((h) => BigInt("0x" + h)));
}
export function selectNotes(notes: Note[], amount: bigint, mint?: string): Note[] {
  const c = notes.filter((n) => n.amount > 0n && n.index >= 0 && (n.mint ?? undefined) === mint).sort((a, b) => (b.amount > a.amount ? 1 : -1));
  if (c[0]?.amount >= amount) return [c[0]];
  if (c.length > 1 && c[0].amount + c[1].amount >= amount) return [c[0], c[1]];
  throw new Error(c.length > 2 ? "Balance is split across many notes; withdraw-and-redeposit to merge (max 2 per trade)." : "Not enough shielded balance.");
}
