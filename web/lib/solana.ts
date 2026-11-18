import { AnchorProvider, BorshCoder, Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "./idl/launchpad.json";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const CLUSTER = "devnet";
export const LAUNCHPAD_ID = new PublicKey((idl as { address: string }).address);
export const LAMPORTS = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
export const TOTAL_SUPPLY = 1_000_000_000; // whole tokens

export const pda = (seed: string, key?: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...(key ? [key.toBuffer()] : [])], LAUNCHPAD_ID)[0];

export const configPda = () => pda("config");
export const curvePda = (mint: PublicKey) => pda("curve", mint);
export const solVaultPda = (mint: PublicKey) => pda("sol_vault", mint);
export const vaultAta = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, curvePda(mint), true);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProgram(connection: Connection, wallet?: any): any {
  const w = wallet ?? {
    publicKey: PublicKey.default,
    signTransaction: async () => { throw new Error("connect a wallet"); },
    signAllTransactions: async () => { throw new Error("connect a wallet"); },
  };
  const provider = new AnchorProvider(connection, w, { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as any, provider);
}

export type CurveView = {
  address: string;
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
  launchSlot: number;
  complete: boolean;
};

export type ConfigView = {
  feeRecipient: string;
  tradeFeeBps: number;
  creatorFeeBps: number;
  launchFee: bigint;
  curveSupply: bigint;
  maxCreatorBuyBps: number;
  sniperSlots: number;
  sniperMaxBps: number;
  virtualSol: bigint;
  virtualToken: bigint;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const big = (x: any) => BigInt(x.toString());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCurve(address: PublicKey, a: any): CurveView {
  return {
    address: address.toBase58(),
    mint: a.mint.toBase58(),
    creator: a.creator.toBase58(),
    name: a.name,
    symbol: a.symbol,
    uri: a.uri,
    virtualSol: big(a.virtualSol),
    virtualToken: big(a.virtualToken),
    realSol: big(a.realSol),
    realToken: big(a.realToken),
    launchSlot: Number(a.launchSlot.toString()),
    complete: a.complete,
  };
}

export async function fetchConfig(connection: Connection): Promise<ConfigView> {
  const c = await getProgram(connection).account.config.fetch(configPda());
  return {
    feeRecipient: c.feeRecipient.toBase58(),
    tradeFeeBps: c.tradeFeeBps,
    creatorFeeBps: c.creatorFeeBps,
    launchFee: big(c.launchFee),
    curveSupply: big(c.curveSupply),
    maxCreatorBuyBps: c.maxCreatorBuyBps,
    sniperSlots: Number(c.sniperSlots.toString()),
    sniperMaxBps: c.sniperMaxBps,
    virtualSol: big(c.virtualSol),
    virtualToken: big(c.virtualToken),
  };
}

export async function fetchCurves(connection: Connection): Promise<CurveView[]> {
  const all = await getProgram(connection).account.curve.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return all.map((x: any) => toCurve(x.publicKey, x.account)).sort((a: CurveView, b: CurveView) => b.launchSlot - a.launchSlot);
}

export async function fetchCurve(connection: Connection, mint: PublicKey): Promise<CurveView> {
  const a = await getProgram(connection).account.curve.fetch(curvePda(mint));
  return toCurve(curvePda(mint), a);
}

export type TradeView = {
  sig: string;
  trader: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  price: number; // SOL per token after the trade
  time: number;
  slot: number;
};

export async function fetchTrades(connection: Connection, mint: PublicKey, limit = 60): Promise<TradeView[]> {
  // Decode every "Program data:" line ourselves: Anchor's EventParser skips
  // events emitted inside a CPI, which is how private trades reach the launchpad.
  const coder = new BorshCoder(idl as never);
  const parseLogs = (logs: string[]) =>
    logs.filter((l) => l.startsWith("Program data: ")).map((l) => { try { return coder.events.decode(l.slice(14)); } catch { return null; } })
      .filter((e): e is NonNullable<typeof e> => !!e);
  const sigs = (await connection.getSignaturesForAddress(curvePda(mint), { limit })).filter((s) => !s.err);
  const txs = await connection.getTransactions(sigs.map((s) => s.signature), {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const out: TradeView[] = [];
  txs.forEach((tx, i) => {
    if (!tx?.meta?.logMessages) return;
    for (const ev of parseLogs(tx.meta.logMessages)) {
      if (ev.name.toLowerCase() !== "trade") continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = ev.data;
      const vs = d.virtualSol ?? d.virtual_sol, vt = d.virtualToken ?? d.virtual_token;
      out.push({
        sig: sigs[i].signature,
        trader: d.trader.toBase58(),
        isBuy: d.isBuy ?? d.is_buy,
        sol: Number(d.sol.toString()) / LAMPORTS,
        tokens: Number(d.tokens.toString()) / 10 ** TOKEN_DECIMALS,
        price: priceOf(big(vs), big(vt)),
        time: Number(d.timestamp.toString()),
        slot: tx.slot,
      });
    }
  });
  return out.sort((a, b) => a.slot - b.slot); // chronological
}

// ---- pricing (mirrors programs/launchpad quote_buy / quote_sell) ----

export const priceOf = (vs: bigint, vt: bigint) =>
  Number(vs) / LAMPORTS / (Number(vt) / 10 ** TOKEN_DECIMALS);

export const progressOf = (c: CurveView, curveSupply: bigint) =>
  c.complete ? 1 : Number(curveSupply - c.realToken) / Number(curveSupply);

const divCeil = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function quoteBuy(c: CurveView, cfg: ConfigView, lamportsIn: bigint) {
  const fee = (lamportsIn * BigInt(cfg.tradeFeeBps)) / 10000n;
  const cfee = (lamportsIn * BigInt(cfg.creatorFeeBps)) / 10000n;
  const net = lamportsIn - fee - cfee;
  const k = c.virtualSol * c.virtualToken;
  const newVt = divCeil(k, c.virtualSol + net);
  let out = c.virtualToken - newVt;
  if (out > c.realToken) out = c.realToken;
  return { tokensOut: out, fee: fee + cfee };
}

export function quoteSell(c: CurveView, cfg: ConfigView, tokensIn: bigint) {
  const k = c.virtualSol * c.virtualToken;
  const newVs = divCeil(k, c.virtualToken + tokensIn);
  const gross = c.virtualSol - newVs;
  const fee = (gross * BigInt(cfg.tradeFeeBps + cfg.creatorFeeBps)) / 10000n;
  return { solOut: gross - fee, fee };
}

export const short = (a: string) => a.slice(0, 4) + "…" + a.slice(-4);
export const explorer = (kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
export const fmtSol = (n: number, d = 4) => n.toLocaleString(undefined, { maximumFractionDigits: d });
export const fmtPrice = (n: number) => (n === 0 ? "0" : n < 0.000001 ? n.toExponential(3) : n.toFixed(9));
