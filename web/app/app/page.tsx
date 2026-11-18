"use client";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import {
  ConfigView, CurveView, curvePrice, fetchConfig, fetchCurves, fmtPrice, pct, progressOf, short, TOTAL_SUPPLY,
} from "@/lib/solana";
import TokenAvatar from "@/components/app/TokenAvatar";
import { useTokenMeta } from "@/lib/meta";

function Desc({ uri }: { uri: string }) {
  const m = useTokenMeta(uri);
  return m?.description ? <p className="tc-desc">{m.description}</p> : null;
}

export default function Explore() {
  const { connection } = useConnection();
  const [curves, setCurves] = useState<CurveView[] | null>(null);
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([fetchCurves(connection), fetchConfig(connection)])
        .then(([c, f]) => { if (live) { setCurves(c); setCfg(f); setError(""); } })
        .catch((e) => live && setError(String(e?.message || e)));
    load();
    const id = setInterval(load, 15000);
    return () => { live = false; clearInterval(id); };
  }, [connection]);

  return (
    <>
      <div className="app-hero">
        <div>
          <span className="eyebrow">Live on devnet</span>
          <h1>Explore <span className="serif grad" style={{ fontStyle: "italic" }}>launches</span></h1>
          <p>Every token here has fixed supply, locked liquidity and a capped creator buy, enforced by the program.</p>
        </div>
        <Link href="/app/create" className="btn btn-primary">Launch a token</Link>
      </div>

      {error && <div className="notice">Couldn’t reach devnet: {error}</div>}
      {!curves && !error && <div className="grid-tokens">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="card token-card skeleton" />)}</div>}
      {curves && curves.length === 0 && <div className="notice">No tokens yet. Be the first to launch one.</div>}

      <div className="grid-tokens">
        {curves?.map((c, i) => {
          const price = curvePrice(c);
          const p = cfg ? progressOf(c, cfg.curveSupply) : 0;
          return (
            <motion.div key={c.mint} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
              <Link href={`/app/t/${c.mint}`} className="card token-card">
                <div className="tc-top">
                  <TokenAvatar seed={c.mint} uri={c.uri} />
                  <div>
                    <h3>{c.name}</h3>
                    <small>${c.symbol} · by {short(c.creator)}</small>
                  </div>
                  {c.complete && <span className="pill-grad">Graduated</span>}
                </div>
                <Desc uri={c.uri} />
                <div className="fee-chips sm">
                  <span className="chip">Buy {pct(c.fees.buyFeeBps + (cfg?.platformFeeBps ?? 0))}</span>
                  <span className="chip">Sell {pct(c.fees.sellFeeBps + (cfg?.platformFeeBps ?? 0))}</span>
                  {c.fees.holderShareBps > 0 && (c.fees.buyFeeBps + c.fees.sellFeeBps) > 0 && <span className="chip">◎ stake to earn</span>}
                </div>
                <div className="tc-stats">
                  <div><small>Price</small><b>{fmtPrice(price)} SOL</b></div>
                  <div><small>Market cap</small><b>{(price * TOTAL_SUPPLY).toFixed(2)} SOL</b></div>
                </div>
                <div className="progress"><span style={{ width: `${(p * 100).toFixed(1)}%` }} /></div>
                <small className="tc-prog">{c.complete ? "Graduated · locked pool" : `${(p * 100).toFixed(1)}% to graduation`}</small>
              </Link>
            </motion.div>
          );
        })}
      </div>
    </>
  );
}
