"use client";
import { motion, useScroll, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import FluidCanvas from "./FluidCanvas";
import { getJSON, Health } from "@/lib/api";

export const GITHUB = "https://github.com/carynyx80/patula";

export function Logo() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="logo-mark" src="/logo-mark.svg" alt="" width={28} height={28} />;
}

export function Nav() {
  const [health, setHealth] = useState<Health | null | undefined>(undefined);
  useEffect(() => {
    getJSON<Health>("/health").then(setHealth);
  }, []);
  const state = health === undefined ? "" : health?.ok ? (health.programDeployed ? "on" : "warn") : "";
  const label =
    health === undefined ? "Connecting…" : !health ? "Relayer offline" :
    health.programDeployed ? `Relayer live · ${health.cluster}` : `Relayer up · program pending`;
  return (
    <motion.header className="nav" initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}>
      <a href="#top" className="logo"><Logo /> Patula</a>
      <nav className="nav-links">
        <a href="#choice">Your choice</a>
        <a href="#how">How it works</a>
        <a href="#rules">Guarantees</a>
        <a href="#token">Token</a>
        <a href="#proof">Proof</a>
      </nav>
      <div className="nav-right">
        <span className="status-pill" title={health?.relayer ?? ""}>
          <span className={`dot ${state}`} /><span className="label">{label}</span>
        </span>
        <a className="btn btn-primary" href="/app">Launch app</a>
      </div>
    </motion.header>
  );
}

const line1 = ["Launch", "in", "the", "open."];
const line2 = ["Or", "in", "the", "dark."];

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [0, 160]);
  const opacity = useTransform(scrollYProgress, [0, 0.7], [1, 0]);

  const word = (w: string, i: number, serif = false) => (
    <span className="word" key={w + i}>
      <motion.span style={{ display: "inline-block" }} className={serif ? "serif grad" : ""}
        initial={{ y: "110%" }} animate={{ y: 0 }}
        transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1], delay: 0.35 + i * 0.07 }}>
        {w}&nbsp;
      </motion.span>
    </span>
  );

  return (
    <section className="hero" id="top" ref={ref}>
      <FluidCanvas className="hero-canvas" />
      <div className="hero-fade" />
      <motion.div className="hero-inner wrap" style={{ y, opacity }}>
        <motion.span className="eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2, duration: 1 }}>
          Privacy launchpad · Solana
        </motion.span>
        <h1 style={{ marginTop: 22 }}>
          <span style={{ display: "block" }}>{line1.map((w, i) => word(w, i))}</span>
          <span style={{ display: "block" }}>{line2.map((w, i) => word(w, i + 4, i === 3))}</span>
        </h1>
        <motion.div className="hero-sub" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.1, duration: 1, ease: [0.22, 1, 0.36, 1] }}>
          <p>
            Patula lets creators and buyers choose, for every action, whether their wallet is seen.
            Anonymous people, verifiable rules: supply, liquidity and creator limits are enforced on-chain.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary" href="/app">Launch on devnet</a>
            <a className="btn btn-ghost" href="#choice">See it move</a>
          </div>
        </motion.div>
      </motion.div>
      <div className="scroll-hint">SCROLL · MOVE YOUR CURSOR</div>
    </section>
  );
}

export function Marquee() {
  const items = ["Anonymous launches", "Private buyers", "Zero-knowledge proofs", "Relayed transactions", "Locked liquidity", "Fixed supply", "Your choice, every trade"];
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {[...items, ...items].map((t, i) => <span key={i}>{t}</span>)}
      </div>
    </div>
  );
}
