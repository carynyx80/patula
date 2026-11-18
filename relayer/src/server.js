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
import { readFileSync, mkdirSync, existsSync, writeFileSync, createReadStream, appendFileSync } from "node:fs";
import path from "node:path";
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
const DATA_DIR = process.env.DATA_DIR || path.resolve("data-local");
const META_DIR = path.join(DATA_DIR, "meta");
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, "");
// Anonymous launches are paid for with a private withdrawal to the relayer.
const LAUNCH_PRICE = BigInt(process.env.PRIVATE_LAUNCH_PRICE_LAMPORTS || "45000000");
const PINATA_JWT = process.env.PINATA_JWT || "";
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs").replace(/\/$/, "");
mkdirSync(META_DIR, { recursive: true });
const DENY_FILE = path.join(DATA_DIR, "denylist.txt");
const USED_FILE = path.join(DATA_DIR, "used-payments.txt");
const readLines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split(/\s+/).filter(Boolean) : []);
const denylist = new Set([...(process.env.DENYLIST || "").split(",").map((s) => s.trim()).filter(Boolean), ...readLines(DENY_FILE)]);
const usedPayments = new Set(readLines(USED_FILE));
const denied = (addr) => denylist.has(String(addr));

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const poolIdl = read("idl.json");
const lpIdl = read("launchpad-idl.json");
if (process.env.PROGRAM_ID) poolIdl.address = process.env.PROGRAM_ID;
if (process.env.LAUNCHPAD_ID) lpIdl.address = process.env.LAUNCHPAD_ID;
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
    privateLaunchPriceLamports: LAUNCH_PRICE.toString(), metadataStorage: PINATA_JWT ? "ipfs" : "relayer",
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
    constraints: 27371, testsPassed: 20, testsTotal: 20, pool: poolState,
  };
}

const nullifierAccounts = (proof) => ({ nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]) });

async function relayTransact(b) {
  if (!validProof(b.proof) || typeof b.recipient !== "string") return [400, { error: "malformed request" }];
  const ext = BigInt(b.extAmount), fee = u64(b.fee);
  if (ext > 0n) return [400, { error: "deposits are signed by the depositor, not relayed" }];
  if (fee < MIN_FEE) return [400, { error: `fee must be at least ${MIN_FEE} lamports` }];
  if (denied(b.recipient)) return [403, { error: "recipient is blocked" }];
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
    lpSolVault: pda(LP_ID, Buffer.from("sol_vault"), mint.toBuffer()), lpRewards: pda(LP_ID, Buffer.from("rewards"), mint.toBuffer()),
    lpFeeRecipient: cfg.feeRecipient,
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
  if (denied(creator.toBase58())) return [403, { error: "creator is blocked" }];
  const cfg = await lp.account.config.fetch(lpConfig);
  const f = b.fees || {};
  const fees = { buyFeeBps: Number(f.buyFeeBps || 0), sellFeeBps: Number(f.sellFeeBps || 0), holderShareBps: Number(f.holderShareBps || 0) };
  if ([fees.buyFeeBps, fees.sellFeeBps].some((x) => !Number.isInteger(x) || x < 0 || x > cfg.maxTokenFeeBps) || !Number.isInteger(fees.holderShareBps) || fees.holderShareBps < 0 || fees.holderShareBps > 10000) {
    return [400, { error: `fees must be 0-${cfg.maxTokenFeeBps} bps per side, holder share 0-10000` }];
  }
  // payment: a recent, successful private withdrawal from the pool vault to this relayer
  const pay = await verifyPayment(String(b.payment || ""));
  if (pay) return [402, { error: pay, priceLamports: LAUNCH_PRICE.toString(), payTo: relayer.publicKey.toBase58() }];
  const curve = pda(LP_ID, Buffer.from("curve"), mint.toBuffer());
  const rent = await connection.getMinimumBalanceForRentExemption(0);
  const ix = await lp.methods.createToken(name, symbol, uri, fees)
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
  pendingLaunches.set(createHash("sha256").update(msg).digest("hex"), { exp: Date.now() + 90_000, payment: String(b.payment) });
  return [200, { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }];
}

async function launchSubmit(b) {
  const tx = Transaction.from(Buffer.from(String(b.tx || ""), "base64"));
  const key = createHash("sha256").update(tx.serializeMessage()).digest("hex");
  const pending = pendingLaunches.get(key);
  if (!pending || pending.exp < Date.now()) return [400, { error: "unknown or expired launch; prepare again" }];
  if (usedPayments.has(pending.payment)) return [402, { error: "payment already used" }];
  pendingLaunches.delete(key);
  tx.partialSign(relayer);
  if (!tx.verifySignatures()) return [400, { error: "missing creator or mint signature" }];
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  usedPayments.add(pending.payment);
  try { appendFileSync(USED_FILE, pending.payment + "\n"); } catch { /* best effort */ }
  return [200, { signature: sig }];
}

/** Returns an error string, or null when `sig` is a valid unused payment. */
async function verifyPayment(sig) {
  if (LAUNCH_PRICE === 0n) return null;
  if (!sig) return "anonymous launches must be paid with a private withdrawal to the relayer";
  if (usedPayments.has(sig)) return "payment already used";
  const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!tx || tx.meta?.err) return "payment transaction not found or failed";
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 1800) return "payment is older than 30 minutes";
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).staticAccountKeys
    .concat(tx.meta.loadedAddresses?.writable ?? [], tx.meta.loadedAddresses?.readonly ?? []);
  const vi = keys.findIndex((k) => k.equals(vaultPda));
  const ri = keys.findIndex((k) => k.equals(relayer.publicKey));
  if (vi < 0 || ri < 0) return "payment did not come from the shielded pool to this relayer";
  const fromVault = BigInt(tx.meta.preBalances[vi] - tx.meta.postBalances[vi]);
  if (fromVault < LAUNCH_PRICE + MIN_FEE) return `payment too small: send at least ${LAUNCH_PRICE} lamports plus the relayer fee`;
  return null;
}

// ---- token metadata hosting (image + Metaplex-style JSON, content-addressed) ----

const IMAGE_TYPES = [
  { ext: "png", mime: "image/png", sig: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", mime: "image/jpeg", sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", sig: (b) => b.slice(0, 3).toString() === "GIF" },
  { ext: "webp", mime: "image/webp", sig: (b) => b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP" },
];
const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", json: "application/json" };
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 40);

async function pinFile(buf, name, mime) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), name);
  const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${PINATA_JWT}` }, body: form });
  if (!r.ok) throw new Error(`IPFS pin failed (${r.status})`);
  return `${IPFS_GATEWAY}/${(await r.json()).IpfsHash}`;
}

async function storeImage(dataUrl, maxBytes) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new Error("image must be a base64 data URL");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > maxBytes) throw new Error(`image too large (max ${Math.round(maxBytes / 1024)} KB)`);
  const t = IMAGE_TYPES.find((x) => x.sig(buf));
  if (!t) throw new Error("image must be PNG, JPEG, GIF or WebP");
  const name = `${hash(buf)}.${t.ext}`;
  const file = path.join(META_DIR, name);
  if (!existsSync(file)) writeFileSync(file, buf); // local copy is always kept
  return PINATA_JWT ? pinFile(buf, name, t.mime) : `${PUBLIC_URL}/meta/${name}`;
}

const cleanUrl = (v, hosts) => {
  const s = String(v || "").trim();
  if (!s) return undefined;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new Error(`invalid link: ${s.slice(0, 60)}`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("links must be http(s)");
  if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) throw new Error(`link must be on ${hosts.join(" or ")}`);
  return u.toString().slice(0, 200);
};

async function uploadMetadata(b) {
  const name = String(b.name || "").trim(), symbol = String(b.symbol || "").trim().toUpperCase();
  const description = String(b.description || "").trim();
  if (!name || name.length > 32) throw new Error("name must be 1-32 characters");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("ticker must be 1-10 letters or digits");
  if (description.length > 500) throw new Error("description up to 500 characters");
  const handle = String(b.twitter || "").trim().replace(/^@/, "");
  const extensions = {
    website: cleanUrl(b.website),
    twitter: handle ? (/^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : cleanUrl(handle, ["x.com", "twitter.com"])) : undefined,
    telegram: cleanUrl(b.telegram, ["t.me", "telegram.me"]),
    discord: cleanUrl(b.discord, ["discord.gg", "discord.com"]),
  };
  const image = await storeImage(b.image, 2_000_000);
  const banner = b.banner ? await storeImage(b.banner, 3_000_000) : undefined;
  const json = {
    name, symbol, description, image,
    ...(banner ? { banner } : {}),
    extensions: Object.fromEntries(Object.entries(extensions).filter(([, v]) => v)),
    properties: { files: [{ uri: image, type: MIME[image.split(".").pop()] }], category: "image" },
    createdOn: "https://patula.vercel.app",
  };
  const body = Buffer.from(JSON.stringify(json));
  const file = `${hash(body)}.json`;
  if (!existsSync(path.join(META_DIR, file))) writeFileSync(path.join(META_DIR, file), body);
  const uri = PINATA_JWT ? await pinFile(body, file, "application/json") : `${PUBLIC_URL}/meta/${file}`;
  return { uri, image, banner: banner ?? null, metadata: json };
}

function serveMeta(res, name) {
  if (!/^[a-f0-9]{40}\.(png|jpg|gif|webp|json)$/.test(name)) return send(res, 404, { error: "not found" });
  const file = path.join(META_DIR, name);
  if (!existsSync(file)) return send(res, 404, { error: "not found" });
  res.writeHead(200, {
    "content-type": MIME[name.split(".").pop()],
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
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
      if (url.pathname.startsWith("/meta/")) return serveMeta(res, url.pathname.slice(6));
      if (url.pathname === "/screen") return send(res, 200, { address: url.searchParams.get("address"), blocked: denied(url.searchParams.get("address")) });
    }
    if (req.method === "POST" && url.pathname === "/metadata") {
      if (rateLimited(ip + "/metadata", 10, 60_000)) return send(res, 429, { error: "slow down" });
      try {
        return send(res, 200, await uploadMetadata(await readBody(req, 7_000_000)));
      } catch (e) {
        return send(res, 400, { error: String(e?.message || e) });
      }
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
