// Patula relayer API (Phase 1b).
//   GET  /health          relayer, programs, lookup table
//   GET  /stats           benchmark figures + live pool state
//   GET  /tree            all note commitments in the shielded pool (for Merkle paths)
//   POST /relay/transact  private SOL transfer / withdrawal
//   POST /relay/buy       private buy (SOL notes -> token notes)
//   POST /relay/sell      private sell (token notes -> SOL notes)
//   POST /launch/prepare  build a private launch tx (relayer pays, fresh key is creator)
//   POST /launch/submit   relayer co-signs and sends the prepared launch tx
//
// The relayer never sees note secrets. Amounts, recipient and its own fee are
// bound inside each proof, so it cannot redirect funds or change its fee.

import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import anchor from "@anchor-lang/core";
import bs58 from "bs58";

const { AnchorProvider, Program, Wallet, BN, BorshCoder, EventParser } = anchor;

const PORT = Number(process.env.PORT || 8080);
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const CLUSTER = process.env.CLUSTER || "devnet";
const MIN_FEE = BigInt(process.env.MIN_FEE_LAMPORTS || "2000000"); // covers 2 nullifier rents + gas
const ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
const ALT_ADDRESS = process.env.ALT_ADDRESS ? new PublicKey(process.env.ALT_ADDRESS) : null;

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const poolIdl = read("idl.json");
const lpIdl = read("launchpad-idl.json");
const phase0 = read("phase0.json");

function loadKeypair() {
  const raw = process.env.RELAYER_SECRET_KEY;
  if (!raw) {
    console.warn("RELAYER_SECRET_KEY not set — using an ephemeral key (cannot pay fees).");
    return Keypair.generate();
  }
  return Keypair.fromSecretKey(raw.trim().startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw.trim()));
}

const relayer = loadKeypair();
const connection = new Connection(RPC_URL, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(relayer), { commitment: "confirmed" });
const pool = new Program(poolIdl, provider);
const lp = new Program(lpIdl, provider);
const POOL_ID = pool.programId;
const LP_ID = lp.programId;
const pda = (prog, ...seeds) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const poolPda = pda(POOL_ID, Buffer.from("pool2"));
const vaultPda = pda(POOL_ID, Buffer.from("vault2"));
const lpConfig = pda(LP_ID, Buffer.from("config"));
const nullifierPda = (n) => pda(POOL_ID, Buffer.from("nullifier"), Buffer.from(n));
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ata = (mint, owner) => pda(ATA_PROGRAM, owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer());

// ---- helpers ---------------------------------------------------------------

const hits = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
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
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
async function readBody(req, max = 32_768) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
const isBytes = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => Number.isInteger(x) && x >= 0 && x < 256);
const validProof = (p) =>
  p && isBytes(p.a, 64) && isBytes(p.b, 128) && isBytes(p.c, 64) && isBytes(p.root, 32) &&
  Array.isArray(p.inputNullifiers) && p.inputNullifiers.length === 2 && p.inputNullifiers.every((n) => isBytes(n, 32)) &&
  Array.isArray(p.outputCommitments) && p.outputCommitments.length === 2 && p.outputCommitments.every((n) => isBytes(n, 32));
const u64 = (v) => { const b = BigInt(v); if (b < 0n || b > 18446744073709551615n) throw new Error("u64 out of range"); return b; };
const errMsg = (e) => {
  const s = String(e?.message || e);
  const logs = e?.logs || e?.transactionLogs;
  const anchorErr = (logs || []).find((l) => l.includes("Error Message"));
  return (anchorErr || s).slice(0, 400);
};

let altCache = null;
async function lookupTable() {
  if (!ALT_ADDRESS) return [];
  if (!altCache || Date.now() - altCache.at > 300_000) {
    altCache = { at: Date.now(), value: (await connection.getAddressLookupTable(ALT_ADDRESS)).value };
  }
  return altCache.value ? [altCache.value] : [];
}

async function sendV0(ixs) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: relayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs],
  }).compileToV0Message(await lookupTable());
  const tx = new VersionedTransaction(msg);
  tx.sign([relayer]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

let deployedCache = { at: 0, value: false };
async function poolReady() {
  if (Date.now() - deployedCache.at < 30_000) return deployedCache.value;
  const info = await connection.getAccountInfo(poolPda).catch(() => null);
  deployedCache = { at: Date.now(), value: !!info };
  return deployedCache.value;
}

// ---- commitment tree indexer -----------------------------------------------

const parser = new EventParser(POOL_ID, new BorshCoder(poolIdl));
const tree = { leaves: new Map(), lastSig: undefined, at: 0, syncing: null };
async function syncTree() {
  if (Date.now() - tree.at < 2_000) return;
  if (tree.syncing) return tree.syncing;
  tree.syncing = (async () => {
    const fresh = [];
    let before;
    for (;;) {
      const page = await connection.getSignaturesForAddress(poolPda, { before, until: tree.lastSig, limit: 1000 });
      fresh.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    const ok = fresh.filter((s) => !s.err).map((s) => s.signature);
    for (let i = 0; i < ok.length; i += 50) {
      const txs = await connection.getTransactions(ok.slice(i, i + 50), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      for (const tx of txs) {
        for (const ev of parser.parseLogs(tx?.meta?.logMessages ?? [])) {
          if (ev.name.toLowerCase() !== "newcommitments") continue;
          const idx = Number(ev.data.index.toString());
          ev.data.commitments.forEach((c, k) => tree.leaves.set(idx + k, Buffer.from(c).toString("hex")));
        }
      }
    }
    if (fresh.length) tree.lastSig = fresh[0].signature;
    tree.at = Date.now();
  })().finally(() => { tree.syncing = null; });
  return tree.syncing;
}
async function getTree() {
  await syncTree();
  const n = tree.leaves.size;
  const leaves = Array.from({ length: n }, (_, i) => tree.leaves.get(i));
  if (leaves.some((l) => l === undefined)) { tree.lastSig = undefined; tree.leaves.clear(); tree.at = 0; return getTree(); }
  return { leaves, count: n };
}

// ---- routes ----------------------------------------------------------------

async function health() {
  const [ready, balance] = await Promise.all([poolReady(), connection.getBalance(relayer.publicKey).catch(() => 0)]);
  return {
    ok: true, cluster: CLUSTER, programId: POOL_ID.toBase58(), launchpadId: LP_ID.toBase58(),
    programDeployed: ready, relayer: relayer.publicKey.toBase58(), relayerBalanceSol: balance / 1e9,
    minFeeLamports: MIN_FEE.toString(), altAddress: ALT_ADDRESS?.toBase58() ?? null, poolVersion: 2,
  };
}

async function stats() {
  let poolState = null;
  if (await poolReady()) {
    try {
      const p = await pool.account.pool.fetch(poolPda);
      poolState = { notes: p.nextIndex.toNumber(), deposits: p.nextIndex.toNumber() / 2, root: Buffer.from(p.roots[p.currentRootIndex.toNumber()]).toString("hex") };
    } catch { /* not initialised */ }
  }
  return {
    phase0: phase0.map(({ tx, proveMs, computeUnits, txBytes }) => ({ tx, proveMs, computeUnits, txBytes })),
    constraints: 27371, testsPassed: 16, testsTotal: 16, pool: poolState,
  };
}

const nullifierAccounts = (proof) => ({ nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]) });

async function relayTransact(b) {
  if (!validProof(b.proof) || typeof b.recipient !== "string") return [400, { error: "malformed request" }];
  const ext = BigInt(b.extAmount), fee = u64(b.fee);
  if (ext > 0n) return [400, { error: "deposits are signed by the depositor, not relayed" }];
  if (fee < MIN_FEE) return [400, { error: `fee must be at least ${MIN_FEE} lamports` }];
  const ix = await pool.methods.transact(b.proof, new BN(ext.toString()), new BN(fee.toString()))
    .accountsPartial({ pool: poolPda, vault: vaultPda, ...nullifierAccounts(b.proof), signer: relayer.publicKey, recipient: new PublicKey(b.recipient) })
    .instruction();
  return [200, { signature: await sendV0([ix]) }];
}

async function tradeAccounts(mint) {
  const curve = pda(LP_ID, Buffer.from("curve"), mint.toBuffer());
  const c = await lp.account.curve.fetch(curve);
  const cfg = await lp.account.config.fetch(lpConfig);
  return {
    mint, poolToken: ata(mint, vaultPda), lpConfig, lpCurve: curve, lpCurveTokenVault: ata(mint, curve),
    lpSolVault: pda(LP_ID, Buffer.from("sol_vault"), mint.toBuffer()), lpFeeRecipient: cfg.feeRecipient,
    lpCreator: c.creator, launchpadProgram: LP_ID,
  };
}

async function relayTrade(b, side) {
  if (!validProof(b.proof) || typeof b.mint !== "string") return [400, { error: "malformed request" }];
  const fee = u64(b.fee);
  if (fee < MIN_FEE) return [400, { error: `fee must be at least ${MIN_FEE} lamports` }];
  const mint = new PublicKey(b.mint);
  const amount = u64(side === "buy" ? b.tokensOut : b.tokensIn);
  const limit = u64(side === "buy" ? b.maxSol : b.minSol);
  const accts = { pool: poolPda, vault: vaultPda, ...nullifierAccounts(b.proof), relayer: relayer.publicKey, ...(await tradeAccounts(mint)) };
  const m = side === "buy" ? pool.methods.privateBuy : pool.methods.privateSell;
  const ix = await m(b.proof, new BN(amount.toString()), new BN(limit.toString()), new BN(fee.toString())).accountsPartial(accts).instruction();
  return [200, { signature: await sendV0([ix]) }];
}

const pendingLaunches = new Map(); // message hash -> expiry
async function launchPrepare(b) {
  const name = String(b.name || "").trim(), symbol = String(b.symbol || "").trim().toUpperCase(), uri = String(b.uri || "").trim();
  if (!name || name.length > 32 || !symbol || symbol.length > 10 || uri.length > 200) return [400, { error: "name 1-32, symbol 1-10, uri up to 200 chars" }];
  const creator = new PublicKey(b.creator), mint = new PublicKey(b.mint);
  const cfg = await lp.account.config.fetch(lpConfig);
  const curve = pda(LP_ID, Buffer.from("curve"), mint.toBuffer());
  const rent = await connection.getMinimumBalanceForRentExemption(0);
  const ix = await lp.methods.createToken(name, symbol, uri)
    .accountsPartial({
      config: lpConfig, payer: relayer.publicKey, creator, mint, curve, curveTokenVault: ata(mint, curve),
      solVault: pda(LP_ID, Buffer.from("sol_vault"), mint.toBuffer()), feeRecipient: cfg.feeRecipient,
    }).instruction();
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: relayer.publicKey, recentBlockhash: blockhash })
    // fund the fresh creator key's rent so creator fees can land in it
    .add(SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: creator, lamports: rent }))
    .add(ix);
  const msg = tx.serializeMessage();
  pendingLaunches.set(createHash("sha256").update(msg).digest("hex"), Date.now() + 90_000);
  return [200, { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }];
}

async function launchSubmit(b) {
  const tx = Transaction.from(Buffer.from(String(b.tx || ""), "base64"));
  const key = createHash("sha256").update(tx.serializeMessage()).digest("hex");
  const exp = pendingLaunches.get(key);
  if (!exp || exp < Date.now()) return [400, { error: "unknown or expired launch; prepare again" }];
  pendingLaunches.delete(key);
  tx.partialSign(relayer);
  if (!tx.verifySignatures()) return [400, { error: "missing creator or mint signature" }];
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  return [200, { signature: sig }];
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url, "http://x");
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0];
  try {
    if (req.method === "GET") {
      if (url.pathname === "/") return send(res, 200, { name: "patula-relayer", version: 2 });
      if (url.pathname === "/health") return send(res, 200, await health());
      if (url.pathname === "/stats") return send(res, 200, await stats());
      if (url.pathname === "/tree") return send(res, 200, await getTree());
    }
    if (req.method === "POST") {
      const routes = {
        "/relay/transact": [relayTransact, 20],
        "/relay": [relayTransact, 20], // v1 path
        "/relay/buy": [(b) => relayTrade(b, "buy"), 20],
        "/relay/sell": [(b) => relayTrade(b, "sell"), 20],
        "/launch/prepare": [launchPrepare, 5],
        "/launch/submit": [launchSubmit, 5],
      };
      const r = routes[url.pathname];
      if (r) {
        const [fn, perMin] = r;
        if (rateLimited(ip + url.pathname, perMin, 60_000)) return send(res, 429, { error: "slow down" });
        if (!(await poolReady())) return send(res, 503, { error: `pool not deployed on ${CLUSTER}` });
        try {
          const [status, body] = await fn(await readBody(req));
          return send(res, status, body);
        } catch (e) {
          return send(res, 422, { error: "rejected", detail: errMsg(e) });
        }
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`patula-relayer v2 on :${PORT} · ${CLUSTER} · pool ${POOL_ID.toBase58()} · relayer ${relayer.publicKey.toBase58()} · alt ${ALT_ADDRESS?.toBase58() ?? "none"}`);
});
