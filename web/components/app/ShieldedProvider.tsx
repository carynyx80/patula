"use client";
// React state for the user's shielded (private) balance and private actions.
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ComputeBudgetProgram, Keypair as SolKeypair, PublicKey, Transaction } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import poolIdl from "@/lib/idl/pool.json";
import { getJSON, Health } from "@/lib/api";
import {
  buyHash, deriveKey, exportVaultBlob, fetchTree, loadVault, MerkleTree, Note, prove, relayerPost, saveVault,
  selectNotes, sellHash, shieldedSecret, toBytes32, transactHash, UNLOCK_MESSAGE, Vault,
} from "@/lib/shielded";

type RelayerHealth = Health & { minFeeLamports: string };

type Ctx = {
  unlocked: boolean;
  busy: string; // non-empty while an action runs (status text)
  notes: Note[];
  solBalance: bigint;
  tokenBalance: (mint: string) => bigint;
  relayerFee: bigint;
  vaultPda: string;
  unlock: () => Promise<void>;
  refresh: () => Promise<void>;
  deposit: (lamports: bigint) => Promise<string>;
  withdraw: (lamports: bigint, recipient: PublicKey) => Promise<string>;
  buy: (mint: string, tokensOut: bigint, maxSol: bigint) => Promise<string>;
  sell: (mint: string, tokensIn: bigint, minSol: bigint) => Promise<string>;
  launch: (name: string, symbol: string, uri: string) => Promise<{ mint: string; signature: string }>;
  exportBackup: () => string | null;
};

const ShieldedCtx = createContext<Ctx | null>(null);
export const useShielded = () => {
  const c = useContext(ShieldedCtx);
  if (!c) throw new Error("useShielded outside provider");
  return c;
};

const POOL_ID = new PublicKey((poolIdl as { address: string }).address);
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, POOL_ID)[0];
const POOL_PDA = pda(Buffer.from("pool2"));
const VAULT_PDA = pda(Buffer.from("vault2"));
const nullifierPda = (n: number[]) => pda(Buffer.from("nullifier"), Buffer.from(n));

export default function ShieldedProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [key, setKey] = useState<CryptoKey | null>(null);
  const secret = useRef<bigint>(0n);
  const [vault, setVault] = useState<Vault>({ notes: [], creators: [] });
  const [busy, setBusy] = useState("");
  const [health, setHealth] = useState<RelayerHealth | null>(null);
  const owner = wallet.publicKey?.toBase58() ?? "";

  useEffect(() => { getJSON<RelayerHealth>("/health").then(setHealth); }, []);
  useEffect(() => { setKey(null); setVault({ notes: [], creators: [] }); }, [owner]);

  const notes = useMemo(() => vault.notes.map(Note.fromJSON), [vault]);
  const persist = useCallback(async (v: Vault) => {
    setVault(v);
    if (key && owner) await saveVault(owner, key, v);
  }, [key, owner]);

  const relayer = useMemo(() => (health ? new PublicKey(health.relayer) : null), [health]);
  const relayerFee = BigInt(health?.minFeeLamports ?? "2000000");

  /** Assign tree indices to new notes and drop notes whose nullifier exists on-chain. */
  const reconcile = useCallback(async (v: Vault, tree?: MerkleTree): Promise<Vault> => {
    const t = tree ?? (await fetchTree());
    const pos = new Map(t.leaves.map((l, i) => [l.toString(), i]));
    const ns = v.notes.map(Note.fromJSON).map((n) => { if (n.index < 0) n.index = pos.get(n.commitment.toString()) ?? -1; return n; });
    const indexed = ns.filter((n) => n.index >= 0 && n.amount > 0n);
    const infos = indexed.length ? await connection.getMultipleAccountsInfo(indexed.map((n) => nullifierPda(toBytes32(n.nullifier)))) : [];
    const spent = new Set(indexed.filter((_, i) => infos[i]).map((n) => n.commitment.toString()));
    return { ...v, notes: ns.filter((n) => n.amount > 0n && !spent.has(n.commitment.toString())).map((n) => n.toJSON()) };
  }, [connection]);

  const refresh = useCallback(async () => {
    if (!key) return;
    await persist(await reconcile(vault));
  }, [key, vault, persist, reconcile]);

  const unlock = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) throw new Error("Connect a wallet that can sign messages.");
    const sig = await wallet.signMessage(new TextEncoder().encode(UNLOCK_MESSAGE));
    const k = await deriveKey(sig);
    secret.current = shieldedSecret(sig);
    const v = await loadVault(wallet.publicKey.toBase58(), k);
    setKey(k);
    const r = await reconcile(v).catch(() => v);
    setVault(r);
    await saveVault(wallet.publicKey.toBase58(), k, r);
  }, [wallet, reconcile]);

  const withStatus = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } finally { setBusy(""); }
  };

  /** After a private tx: remove spent inputs, add new outputs, index them when the relayer sees them. */
  const settle = useCallback(async (spent: Note[], outputs: Note[]) => {
    const spentSet = new Set(spent.map((n) => n.commitment.toString()));
    const next: Vault = { ...vault, notes: [...notes.filter((n) => !spentSet.has(n.commitment.toString())), ...outputs.filter((o) => o.amount > 0n)].map((n) => n.toJSON()) };
    await persist(next);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await reconcile(next).catch(() => null);
      if (r && r.notes.every((n) => n.i >= 0)) { await persist(r); return; }
    }
  }, [vault, notes, persist, reconcile]);

  const program = useCallback(() => {
    const provider = new AnchorProvider(connection, wallet as never, { commitment: "confirmed" });
    return new Program(poolIdl as never, provider);
  }, [connection, wallet]);

  const deposit = useCallback((lamports: bigint) => withStatus(async () => {
    if (!wallet.publicKey || !key) throw new Error("Unlock your shielded balance first.");
    setBusy("Generating proof…");
    const tree = await fetchTree();
    const note = new Note(lamports, secret.current);
    const { proof, outputs } = await prove({ tree, inputs: [], outputs: [note], publicSol: lamports, publicToken: 0n, extHash: transactHash(wallet.publicKey, wallet.publicKey, lamports, 0n) });
    setBusy("Confirm in your wallet…");
    const ix = await program().methods.transact(proof as never, new BN(lamports.toString()), new BN(0))
      .accountsPartial({ pool: POOL_PDA, vault: VAULT_PDA, nullifier0: nullifierPda(proof.inputNullifiers[0]), nullifier1: nullifierPda(proof.inputNullifiers[1]), signer: wallet.publicKey, recipient: wallet.publicKey })
      .instruction();
    const sig = await wallet.sendTransaction(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix), connection);
    setBusy("Confirming…");
    await connection.confirmTransaction(sig, "confirmed");
    await settle([], outputs);
    return sig;
  }), [wallet, key, connection, program, settle]);

  const withdraw = useCallback((lamports: bigint, recipient: PublicKey) => withStatus(async () => {
    if (!key || !relayer) throw new Error("Unlock your shielded balance first.");
    const fee = relayerFee;
    const inputs = selectNotes(notes, lamports + fee);
    const total = inputs.reduce((a, n) => a + n.amount, 0n);
    const change = new Note(total - lamports - fee, secret.current);
    setBusy("Generating proof…");
    const tree = await fetchTree();
    const ext = -lamports;
    const { proof, outputs } = await prove({ tree, inputs, outputs: [change], publicSol: ext - fee, publicToken: 0n, extHash: transactHash(recipient, relayer, ext, fee) });
    setBusy("Relaying…");
    const { signature } = await relayerPost("/relay/transact", { proof, extAmount: ext, fee, recipient: recipient.toBase58() });
    await settle(inputs, outputs);
    return signature;
  }), [key, relayer, relayerFee, notes, settle]);

  const buy = useCallback((mint: string, tokensOut: bigint, maxSol: bigint) => withStatus(async () => {
    if (!key || !relayer) throw new Error("Unlock your shielded balance first.");
    const fee = relayerFee;
    const inputs = selectNotes(notes, maxSol + fee);
    const total = inputs.reduce((a, n) => a + n.amount, 0n);
    setBusy("Generating proof…");
    const tree = await fetchTree();
    const { proof, outputs } = await prove({
      tree, inputs, outputs: [new Note(tokensOut, secret.current, mint), new Note(total - maxSol - fee, secret.current)], mint,
      publicSol: -(maxSol + fee), publicToken: tokensOut, extHash: buyHash(new PublicKey(mint), relayer, tokensOut, maxSol, fee),
    });
    setBusy("Relaying…");
    const { signature } = await relayerPost("/relay/buy", { proof, mint, tokensOut, maxSol, fee });
    await settle(inputs, outputs);
    return signature;
  }), [key, relayer, relayerFee, notes, settle]);

  const sell = useCallback((mint: string, tokensIn: bigint, minSol: bigint) => withStatus(async () => {
    if (!key || !relayer) throw new Error("Unlock your shielded balance first.");
    const fee = relayerFee;
    if (minSol <= fee) throw new Error("Sale too small to cover the relayer fee.");
    const inputs = selectNotes(notes, tokensIn, mint);
    const total = inputs.reduce((a, n) => a + n.amount, 0n);
    setBusy("Generating proof…");
    const tree = await fetchTree();
    const { proof, outputs } = await prove({
      tree, inputs, outputs: [new Note(minSol - fee, secret.current), new Note(total - tokensIn, secret.current, mint)], mint,
      publicSol: minSol - fee, publicToken: -tokensIn, extHash: sellHash(new PublicKey(mint), relayer, tokensIn, minSol, fee),
    });
    setBusy("Relaying…");
    const { signature } = await relayerPost("/relay/sell", { proof, mint, tokensIn, minSol, fee });
    await settle(inputs, outputs);
    return signature;
  }), [key, relayer, relayerFee, notes, settle]);

  const launch = useCallback((name: string, symbol: string, uri: string) => withStatus(async () => {
    if (!key) throw new Error("Unlock your shielded balance first (it stores your anonymous creator key).");
    const creator = SolKeypair.generate(), mint = SolKeypair.generate();
    setBusy("Preparing anonymous launch…");
    const { tx } = await relayerPost<{ tx: string }>("/launch/prepare", { name, symbol, uri, creator: creator.publicKey.toBase58(), mint: mint.publicKey.toBase58() });
    const t = Transaction.from(Buffer.from(tx, "base64"));
    t.partialSign(mint, creator);
    // keep the creator key before submitting so creator fees are never orphaned
    await persist({ ...vault, creators: [...vault.creators, { mint: mint.publicKey.toBase58(), secret: Array.from(creator.secretKey) }] });
    setBusy("Launching via relayer…");
    const { signature } = await relayerPost("/launch/submit", { tx: t.serialize({ requireAllSignatures: false }).toString("base64") });
    return { mint: mint.publicKey.toBase58(), signature };
  }), [key, vault, persist]);

  const value: Ctx = {
    unlocked: !!key,
    busy,
    notes,
    solBalance: notes.filter((n) => !n.mint).reduce((a, n) => a + n.amount, 0n),
    tokenBalance: (mint) => notes.filter((n) => n.mint === mint).reduce((a, n) => a + n.amount, 0n),
    relayerFee,
    vaultPda: VAULT_PDA.toBase58(),
    unlock, refresh, deposit, withdraw, buy, sell, launch,
    exportBackup: () => (owner ? exportVaultBlob(owner) : null),
  };
  return <ShieldedCtx.Provider value={value}>{children}</ShieldedCtx.Provider>;
}
