"use client";
// Landing page: $PATULA — token incoming, and everything it will power.
import { motion } from "framer-motion";
import { Reveal } from "./Reveal";

type Status = "At launch" | "With mainnet" | "Planned";
const UTILITIES: { icon: string; title: string; body: string; status: Status }[] = [
  {
    icon: "◎",
    title: "Stake to earn",
    body: "Stake $PATULA and earn a share of every $PATULA trade in SOL, like every token on Patula. Claim or unstake any time.",
    status: "At launch",
  },
  {
    icon: "↻",
    title: "Creator-fee buybacks",
    body: "Launchers can opt in to take their creator fees in $PATULA. Each claim buys $PATULA on the open market and sends it to them.",
    status: "With mainnet",
  },
  {
    icon: "%",
    title: "Lower fees",
    body: "Holders and stakers pay a reduced platform fee on trades, and a lower relayer fee on private transactions.",
    status: "Planned",
  },
  {
    icon: "◉",
    title: "Private launch credits",
    body: "Pay for anonymous launches in $PATULA at a discount, straight from your shielded balance.",
    status: "Planned",
  },
  {
    icon: "⇡",
    title: "Boosted launches",
    body: "Spend $PATULA to feature a launch on Explore. Boosts are visible on-chain, so promotion is never hidden.",
    status: "Planned",
  },
  {
    icon: "⛨",
    title: "Relayer network",
    body: "Independent relayers stake $PATULA as a bond to submit private transactions. Misbehave and the bond is at risk.",
    status: "Planned",
  },
  {
    icon: "⚖",
    title: "Governance",
    body: "Vote on platform settings within the hard caps written into the program: platform fee, launch fee, featured rules.",
    status: "Planned",
  },
  {
    icon: "✺",
    title: "Ecosystem rewards",
    body: "Grants and rewards for builders, relayer operators and community members who grow the Patula ecosystem.",
    status: "Planned",
  },
];

const FACTS = [
  ["1,000,000,000", "fixed supply"],
  ["Revoked", "minting & freeze"],
  ["Locked forever", "liquidity at graduation"],
  ["On Patula", "same rules as every token"],
];

function Coin() {
  return (
    <div className="coin-wrap" aria-hidden="true">
      <motion.div className="coin-glow" animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }} transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }} />
      <motion.div className="coin" animate={{ rotateY: [-22, 22, -22], rotateX: [8, -6, 8], y: [0, -12, 0] }} transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-mark.svg" alt="" />
      </motion.div>
      <motion.div className="orbit" animate={{ rotate: 360 }} transition={{ duration: 30, repeat: Infinity, ease: "linear" }}>
        {["Stake", "Buyback", "Fees", "Relayers", "Governance", "Boosts"].map((t, i) => (
          <span key={t} style={{ transform: `rotate(${i * 60}deg) translateY(-205px) rotate(${-i * 60}deg)` }}>{t}</span>
        ))}
      </motion.div>
    </div>
  );
}

export default function TokenSection() {
  return (
    <section className="section" id="token" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <div className="token-hero card">
          <div className="token-hero-copy">
            <Reveal>
              <span className="incoming"><span className="pulse" /> Token incoming</span>
              <h2><span className="grad">$PATULA</span><br />powers the <span className="serif" style={{ fontStyle: "italic" }}>ecosystem.</span></h2>
              <p>
                The community token of Patula. It launches on Patula itself, under the same rules as every other token,
                and ties creators, traders, stakers and relayers into one economy.
              </p>
            </Reveal>
            <Reveal delay={0.08}>
              <div className="token-facts">
                {FACTS.map(([v, l]) => (
                  <div key={l}><b>{v}</b><small>{l}</small></div>
                ))}
              </div>
            </Reveal>
            <Reveal delay={0.12}>
              <div className="hero-cta" style={{ marginTop: 26 }}>
                <a className="btn btn-primary" href="/app">Try the devnet app</a>
                <span className="muted small">Launch date announced on X.</span>
              </div>
            </Reveal>
          </div>
          <Coin />
        </div>

        <div className="section-head" style={{ marginTop: 80, marginBottom: 40 }}>
          <Reveal>
            <span className="eyebrow">What $PATULA powers</span>
            <h2 style={{ fontSize: "clamp(34px, 4.5vw, 64px)" }}>One token,<br /><span className="serif grad" style={{ fontStyle: "italic" }}>every corner</span> of Patula.</h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p>Some of this is live the day $PATULA launches; the rest is on the roadmap. Each card says which.</p>
          </Reveal>
        </div>

        <div className="utilities">
          {UTILITIES.map((u, i) => (
            <Reveal key={u.title} delay={(i % 4) * 0.06}>
              <motion.div className="card utility" whileHover={{ y: -6 }} transition={{ type: "spring", stiffness: 300, damping: 24 }}>
                <div className="utility-top">
                  <span className="g-icon">{u.icon}</span>
                  <span className={`status ${u.status === "At launch" ? "live" : u.status === "With mainnet" ? "soon" : ""}`}>{u.status}</span>
                </div>
                <h4>{u.title}</h4>
                <p>{u.body}</p>
              </motion.div>
            </Reveal>
          ))}
        </div>
        <p className="token-note">
          $PATULA is a utility token for the Patula platform, not an investment. Features marked “Planned” are on the roadmap
          and may change before they ship. Nothing here is financial advice.
        </p>
      </div>
    </section>
  );
}
