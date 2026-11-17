"use client";
import { animate, motion, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Reveal } from "./Reveal";
import FluidCanvas from "./FluidCanvas";
import { GITHUB } from "./Hero";
import { getJSON, Stats } from "@/lib/api";

/* ---------------- how it works ---------------- */

function ShieldVisual() {
  // coins from many wallets stream into one pool ring
  return (
    <svg viewBox="0 0 220 180" width="100%" height="100%">
      <circle cx="160" cy="90" r="42" fill="none" stroke="url(#sg)" strokeWidth="2" />
      <circle cx="160" cy="90" r="30" fill="rgba(255,166,43,.08)" />
      <defs>
        <linearGradient id="sg"><stop offset="0" stopColor="#ffcf5c" /><stop offset="1" stopColor="#ff4d8d" /></linearGradient>
      </defs>
      {[30, 70, 110, 150].map((y, i) => (
        <g key={i}>
          <circle cx="22" cy={y - 10} r="5" fill="none" stroke="rgba(246,241,234,.35)" />
          <motion.circle r="4" fill="#ffa62b"
            initial={{ cx: 22, cy: y - 10, opacity: 0 }}
            animate={{ cx: [22, 160], cy: [y - 10, 90], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 2.2, repeat: Infinity, delay: i * 0.55, ease: "easeInOut" }} />
        </g>
      ))}
    </svg>
  );
}

function ProveVisual() {
  // Merkle path lighting up from a leaf to the root
  const nodes = [
    { x: 110, y: 22, l: 3 }, { x: 60, y: 72, l: 2 }, { x: 160, y: 72, l: 2 },
    { x: 35, y: 122, l: 1 }, { x: 85, y: 122, l: 1 }, { x: 135, y: 122, l: 1 }, { x: 185, y: 122, l: 1 },
  ];
  const edges = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [2, 6]];
  const lit = [4, 1, 0];
  return (
    <svg viewBox="0 0 220 160" width="100%" height="100%">
      {edges.map(([a, b], i) => (
        <line key={i} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y} stroke="rgba(246,241,234,.14)" />
      ))}
      {nodes.map((n, i) => {
        const k = lit.indexOf(i);
        return (
          <motion.circle key={i} cx={n.x} cy={n.y} r={8} fill="#140d1c" stroke="rgba(246,241,234,.3)"
            animate={k >= 0 ? { fill: ["#140d1c", "#ffa62b", "#140d1c"], stroke: ["rgba(246,241,234,.3)", "#ffcf5c", "rgba(246,241,234,.3)"] } : {}}
            transition={{ duration: 2.4, repeat: Infinity, delay: k * 0.35 }} />
        );
      })}
      <text x="110" y="152" textAnchor="middle" fill="rgba(246,241,234,.4)" fontSize="10" fontFamily="monospace">π ✓ membership · no index revealed</text>
    </svg>
  );
}

function RelayVisual() {
  return (
    <svg viewBox="0 0 220 160" width="100%" height="100%">
      <path id="rp" d="M20,120 C70,20 150,140 200,40" fill="none" stroke="rgba(246,241,234,.16)" strokeDasharray="3 5" />
      <rect x="6" y="108" width="28" height="24" rx="6" fill="#140d1c" stroke="rgba(246,241,234,.3)" />
      <text x="20" y="124" textAnchor="middle" fill="#ffcf5c" fontSize="10">you</text>
      <rect x="92" y="62" width="36" height="24" rx="6" fill="#140d1c" stroke="#ffa62b" />
      <text x="110" y="78" textAnchor="middle" fill="#ffa62b" fontSize="9">relayer</text>
      <circle cx="200" cy="40" r="14" fill="rgba(107,47,191,.35)" stroke="#b48cff" />
      <text x="200" y="44" textAnchor="middle" fill="#e5d8ff" fontSize="9">SOL</text>
      <motion.circle r="5" fill="#ffcf5c"
        style={{ offsetPath: "path('M20,120 C70,20 150,140 200,40')" } as React.CSSProperties}
        animate={{ offsetDistance: ["0%", "100%"] } as never}
        transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }} />
    </svg>
  );
}

export function HowItWorks() {
  const steps = [
    { n: "01", t: "Shield", d: "Deposit SOL from any wallet. Your browser creates a secret note; only its hash goes on-chain.", v: <ShieldVisual /> },
    { n: "02", t: "Prove", d: "Launch or buy with a zero-knowledge proof: “I own a note in this pool” without saying which one.", v: <ProveVisual /> },
    { n: "03", t: "Relay", d: "A relayer pays the fee and submits. Recipient and fee are locked inside the proof, so it can’t cheat.", v: <RelayVisual /> },
  ];
  return (
    <section className="section" id="how" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <div className="section-head">
          <Reveal>
            <span className="eyebrow">How private mode works</span>
            <h2>Three steps.<br /><span className="serif" style={{ fontStyle: "italic" }}>No trail.</span></h2>
          </Reveal>
          <Reveal delay={0.1}><p>The same flow powers private launches, private buys and private sells. Public mode skips it entirely.</p></Reveal>
        </div>
        <div className="steps">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.08}>
              <motion.div className="card step" whileHover={{ y: -6 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
                <span className="step-num">{s.n}</span>
                <div className="step-visual">{s.v}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- guarantees ---------------- */

export function Guarantees() {
  const items = [
    ["∞", "Fixed supply", "Mint and freeze authority are revoked at launch. Nobody can print more."],
    ["⌁", "Liquidity can’t be pulled", "Curve funds sit in a program vault; LP is burned or locked on graduation."],
    ["%", "Capped creator buy", "Dev allocation has a hard ceiling, with optional on-chain vesting — even for private notes."],
    ["⏱", "Anti-sniper window", "Per-proof caps in the first slots stop one person quietly buying the supply."],
    ["⛨", "Screened deposits", "Sanctioned addresses can’t enter the pool. Association sets keep bad funds out."],
    ["◎", "Viewing keys", "Prove your own history to an exchange or accountant — only when you choose."],
  ];
  return (
    <section className="section" id="rules" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <div className="section-head">
          <Reveal>
            <span className="eyebrow">Guarantees</span>
            <h2>Anonymous people.<br /><span className="serif grad" style={{ fontStyle: "italic" }}>Verifiable rules.</span></h2>
          </Reveal>
          <Reveal delay={0.1}><p>Hiding a creator must never make a rug easier. Every Patula token ships with these, enforced by the program.</p></Reveal>
        </div>
        <Reveal>
          <div className="guarantees">
            {items.map(([icon, t, d]) => (
              <div className="g-item" key={t}>
                <span className="g-icon">{icon}</span>
                <h4>{t}</h4>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------- proof ---------------- */

function Counter({ to, decimals = 0, suffix = "" }: { to: number; decimals?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  useEffect(() => {
    if (!inView) return;
    const c = animate(0, to, {
      duration: 1.8, ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => { if (ref.current) ref.current.textContent = v.toFixed(decimals) + suffix; },
    });
    return () => c.stop();
  }, [inView, to, decimals, suffix]);
  return <span ref={ref}>0{suffix}</span>;
}

const FALLBACK: Stats = {
  phase0: [
    { tx: "deposit", proveMs: 1764, computeUnits: 145278, txBytes: 944 },
    { tx: "private transfer", proveMs: 1587, computeUnits: 145870, txBytes: 944 },
    { tx: "withdraw", proveMs: 1602, computeUnits: 146148, txBytes: 976 },
  ],
  constraints: 26784,
  testsPassed: 6,
  testsTotal: 6,
  pool: null,
};

export function Proof() {
  const [stats, setStats] = useState<Stats>(FALLBACK);
  const [live, setLive] = useState(false);
  useEffect(() => {
    getJSON<Stats>("/stats").then((s) => { if (s) { setStats(s); setLive(true); } });
  }, []);
  const avg = (k: "proveMs" | "computeUnits") => stats.phase0.reduce((a, b) => a + b[k], 0) / stats.phase0.length;
  return (
    <section className="section" id="proof" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <div className="section-head">
          <Reveal>
            <span className="eyebrow">Built, not promised</span>
            <h2>Phase 0 <span className="serif" style={{ fontStyle: "italic" }}>works.</span></h2>
          </Reveal>
          <Reveal delay={0.1}><p>A shielded SOL pool with on-chain Groth16 verification, running end to end. Numbers from the prototype test suite.</p></Reveal>
        </div>
        <div className="proof">
          <Reveal><div className="card stat"><div className="stat-value grad"><Counter to={avg("computeUnits") / 1000} suffix="k" /></div><div className="stat-label">compute units per private tx</div><div className="stat-note">≈10% of Solana’s per-tx budget</div></div></Reveal>
          <Reveal delay={0.06}><div className="card stat"><div className="stat-value"><Counter to={avg("proveMs") / 1000} decimals={1} suffix="s" /></div><div className="stat-label">to generate a proof</div><div className="stat-note">client-side, keys never leave you</div></div></Reveal>
          <Reveal delay={0.12}><div className="card stat"><div className="stat-value"><Counter to={stats.constraints / 1000} decimals={1} suffix="k" /></div><div className="stat-label">circuit constraints</div><div className="stat-note">2-in / 2-out, depth-20 tree</div></div></Reveal>
          <Reveal delay={0.18}><div className="card stat"><div className="stat-value"><Counter to={stats.testsPassed} />/{stats.testsTotal}</div><div className="stat-label">end-to-end tests passing</div><div className="stat-note">incl. double-spend & tamper rejection</div></div></Reveal>
        </div>
        <div className="proof-foot">
          <span className={`dot ${live ? "on" : ""}`} />
          {live ? "Served live by the Patula relayer API" : "Prototype figures"} · not audited · devnet only
        </div>
      </div>
    </section>
  );
}

/* ---------------- cta + footer ---------------- */

export function CTA() {
  return (
    <section className="section" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <div className="cta">
          <FluidCanvas intensity={0.8} />
          <div className="cta-inner">
            <h2>Choose<br /><span className="serif grad" style={{ fontStyle: "italic" }}>who sees you.</span></h2>
            <p>Patula is in active development. Follow the build, read the circuits, or run the pool yourself.</p>
            <a className="btn btn-primary" href={GITHUB} target="_blank" rel="noreferrer">Star on GitHub ↗</a>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer>
      <div className="wrap foot">
        <span>© {new Date().getFullYear()} Patula · Prototype software, not audited. Nothing here is financial advice.</span>
        <nav>
          <a href="#how">How it works</a>
          <a href="#rules">Guarantees</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
      </div>
    </footer>
  );
}
