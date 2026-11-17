// Patula relayer API (Phase 0).
// - GET  /health  relayer + program status
// - GET  /stats   Phase 0 benchmark figures + live pool state
// - POST /relay   submit a private `transact` on the user's behalf, paying gas
//
// The relayer never sees note secrets. Recipient and fee are bound inside the
// proof (extDataHash), so it cannot redirect funds or change its fee.

import http from "node:http";
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import anchor from "@anchor-lang/core";
import bs58 from "bs58";

const { AnchorProvider, Program, Wallet, BN } = anchor;

const PORT = Number(process.env.PORT || 8080);
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const CLUSTER = process.env.CLUSTER || "devnet";
const MIN_FEE = BigInt(process.env.MIN_FEE_LAMPORTS || "2000000"); // covers nullifier rent + gas
const ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());

const idl = JSON.parse(readFileSync(new URL("../data/idl.json", import.meta.url)));
if (process.env.PROGRAM_ID) idl.address = process.env.PROGRAM_ID;
const PROGRAM_ID = new PublicKey(idl.address);
const phase0 = JSON.parse(readFileSync(new URL("../data/phase0.json", import.meta.url)));

function loadKeypair() {
  const raw = process.env.RELAYER_SECRET_KEY;
  if (!raw) {
    console.warn("RELAYER_SECRET_KEY not set — using an ephemeral key (cannot pay fees).");
    return Keypair.generate();
  }
  const bytes = raw.trim().startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw.trim());
  return Keypair.fromSecretKey(bytes);
}

const relayer = loadKeypair();
const connection = new Connection(RPC_URL, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(relayer), { commitment: "confirmed" });
const program = new Program(idl, provider);
const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool")], PROGRAM_ID);
const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
const nullifierPda = (n) =>
  PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.from(n)], PROGRAM_ID)[0];

// ---- tiny helpers ----------------------------------------------------------

const hits = new Map();
function rateLimited(ip, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > limit;
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  const allow = ORIGINS.includes("*") ? "*" : ORIGINS.includes(origin) ? origin : ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req, max = 16_384) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const bytes = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => Number.isInteger(x) && x >= 0 && x < 256);

let deployedCache = { at: 0, value: false };
async function programDeployed() {
  if (Date.now() - deployedCache.at < 30_000) return deployedCache.value;
  const info = await connection.getAccountInfo(PROGRAM_ID).catch(() => null);
  deployedCache = { at: Date.now(), value: !!info?.executable };
  return deployedCache.value;
}

// ---- routes ----------------------------------------------------------------

async function health() {
  const [deployed, balance] = await Promise.all([
    programDeployed(),
    connection.getBalance(relayer.publicKey).catch(() => 0),
  ]);
  return {
    ok: true,
    cluster: CLUSTER,
    programId: PROGRAM_ID.toBase58(),
    programDeployed: deployed,
    relayer: relayer.publicKey.toBase58(),
    relayerBalanceSol: balance / 1e9,
    minFeeLamports: MIN_FEE.toString(),
  };
}

async function stats() {
  let pool = null;
  if (await programDeployed()) {
    try {
      const p = await program.account.pool.fetch(poolPda);
      pool = {
        deposits: p.nextIndex.toNumber() / 2,
        root: Buffer.from(p.roots[p.currentRootIndex.toNumber()]).toString("hex"),
      };
    } catch {
      pool = null; // pool not initialised yet
    }
  }
  return {
    phase0: phase0.map(({ tx, proveMs, computeUnits, txBytes }) => ({ tx, proveMs, computeUnits, txBytes })),
    constraints: 26784,
    testsPassed: 6,
    testsTotal: 6,
    pool,
  };
}

async function relay(body) {
  const { args, recipient } = body || {};
  if (!args || typeof recipient !== "string") return [400, { error: "args and recipient required" }];
  const ok =
    bytes(args.proofA, 64) && bytes(args.proofB, 128) && bytes(args.proofC, 64) &&
    bytes(args.root, 32) && bytes(args.publicAmount, 32) &&
    Array.isArray(args.inputNullifiers) && args.inputNullifiers.length === 2 && args.inputNullifiers.every((n) => bytes(n, 32)) &&
    Array.isArray(args.outputCommitments) && args.outputCommitments.length === 2 && args.outputCommitments.every((n) => bytes(n, 32));
  if (!ok) return [400, { error: "malformed proof arguments" }];

  let fee, extAmount, recipientKey;
  try {
    fee = BigInt(args.fee);
    extAmount = BigInt(args.extAmount);
    recipientKey = new PublicKey(recipient);
  } catch {
    return [400, { error: "invalid fee, extAmount or recipient" }];
  }
  if (fee < MIN_FEE) return [400, { error: `fee must be at least ${MIN_FEE} lamports` }];
  if (extAmount > 0n) return [400, { error: "deposits are signed by the depositor, not relayed" }];
  if (!(await programDeployed())) return [503, { error: `program not deployed on ${CLUSTER}` }];

  try {
    const sig = await program.methods
      .transact({
        ...args,
        extAmount: new BN(extAmount.toString()),
        fee: new BN(fee.toString()),
      })
      .accountsPartial({
        pool: poolPda,
        vault: vaultPda,
        nullifier0: nullifierPda(args.inputNullifiers[0]),
        nullifier1: nullifierPda(args.inputNullifiers[1]),
        signer: relayer.publicKey,
        recipient: recipientKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    return [200, { signature: sig }];
  } catch (e) {
    const msg = String(e?.message || e);
    return [422, { error: "transaction rejected", detail: msg.slice(0, 400) }];
  }
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url, "http://x");
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0];
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, { name: "patula-relayer", endpoints: ["/health", "/stats", "POST /relay"] });
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, await health());
    if (req.method === "GET" && url.pathname === "/stats") return send(res, 200, await stats());
    if (req.method === "POST" && url.pathname === "/relay") {
      if (rateLimited(ip)) return send(res, 429, { error: "slow down" });
      const [status, body] = await relay(await readBody(req));
      return send(res, status, body);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`patula-relayer on :${PORT} · ${CLUSTER} · program ${PROGRAM_ID.toBase58()} · relayer ${relayer.publicKey.toBase58()}`);
});
