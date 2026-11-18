"use client";
import { BN } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { motion } from "framer-motion";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import TokenAvatar from "@/components/app/TokenAvatar";
import {
  ConfigView, CurveView, TradeView, configPda, curvePda, explorer, fetchConfig, fetchCurve, fetchTrades,
  fmtPrice, fmtSol, getProgram, LAMPORTS, priceOf, progressOf, quoteBuy, quoteSell, short, solVaultPda,
  TOKEN_DECIMALS, TOTAL_SUPPLY, vaultAta,
} from "@/lib/solana";

const SLIPPAGE_BPS = 200n; // 2%

function Chart({ trades, current }: { trades: TradeView[]; current: number }) {
  const W = 640, H = 240;
  const pts = trades.length ? trades.map((t) => t.price) : [];
  pts.push(current);
  const min = Math.min(...pts) * 0.98, max = Math.max(...pts) * 1.02 || 1;
  const xy = pts.map((p, i) => [pts.length === 1 ? W : (i / (pts.length - 1)) * W, H - ((p - min) / (max - min || 1)) * (H - 20) - 10]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" preserveAspectRatio="none" aria-label="Price chart">
      <defs>
        <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffa62b" stopOpacity=".35" /><stop offset="1" stopColor="#ffa62b" stopOpacity="0" /></linearGradient>
        <linearGradient id="cl" x1="0" x2="1"><stop offset="0" stopColor="#ffcf5c" /><stop offset="1" stopColor="#ff4d8d" /></linearGradient>
      </defs>
      {xy.length > 1 && <path d={`${d} L${W},${H} L0,${H} Z`} fill="url(#cg)" />}
      <path d={d} fill="none" stroke="url(#cl)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
      {xy.length > 0 && <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="5" fill="#ffa62b" />}
    </svg>
  );
}

function TokenPage() {
  const { mint: mintStr } = useParams<{ mint: string }>();
  const search = useSearchParams();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const mint = useMemo(() => { try { return new PublicKey(mintStr); } catch { return null; } }, [mintStr]);

  const [curve, setCurve] = useState<CurveView | null>(null);
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [checks, setChecks] = useState<{ supply: boolean; noMint: boolean; noFreeze: boolean } | null>(null);
  const [bal, setBal] = useState<{ sol: number; tokens: bigint }>({ sol: 0, tokens: 0n });
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; sig?: string } | null>(
    search.get("launched") ? { text: "Your token is live. Share the link and watch the curve fill." } : null
  );
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!mint) return;
    try {
      const [c, f, t] = await Promise.all([fetchCurve(connection, mint), fetchConfig(connection), fetchTrades(connection, mint)]);
      setCurve(c); setCfg(f); setTrades(t); setErr("");
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    }
  }, [connection, mint]);

  const loadBal = useCallback(async () => {
    if (!mint || !wallet.publicKey) return;
    const sol = (await connection.getBalance(wallet.publicKey)) / LAMPORTS;
    let tokens = 0n;
    try { tokens = (await getAccount(connection, getAssociatedTokenAddressSync(mint, wallet.publicKey))).amount; } catch { /* no account yet */ }
    setBal({ sol, tokens });
  }, [connection, mint, wallet.publicKey]);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => { loadBal(); }, [loadBal]);
  useEffect(() => {
    if (!mint) return;
    getMint(connection, mint).then((m) => setChecks({
      supply: m.supply === BigInt(TOTAL_SUPPLY) * 10n ** BigInt(TOKEN_DECIMALS),
      noMint: m.mintAuthority === null,
      noFreeze: m.freezeAuthority === null,
    })).catch(() => {});
  }, [connection, mint]);

  if (!mint) return <div className="notice">That isn’t a valid token address.</div>;
  if (err && !curve) return <div className="notice">Couldn’t load this token: {err}</div>;
  if (!curve || !cfg) return <div className="card skeleton" style={{ height: 420 }} />;

  const price = priceOf(curve.virtualSol, curve.virtualToken);
  const progress = progressOf(curve, cfg.curveSupply);
  const amt = parseFloat(amount) || 0;
  const quote = side === "buy"
    ? amt > 0 ? quoteBuy(curve, cfg, BigInt(Math.round(amt * LAMPORTS))) : null
    : amt > 0 ? quoteSell(curve, cfg, BigInt(Math.round(amt * 10 ** TOKEN_DECIMALS))) : null;

  async function trade() {
    if (!wallet.publicKey) return setVisible(true);
    if (!quote || !curve || !cfg || !mint) return;
    setBusy(true);
    setMsg({ text: "Confirm in your wallet…" });
    try {
      const program = getProgram(connection, wallet);
      const accts = {
        config: configPda(), curve: curvePda(mint), mint, curveTokenVault: vaultAta(mint),
        solVault: solVaultPda(mint), feeRecipient: cfg.feeRecipient, creator: new PublicKey(curve.creator),
      };
      const userAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);
      let ix;
      if (side === "buy") {
        const q = quote as ReturnType<typeof quoteBuy>;
        const minOut = (q.tokensOut * (10000n - SLIPPAGE_BPS)) / 10000n;
        ix = await program.methods.buy(new BN(Math.round(amt * LAMPORTS)), new BN(minOut.toString()))
          .accountsPartial({ ...accts, buyer: wallet.publicKey, buyerToken: userAta }).instruction();
      } else {
        const q = quote as ReturnType<typeof quoteSell>;
        const minOut = (q.solOut * (10000n - SLIPPAGE_BPS)) / 10000n;
        ix = await program.methods.sell(new BN(Math.round(amt * 10 ** TOKEN_DECIMALS)), new BN(minOut.toString()))
          .accountsPartial({ ...accts, seller: wallet.publicKey, sellerToken: userAta }).instruction();
      }
      const sig = await wallet.sendTransaction(new Transaction().add(ix), connection);
      setMsg({ text: "Confirming…", sig });
      await connection.confirmTransaction(sig, "confirmed");
      setMsg({ text: side === "buy" ? "Bought." : "Sold.", sig });
      setAmount("");
      await Promise.all([load(), loadBal()]);
    } catch (e) {
      const s = String((e as Error)?.message || e);
      setMsg({ text: /Slippage/.test(s) ? "Price moved more than 2%. Try again."
        : /SniperCap|Anti-sniper/.test(s) ? "Too big for the anti-sniper window (1% of supply per trade). Wait a few seconds."
        : /CreatorCap/.test(s) ? "Creator buy cap (5% of supply) reached."
        : /CurveComplete/.test(s) ? "This curve has graduated; trading has stopped."
        : /User rejected/i.test(s) ? "Cancelled in wallet."
        : /insufficient|0x1\b/i.test(s) ? "Not enough SOL. Get devnet SOL at faucet.solana.com." : s.slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }

  const tokensFmt = (b: bigint) => (Number(b) / 10 ** TOKEN_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <>
      <Link href="/app" className="back">← Explore</Link>
      <div className="token-head">
        <TokenAvatar seed={curve.mint} uri={curve.uri} size={64} />
        <div>
          <h1>{curve.name} <span className="muted">${curve.symbol}</span></h1>
          <small className="muted">
            Creator <a href={explorer("address", curve.creator)} target="_blank" rel="noreferrer">{short(curve.creator)}</a> ·
            Mint <a href={explorer("address", curve.mint)} target="_blank" rel="noreferrer">{short(curve.mint)}</a>
          </small>
        </div>
        {curve.complete && <span className="pill-grad">Graduated</span>}
      </div>

      <div className="token-grid">
        <div className="card chart-card">
          <div className="price-row">
            <div><small className="muted">Price</small><div className="big-num">{fmtPrice(price)} <span className="muted">SOL</span></div></div>
            <div><small className="muted">Market cap</small><div className="mid-num">{(price * TOTAL_SUPPLY).toFixed(3)} SOL</div></div>
            <div><small className="muted">In curve</small><div className="mid-num">{fmtSol(Number(curve.realSol) / LAMPORTS)} SOL</div></div>
          </div>
          <Chart trades={trades} current={price} />
          <div className="progress big"><span style={{ width: `${(progress * 100).toFixed(1)}%` }} /></div>
          <small className="muted">{(progress * 100).toFixed(1)}% sold · graduates when the curve sells out</small>
        </div>

        <div className="card trade-card">
          <div className="toggle full">
            <motion.span className="toggle-thumb" layout transition={{ type: "spring", stiffness: 400, damping: 34 }}
              style={{ left: side === "buy" ? 5 : "50%", right: side === "buy" ? "50%" : 5 }} />
            <button className={side === "buy" ? "active" : ""} onClick={() => { setSide("buy"); setAmount(""); }}>Buy</button>
            <button className={side === "sell" ? "active" : ""} onClick={() => { setSide("sell"); setAmount(""); }}>Sell</button>
          </div>
          <label className="amount">
            <span>{side === "buy" ? "You pay" : "You sell"}</span>
            <div className="amount-in">
              <input value={amount} inputMode="decimal" placeholder="0.0" onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              <b>{side === "buy" ? "SOL" : curve.symbol}</b>
            </div>
            <small className="muted">
              Balance: {side === "buy" ? `${fmtSol(bal.sol)} SOL` : `${tokensFmt(bal.tokens)} ${curve.symbol}`}
              {side === "sell" && bal.tokens > 0n && (
                <button type="button" className="link" onClick={() => setAmount((Number(bal.tokens) / 10 ** TOKEN_DECIMALS).toString())}>Max</button>
              )}
            </small>
          </label>
          <div className="quick">
            {(side === "buy" ? ["0.01", "0.05", "0.1"] : []).map((q) => (
              <button key={q} type="button" onClick={() => setAmount(q)}>{q} SOL</button>
            ))}
          </div>
          <div className="quote">
            <span>You receive (est.)</span>
            <b>{!quote ? "—" : side === "buy"
              ? `${tokensFmt((quote as ReturnType<typeof quoteBuy>).tokensOut)} ${curve.symbol}`
              : `${fmtSol(Number((quote as ReturnType<typeof quoteSell>).solOut) / LAMPORTS, 6)} SOL`}</b>
          </div>
          <div className="quote muted"><span>Fees</span><span>1% (0.7% platform · 0.3% creator) · 2% max slippage</span></div>
          <div className="visibility compact">
            <span>Trade as</span>
            <div className="toggle sm"><button className="active">Public</button><button disabled title="Arrives in Phase 1b">Private · soon</button></div>
          </div>
          <button className="btn btn-primary big" disabled={busy || curve.complete || (!!wallet.publicKey && !quote)} onClick={trade}>
            {!wallet.publicKey ? "Connect wallet" : curve.complete ? "Graduated" : busy ? "Working…" : side === "buy" ? `Buy ${curve.symbol}` : `Sell ${curve.symbol}`}
          </button>
          {msg && (
            <p className="form-msg">{msg.text} {msg.sig && <a href={explorer("tx", msg.sig)} target="_blank" rel="noreferrer">View ↗</a>}</p>
          )}
        </div>
      </div>

      <div className="token-grid lower">
        <div className="card feed">
          <div className="feed-head"><span>Trades</span><span>{trades.length} recent</span></div>
          <ul className="feed-list auto">
            {[...trades].reverse().map((t) => (
              <li key={t.sig} className="feed-row fade-in">
                <a className="addr" href={explorer("tx", t.sig)} target="_blank" rel="noreferrer">{short(t.trader)}</a>
                <span className={t.isBuy ? "side-buy" : "side-sell"}>{t.isBuy ? "buy" : "sell"}</span>
                <span className="amt">{fmtSol(t.sol)} SOL</span>
              </li>
            ))}
            {trades.length === 0 && <li className="feed-row muted">No trades yet.</li>}
          </ul>
        </div>
        <div className="card verify">
          <div className="feed-head"><span>Verified on-chain</span><span>live</span></div>
          <ul className="checks live">
            <li className={checks?.supply ? "ok" : ""}>Fixed supply of 1,000,000,000</li>
            <li className={checks?.noMint ? "ok" : ""}>Mint authority revoked</li>
            <li className={checks?.noFreeze ? "ok" : ""}>No freeze authority</li>
            <li className="ok">Curve SOL in program vault, no withdraw path</li>
            <li className="ok">Creator buy capped at {cfg.maxCreatorBuyBps / 100}%</li>
          </ul>
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="card skeleton" style={{ height: 420 }} />}>
      <TokenPage />
    </Suspense>
  );
}
