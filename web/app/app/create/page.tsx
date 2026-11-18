"use client";
import { BN } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import TokenAvatar from "@/components/app/TokenAvatar";
import Socials, { LABELS, SocialIcon } from "@/components/app/Socials";
import { useShielded } from "@/components/app/ShieldedProvider";
import { normalizeLink, prepareImage, uploadMeta } from "@/lib/meta";
import {
  ConfigView, configPda, curvePda, CurveView, fetchConfig, getProgram, LAMPORTS, quoteBuy, solVaultPda, TOKEN_DECIMALS,
  TOTAL_SUPPLY, vaultAta,
} from "@/lib/solana";

type LinkKind = keyof typeof LABELS;
const LINK_PLACEHOLDER: Record<LinkKind, string> = {
  website: "https://yourtoken.xyz",
  twitter: "@handle or x.com/handle",
  telegram: "t.me/yourgroup",
  discord: "discord.gg/invite",
};
// account sizes created at launch: mint, curve, curve token vault, SOL vault, Metaplex metadata
const LAUNCH_ACCOUNT_SIZES = [82, 376, 165, 0, 679];

function Dropzone({ label, hint, aspect, value, onFile, error }: {
  label: string; hint: string; aspect: "square" | "banner"; value?: string; onFile: (f: File) => void; error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="field">
      {label && <span className="field-label">{label}</span>}
      <button
        type="button"
        className={`dropzone ${aspect} ${over ? "over" : ""} ${value ? "filled" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {value ? <img src={value} alt="" /> : (
          <span className="dz-empty">
            <span className="dz-plus">+</span>
            <b>Drop or click to upload</b>
            <small>{hint}</small>
          </span>
        )}
      </button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      {error && <small className="field-err">{error}</small>}
    </div>
  );
}

export default function Create() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const router = useRouter();
  const shielded = useShielded();

  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [rentSol, setRentSol] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<string>();
  const [banner, setBanner] = useState<string>();
  const [imgErr, setImgErr] = useState<{ image?: string; banner?: string }>({});
  const [links, setLinks] = useState<Record<LinkKind, string>>({ website: "", twitter: "", telegram: "", discord: "" });
  const [showLinks, setShowLinks] = useState(true);
  const [priv, setPriv] = useState(false);
  const [devBuy, setDevBuy] = useState("");
  const [review, setReview] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [previewSeed] = useState(() => Keypair.generate().publicKey.toBase58());

  useEffect(() => {
    fetchConfig(connection).then(setCfg).catch(() => {});
    Promise.all(LAUNCH_ACCOUNT_SIZES.map((n) => connection.getMinimumBalanceForRentExemption(n)))
      .then((v) => setRentSol(v.reduce((a, b) => a + b, 0) / LAMPORTS)).catch(() => {});
  }, [connection]);

  const linkState = useMemo(() => Object.fromEntries(
    (Object.keys(links) as LinkKind[]).map((k) => [k, normalizeLink(k, links[k])])
  ) as Record<LinkKind, { value?: string; error?: string }>, [links]);

  // First-buy quote against a fresh curve
  const buySol = priv ? 0 : parseFloat(devBuy) || 0;
  const firstBuy = useMemo(() => {
    if (!cfg || buySol <= 0) return null;
    const fresh = { virtualSol: cfg.virtualSol, virtualToken: cfg.virtualToken, realToken: cfg.curveSupply } as CurveView;
    const tokens = quoteBuy(fresh, cfg, BigInt(Math.round(buySol * LAMPORTS))).tokensOut;
    const pct = (Number(tokens) / 10 ** TOKEN_DECIMALS / TOTAL_SUPPLY) * 100;
    const cap = Math.min(cfg.sniperMaxBps, cfg.maxCreatorBuyBps) / 100;
    return { tokens, pct, cap, over: pct > cap };
  }, [cfg, buySol]);

  const errors = {
    name: !name.trim() ? "Required" : name.length > 32 ? "Max 32 characters" : "",
    symbol: !symbol ? "Required" : !/^[A-Z0-9]{1,10}$/.test(symbol) ? "1-10 letters or digits" : "",
    description: description.length > 500 ? "Max 500 characters" : "",
    image: !image ? "Add an image" : "",
    links: Object.values(linkState).some((l) => l.error),
    buy: !!firstBuy?.over,
  };
  const valid = !errors.name && !errors.symbol && !errors.description && !errors.image && !errors.links && !errors.buy;

  async function onImage(kind: "image" | "banner", f: File) {
    setImgErr((e) => ({ ...e, [kind]: undefined }));
    try {
      const url = kind === "image" ? await prepareImage(f, 512, 512, 1_500_000) : await prepareImage(f, 1500, 500, 2_500_000);
      if (kind === "image") setImage(url); else setBanner(url);
    } catch (e) {
      setImgErr((x) => ({ ...x, [kind]: String((e as Error).message) }));
    }
  }

  async function launch() {
    if (!wallet.publicKey) return setVisible(true);
    if (!cfg || !valid || !image) return;
    setMsg("");
    try {
      setBusy("Uploading image and metadata…");
      const { uri } = await uploadMeta({
        name: name.trim(), symbol, description: description.trim(), image, banner,
        website: linkState.website.value, twitter: linkState.twitter.value, telegram: linkState.telegram.value, discord: linkState.discord.value,
      });

      if (priv) {
        if (!shielded.unlocked) { setBusy("Unlock your shielded balance in your wallet…"); await shielded.unlock(); }
        const { mint } = await shielded.launch(name.trim(), symbol, uri);
        router.push(`/app/t/${mint}?launched=1`);
        return;
      }

      setBusy("Confirm in your wallet…");
      const program = getProgram(connection, wallet);
      const mint = Keypair.generate();
      const accts = {
        config: configPda(), curve: curvePda(mint.publicKey), mint: mint.publicKey,
        curveTokenVault: vaultAta(mint.publicKey), solVault: solVaultPda(mint.publicKey), feeRecipient: cfg.feeRecipient,
      };
      const tx = new Transaction().add(
        await program.methods.createToken(name.trim(), symbol, uri)
          .accountsPartial({ ...accts, payer: wallet.publicKey, creator: wallet.publicKey }).instruction()
      );
      if (buySol > 0) {
        tx.add(await program.methods.buy(new BN(Math.round(buySol * LAMPORTS)), new BN(0))
          .accountsPartial({ ...accts, buyer: wallet.publicKey, buyerToken: getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey), creator: wallet.publicKey })
          .instruction());
      }
      const sig = await wallet.sendTransaction(tx, connection, { signers: [mint] });
      setBusy("Launching…");
      await connection.confirmTransaction(sig, "confirmed");
      router.push(`/app/t/${mint.publicKey.toBase58()}?launched=1`);
    } catch (err) {
      const s = String((err as Error)?.message || err);
      setMsg(/SniperCap|Anti-sniper/.test(s) ? "First buy too big for the anti-sniper window. Lower it."
        : /CreatorCap/.test(s) ? "Creators can buy at most 5% of supply."
        : /User rejected/i.test(s) ? "Cancelled in wallet."
        : /insufficient|0x1\b/i.test(s) ? "Not enough SOL. Get devnet SOL at faucet.solana.com."
        : s.slice(0, 240));
      setBusy("");
    }
  }

  const launchFee = cfg ? Number(cfg.launchFee) / LAMPORTS : 0;
  const total = (priv ? 0 : launchFee + (rentSol ?? 0)) + buySol;
  const previewLinks = Object.fromEntries((Object.keys(linkState) as LinkKind[]).map((k) => [k, linkState[k].value]).filter(([, v]) => v));
  const curvePct = firstBuy && cfg ? (Number(firstBuy.tokens) / Number(cfg.curveSupply)) * 100 : 0;

  return (
    <>
      <div className="app-hero">
        <div>
          <span className="eyebrow">Launch a token</span>
          <h1>Make it <span className="serif grad" style={{ fontStyle: "italic" }}>bloom</span>.</h1>
          <p>Everything here goes into your token’s permanent on-chain metadata. It can’t be edited after launch.</p>
        </div>
      </div>

      <div className="launch-grid">
        <form className="launch-form" onSubmit={(e) => { e.preventDefault(); if (!wallet.publicKey) return setVisible(true); if (valid) { setAck(false); setReview(true); } }}>
          <section className="card launch-sec">
            <div className="sec-head"><span className="sec-num">01</span><h3>Token details</h3></div>
            <div className="identity">
              <Dropzone label="Image *" hint="PNG, JPG, WebP or GIF · square works best" aspect="square" value={image} onFile={(f) => onImage("image", f)} error={imgErr.image} />
              <div className="identity-fields">
                <label className="field">
                  <span className="field-label">Name * <small>{name.length}/32</small></span>
                  <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Marigold" />
                </label>
                <label className="field">
                  <span className="field-label">Ticker * <small>{symbol.length}/10</small></span>
                  <div className="prefixed"><span>$</span>
                    <input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="MARI" />
                  </div>
                </label>
              </div>
            </div>
            <label className="field">
              <span className="field-label">Description <small>{description.length}/500</small></span>
              <textarea value={description} maxLength={500} rows={4} onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this token about? Tell people why they should care." />
            </label>
          </section>

          <section className="card launch-sec">
            <button type="button" className="sec-head toggle-head" onClick={() => setShowLinks((v) => !v)}>
              <span className="sec-num">02</span><h3>Social links <small className="muted">optional</small></h3>
              <span className="chev">{showLinks ? "−" : "+"}</span>
            </button>
            <AnimatePresence initial={false}>
              {showLinks && (
                <motion.div className="links-grid" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                  {(Object.keys(LABELS) as LinkKind[]).map((k) => (
                    <label className="field" key={k}>
                      <span className="field-label"><SocialIcon kind={k} /> {LABELS[k]}</span>
                      <input value={links[k]} onChange={(e) => setLinks((l) => ({ ...l, [k]: e.target.value }))} placeholder={LINK_PLACEHOLDER[k]} />
                      {linkState[k].error && <small className="field-err">{linkState[k].error}</small>}
                    </label>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          <section className="card launch-sec">
            <div className="sec-head"><span className="sec-num">03</span><h3>Banner <small className="muted">optional</small></h3></div>
            <Dropzone label="" hint="Shown at the top of your token page · 3:1, at least 1500×500" aspect="banner" value={banner} onFile={(f) => onImage("banner", f)} error={imgErr.banner} />
            {banner && <button type="button" className="link" onClick={() => setBanner(undefined)}>Remove banner</button>}
          </section>

          <section className="card launch-sec">
            <div className="sec-head"><span className="sec-num">04</span><h3>Launch settings</h3></div>
            <div className="visibility">
              <div><b>Creator visibility</b><small>{priv
                ? "Private: the relayer launches it and a fresh, unlinked key is recorded as creator. Creator fees go to that key, kept in your encrypted shielded backup."
                : "Public: your wallet is shown as the creator and receives creator fees."}</small></div>
              <div className="toggle sm">
                <button type="button" className={!priv ? "active" : ""} onClick={() => setPriv(false)}>Public</button>
                <button type="button" className={priv ? "active" : ""} onClick={() => setPriv(true)}>◉ Private</button>
              </div>
            </div>
            {!priv ? (
              <div className="field">
                <span className="field-label">First buy <small>optional · bundled with the launch so nobody buys before you</small></span>
                <div className="suffixed">
                  <input value={devBuy} inputMode="decimal" onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
                  <span>SOL</span>
                </div>
                <div className="quick">
                  {["0.001", "0.002", "0.003"].map((q) => <button type="button" key={q} onClick={() => setDevBuy(q)}>{q} SOL</button>)}
                </div>
                {firstBuy && (
                  <small className={firstBuy.over ? "field-err" : "muted"}>
                    ≈ {(Number(firstBuy.tokens) / 10 ** TOKEN_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol || "tokens"} · {firstBuy.pct.toFixed(2)}% of supply
                    {firstBuy.over && ` — max ${firstBuy.cap}% per trade during the anti-sniper window`}
                  </small>
                )}
              </div>
            ) : (
              <p className="muted small">Want a stake in your own token? After launch, switch the token page to Private and buy from your shielded balance, so that purchase isn’t linked to you either.</p>
            )}
          </section>

          <button className="btn btn-primary big" disabled={!!busy || (!!wallet.publicKey && !valid)}>
            {!wallet.publicKey ? "Connect wallet" : "Review launch"}
          </button>
          {!valid && wallet.publicKey && (errors.image || errors.name || errors.symbol) && (
            <small className="muted">Still needed: {[errors.image && "image", errors.name && "name", errors.symbol && "ticker"].filter(Boolean).join(", ")}</small>
          )}
        </form>

        <aside className="launch-preview">
          <small className="muted">Live preview</small>
          <div className="card preview-page">
            <div className="pv-banner">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {banner ? <img src={banner} alt="" /> : <div className="pv-banner-empty" />}
            </div>
            <div className="pv-body">
              <div className="pv-avatar"><TokenAvatar seed={previewSeed} src={image} size={72} /></div>
              <h3>{name || "Your token"} <span className="muted">${symbol || "TICKER"}</span></h3>
              <small className="muted">{priv ? "◉ Anonymous creator" : wallet.publicKey ? `by ${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}` : "by your wallet"}</small>
              <p className="pv-desc">{description || "Your description appears here."}</p>
              <Socials links={previewLinks} />
              <div className="progress"><span style={{ width: `${Math.min(100, curvePct)}%` }} /></div>
              <small className="muted">{curvePct.toFixed(2)}% to graduation</small>
            </div>
          </div>
          <ul className="checks">
            <li>1,000,000,000 fixed supply, minting revoked at launch</li>
            <li>No freeze authority: nobody can lock holders’ tokens</li>
            <li>Curve SOL held by the program; no withdraw instruction</li>
            <li>Creator wallet capped at 5% of supply</li>
            <li>Name, ticker and image stored as immutable on-chain metadata</li>
            <li>Fees: 0.7% platform · 0.3% creator on every trade</li>
          </ul>
        </aside>
      </div>

      <AnimatePresence>
        {review && (
          <>
            <motion.div className="drawer-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !busy && setReview(false)} />
            <motion.div className="modal card" role="dialog" aria-label="Review launch" initial={{ opacity: 0, y: 30, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20 }}>
              <div className="modal-head">
                <TokenAvatar seed={previewSeed} src={image} size={56} />
                <div><h3>{name} <span className="muted">${symbol}</span></h3><small className="muted">{priv ? "Anonymous launch via relayer" : "Public launch from your wallet"}</small></div>
              </div>
              <dl className="summary">
                {description && <><dt>Description</dt><dd>{description.length > 140 ? description.slice(0, 140) + "…" : description}</dd></>}
                <dt>Links</dt><dd>{Object.keys(previewLinks).length ? <Socials links={previewLinks} /> : <span className="muted">None</span>}</dd>
                <dt>Banner</dt><dd>{banner ? "Yes" : <span className="muted">None</span>}</dd>
                <dt>Supply</dt><dd>1,000,000,000 · {TOKEN_DECIMALS} decimals</dd>
              </dl>
              <div className="costs">
                {priv ? (
                  <div className="cost-row"><span>Launch fee + rent</span><span>Paid by relayer (devnet)</span></div>
                ) : (
                  <>
                    <div className="cost-row"><span>Launch fee</span><span>{launchFee} SOL</span></div>
                    <div className="cost-row"><span>Account rent (mint, curve, vaults, metadata)</span><span>{rentSol ? rentSol.toFixed(4) : "…"} SOL</span></div>
                  </>
                )}
                {buySol > 0 && <div className="cost-row"><span>First buy</span><span>{buySol} SOL</span></div>}
                <div className="cost-row total"><span>Total</span><span>≈ {total.toFixed(4)} SOL</span></div>
              </div>
              <label className="ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand the name, ticker, image and links can’t be changed after launch.</span>
              </label>
              <div className="modal-actions">
                <button className="btn btn-ghost" disabled={!!busy} onClick={() => setReview(false)}>Back</button>
                <button className="btn btn-primary" disabled={!ack || !!busy} onClick={launch}>
                  {busy ? <><span className="spinner" /> {shielded.busy || busy}</> : "Launch token"}
                </button>
              </div>
              {msg && <p className="form-msg">{msg}</p>}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
