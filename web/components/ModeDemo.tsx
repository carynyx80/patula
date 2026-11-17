"use client";
// Simulated market: a bonding curve that fills as trades stream in, and a
// trade feed that shows wallets in public mode and "Private buyer" in private mode.
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Reveal } from "./Reveal";

type Trade = { id: number; addr: string; priv: boolean; side: "buy" | "sell"; sol: number };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const randAddr = () => {
  let s = "";
  for (let i = 0; i < 8; i++) s += B58[Math.floor(Math.random() * B58.length)];
  return s.slice(0, 4) + "…" + s.slice(4);
};

const W = 520, H = 220;
const curveY = (x: number) => H - 12 - (H - 30) * Math.pow(x, 2.2);

export default function ModeDemo() {
  const [priv, setPriv] = useState(true);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [fill, setFill] = useState(0.18);
  const idRef = useRef(0);
  const privRef = useRef(priv);
  privRef.current = priv;

  useEffect(() => {
    const tick = () => {
      const side: Trade["side"] = Math.random() < 0.78 ? "buy" : "sell";
      const sol = +(Math.random() ** 2 * 4 + 0.05).toFixed(2);
      // In private mode most traders opt in; in public mode a few still choose privacy.
      const p = Math.random() < (privRef.current ? 0.85 : 0.12);
      const t: Trade = { id: idRef.current++, addr: randAddr(), priv: p, side, sol };
      setTrades((prev) => [t, ...prev].slice(0, 9));
      setFill((f) => {
        const n = f + (side === "buy" ? sol : -sol) * 0.006;
        return n > 0.96 ? 0.2 : Math.max(0.08, n);
      });
    };
    for (let i = 0; i < 7; i++) tick();
    const id = setInterval(tick, 1300);
    return () => clearInterval(id);
  }, []);

  const path = useMemo(() => {
    let d = "";
    for (let i = 0; i <= 60; i++) {
      const x = i / 60;
      d += `${i ? "L" : "M"}${(x * W).toFixed(1)},${curveY(x).toFixed(1)}`;
    }
    return d;
  }, []);
  const filled = useMemo(() => {
    let d = `M0,${H}`;
    const n = Math.max(2, Math.round(fill * 60));
    for (let i = 0; i <= n; i++) {
      const x = (i / 60);
      d += ` L${(x * W).toFixed(1)},${curveY(x).toFixed(1)}`;
    }
    return d + ` L${((n / 60) * W).toFixed(1)},${H} Z`;
  }, [fill]);

  const price = (0.0000021 * Math.exp(fill * 4.2)).toFixed(7);
  const px = fill * W, py = curveY(fill);

  return (
    <section className="section" id="choice">
      <div className="wrap">
        <div className="section-head">
          <Reveal>
            <span className="eyebrow">Your choice</span>
            <h2>One market.<br /><span className="serif grad" style={{ fontStyle: "italic" }}>Two ways</span> to be in it.</h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p>Public and private traders share the same curve and the same liquidity. Flip the switch to see what everyone else sees.</p>
          </Reveal>
        </div>

        <Reveal>
          <div style={{ marginBottom: 20 }}>
            <div className="toggle" role="tablist" aria-label="Visibility">
              <motion.span className="toggle-thumb" layout transition={{ type: "spring", stiffness: 400, damping: 34 }}
                style={{ left: priv ? "50%" : 5, right: priv ? 5 : "50%" }} />
              <button role="tab" aria-selected={!priv} className={!priv ? "active" : ""} onClick={() => setPriv(false)}>Public</button>
              <button role="tab" aria-selected={priv} className={priv ? "active" : ""} onClick={() => setPriv(true)}>Private</button>
            </div>
          </div>
        </Reveal>

        <div className="demo">
          <Reveal>
            <div className="card curve-card">
              <div className="curve-top">
                <div className="token">
                  <div className="token-avatar" />
                  <div>
                    <h3>$MARI</h3>
                    <small>Marigold · bonding curve</small>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <small style={{ color: "var(--ink-3)", fontSize: 12 }}>CREATOR</small>
                  <AnimatePresence mode="wait">
                    <motion.div key={String(priv)} className="creator"
                      initial={{ opacity: 0, filter: "blur(8px)" }} animate={{ opacity: 1, filter: "blur(0px)" }}
                      exit={{ opacity: 0, filter: "blur(8px)" }} transition={{ duration: 0.45 }}
                      style={{ color: priv ? "var(--saffron)" : "var(--ink)" }}>
                      {priv ? "◉ Anonymous creator" : "7xKp…Qm4R"}
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
              <div className="price">{price} <span style={{ fontSize: 18, color: "var(--ink-3)" }}>SOL</span>
                <small>{(fill * 100).toFixed(1)}% to graduation</small>
              </div>
              <svg className="curve-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Bonding curve">
                <defs>
                  <linearGradient id="cf" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#ffa62b" stopOpacity=".45" />
                    <stop offset="1" stopColor="#ffa62b" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="cs" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#ffcf5c" /><stop offset="1" stopColor="#ff4d8d" />
                  </linearGradient>
                </defs>
                <path d={path} fill="none" stroke="rgba(246,241,234,.12)" strokeWidth="1.5" strokeDasharray="4 6" />
                <motion.path d={filled} fill="url(#cf)" animate={{ d: filled }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} />
                <motion.circle r="7" fill="#ffa62b" animate={{ cx: px, cy: py }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }} />
                <motion.circle r="16" fill="#ffa62b" opacity=".18" animate={{ cx: px, cy: py, r: [14, 22, 14] }}
                  transition={{ duration: 0.8, r: { duration: 2, repeat: Infinity } }} />
              </svg>
            </div>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="card feed">
              <div className="feed-head"><span>Trader</span><span>Live trades</span></div>
              <ul className="feed-list">
                <AnimatePresence initial={false}>
                  {trades.map((t) => (
                    <motion.li key={t.id} className="feed-row" layout
                      initial={{ opacity: 0, y: -24, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={{ opacity: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
                      {t.priv ? (
                        <span className="addr private">◉ Private {t.side === "buy" ? "buyer" : "seller"}<span className="blur">{t.addr}</span></span>
                      ) : (
                        <span className="addr">{t.addr}</span>
                      )}
                      <span className={t.side === "buy" ? "side-buy" : "side-sell"}>{t.side}</span>
                      <span className="amt">{t.sol.toFixed(2)} SOL</span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          </Reveal>
        </div>
        <p className="demo-caption">Simulation. In v1 amounts and price stay public; only the link to a wallet is hidden.</p>
      </div>
    </section>
  );
}
