"use client";
// Header button + slide-over panel for the shielded balance: unlock, deposit,
// withdraw, holdings, backup.
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { useShielded } from "./ShieldedProvider";
import { explorer, LAMPORTS, short, TOKEN_DECIMALS } from "@/lib/solana";

const sol = (l: bigint) => (Number(l) / LAMPORTS).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function ShieldedPanel() {
  const s = useShielded();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [open, setOpen] = useState(false);
  const [dep, setDep] = useState("");
  const [wAmt, setWAmt] = useState("");
  const [wTo, setWTo] = useState("");
  const [msg, setMsg] = useState<{ text: string; sig?: string } | null>(null);

  const run = async (fn: () => Promise<string>, done: string) => {
    setMsg(null);
    try {
      const sig = await fn();
      setMsg({ text: done, sig });
    } catch (e) {
      const t = String((e as Error)?.message || e);
      setMsg({ text: /User rejected/i.test(t) ? "Cancelled in wallet." : t.slice(0, 220) });
    }
  };

  const tokens = Object.entries(
    s.notes.filter((n) => n.mint).reduce<Record<string, bigint>>((a, n) => ({ ...a, [n.mint!]: (a[n.mint!] ?? 0n) + n.amount }), {})
  );

  return (
    <>
      <button className="shield-pill" onClick={() => setOpen(true)} aria-label="Shielded balance">
        <span className="shield-ico">◉</span>
        {s.unlocked ? `${sol(s.solBalance)} SOL` : "Private"}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="drawer-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.aside className="drawer" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 260, damping: 32 }}>
              <div className="drawer-head">
                <div>
                  <span className="eyebrow">Shielded balance</span>
                  <h2>{s.unlocked ? <>{sol(s.solBalance)} <span className="muted">SOL</span></> : "Locked"}</h2>
                </div>
                <button className="x" onClick={() => setOpen(false)} aria-label="Close">✕</button>
              </div>

              {!wallet.publicKey ? (
                <button className="btn btn-primary big" onClick={() => setVisible(true)}>Connect wallet</button>
              ) : !s.unlocked ? (
                <>
                  <p className="muted small">Sign a message to unlock. The signature derives the key that encrypts your private notes in this browser. No transaction, no cost.</p>
                  <button className="btn btn-primary big" onClick={() => s.unlock().catch((e) => setMsg({ text: String(e?.message || e) }))}>Unlock private balance</button>
                </>
              ) : (
                <>
                  <section className="drawer-sec">
                    <h4>Deposit</h4>
                    <p className="muted small">Public step: your wallet sends SOL into the pool. Wait a while and use round amounts before trading, so deposits and trades are hard to match.</p>
                    <div className="row">
                      <input value={dep} inputMode="decimal" placeholder="0.1" onChange={(e) => setDep(e.target.value.replace(/[^0-9.]/g, ""))} />
                      <button className="btn btn-primary" disabled={!!s.busy || !(parseFloat(dep) > 0)}
                        onClick={() => run(() => s.deposit(BigInt(Math.round(parseFloat(dep) * LAMPORTS))), "Deposited into the shielded pool.")}>Deposit</button>
                    </div>
                  </section>

                  <section className="drawer-sec">
                    <h4>Withdraw</h4>
                    <p className="muted small">Sent by the relayer to any address. Use a fresh one: withdrawing to the wallet you deposited from links them.</p>
                    <input value={wTo} placeholder="Recipient address" onChange={(e) => setWTo(e.target.value.trim())} />
                    <div className="row">
                      <input value={wAmt} inputMode="decimal" placeholder="0.05" onChange={(e) => setWAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
                      <button className="btn btn-ghost" disabled={!!s.busy || !(parseFloat(wAmt) > 0) || wTo.length < 32}
                        onClick={() => run(() => s.withdraw(BigInt(Math.round(parseFloat(wAmt) * LAMPORTS)), new PublicKey(wTo)), "Withdrawn privately.")}>Withdraw</button>
                    </div>
                    <small className="muted">Relayer fee {sol(s.relayerFee)} SOL</small>
                  </section>

                  <section className="drawer-sec">
                    <h4>Private holdings</h4>
                    {tokens.length === 0 && <p className="muted small">No private tokens yet. Switch a token page to “Private” to buy.</p>}
                    <ul className="holdings">
                      {tokens.map(([m, a]) => (
                        <li key={m}><a href={`/app/t/${m}`}>{short(m)}</a><span>{(Number(a) / 10 ** TOKEN_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></li>
                      ))}
                    </ul>
                    <div className="row">
                      <button className="link" onClick={() => s.refresh()}>Refresh</button>
                      <button className="link" onClick={() => {
                        const b = s.exportBackup();
                        if (!b) return;
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(new Blob([b], { type: "application/json" }));
                        a.download = "patula-shielded-backup.json";
                        a.click();
                      }}>Export encrypted backup</button>
                    </div>
                    <p className="warn">Private notes live only in this browser. Clearing site data without a backup loses access to them. Devnet test SOL only.</p>
                  </section>
                </>
              )}
              {s.busy && <p className="form-msg"><span className="spinner" /> {s.busy}</p>}
              {msg && <p className="form-msg">{msg.text} {msg.sig && <a href={explorer("tx", msg.sig)} target="_blank" rel="noreferrer">View ↗</a>}</p>}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
