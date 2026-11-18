"use client";
import { BN } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import TokenAvatar from "@/components/app/TokenAvatar";
import {
  ConfigView, configPda, curvePda, fetchConfig, getProgram, LAMPORTS, solVaultPda, vaultAta,
} from "@/lib/solana";

export default function Create() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const router = useRouter();
  const [cfg, setCfg] = useState<ConfigView | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [preview] = useState(() => Keypair.generate().publicKey.toBase58());

  useEffect(() => { fetchConfig(connection).then(setCfg).catch(() => {}); }, [connection]);

  const valid = name.trim().length > 0 && name.length <= 32 && symbol.trim().length > 0 && symbol.length <= 10 && uri.length <= 200;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet.publicKey) return setVisible(true);
    if (!cfg) return;
    setBusy(true);
    setMsg("Confirm in your wallet…");
    try {
      const program = getProgram(connection, wallet);
      const mint = Keypair.generate();
      const accts = {
        curve: curvePda(mint.publicKey),
        mint: mint.publicKey,
        curveTokenVault: vaultAta(mint.publicKey),
        solVault: solVaultPda(mint.publicKey),
        feeRecipient: cfg.feeRecipient,
      };
      const tx = new Transaction().add(
        await program.methods
          .createToken(name.trim(), symbol.trim().toUpperCase(), uri.trim())
          .accountsPartial({ ...accts, config: configPda(), creator: wallet.publicKey })
          .instruction()
      );
      const buySol = parseFloat(devBuy);
      if (buySol > 0) {
        tx.add(
          await program.methods
            .buy(new BN(Math.round(buySol * LAMPORTS)), new BN(0))
            .accountsPartial({
              ...accts,
              config: configPda(),
              buyer: wallet.publicKey,
              buyerToken: getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey),
              creator: wallet.publicKey,
            })
            .instruction()
        );
      }
      const sig = await wallet.sendTransaction(tx, connection, { signers: [mint] });
      setMsg("Launching…");
      await connection.confirmTransaction(sig, "confirmed");
      router.push(`/app/t/${mint.publicKey.toBase58()}?launched=1`);
    } catch (err) {
      const s = String((err as Error)?.message || err);
      setMsg(/Anti-sniper|SniperCap/.test(s) ? "Your first buy is too big for the anti-sniper window (max 1% of supply per trade). Lower it."
        : /CreatorCap/.test(s) ? "Creators can buy at most 5% of supply."
        : /User rejected/i.test(s) ? "Cancelled in wallet." : s.slice(0, 220));
      setBusy(false);
    }
  }

  return (
    <div className="create-grid">
      <form className="card create-form" onSubmit={submit}>
        <span className="eyebrow">Launch a token</span>
        <h1 style={{ marginTop: 12 }}>Make it <span className="serif grad" style={{ fontStyle: "italic" }}>bloom</span>.</h1>
        <label>Name<input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Marigold" required /></label>
        <label>Ticker<input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="MARI" required /></label>
        <label>Image URL <small>optional · direct https link to a png, jpg, gif or webp</small>
          <input value={uri} maxLength={200} onChange={(e) => setUri(e.target.value)} placeholder="https://…/logo.png" />
        </label>
        <label>First buy <small>optional · SOL, max 1% of supply during the first ~4 seconds</small>
          <input value={devBuy} inputMode="decimal" onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
        </label>
        <div className="visibility">
          <div><b>Visibility</b><small>Public: your wallet is shown as creator.</small></div>
          <div className="toggle sm" aria-disabled>
            <button type="button" className="active">Public</button>
            <button type="button" disabled title="Arrives in Phase 1b">Private · soon</button>
          </div>
        </div>
        <button className="btn btn-primary big" disabled={!valid || busy}>
          {!wallet.publicKey ? "Connect wallet" : busy ? "Launching…" : `Launch · ${cfg ? Number(cfg.launchFee) / LAMPORTS : "…"} SOL fee`}
        </button>
        {msg && <p className="form-msg">{msg}</p>}
      </form>

      <aside className="card create-preview">
        <small className="muted">Preview</small>
        <div className="tc-top" style={{ marginTop: 14 }}>
          <TokenAvatar seed={preview} uri={uri} size={64} />
          <div>
            <h3 style={{ fontSize: 26 }}>{name || "Your token"}</h3>
            <small>${symbol || "TICKER"}</small>
          </div>
        </div>
        <ul className="checks">
          <li>1,000,000,000 fixed supply, minting revoked at launch</li>
          <li>No freeze authority: nobody can lock holders’ tokens</li>
          <li>Curve SOL held by the program; no withdraw instruction</li>
          <li>Creator wallet capped at 5% of supply</li>
          <li>Anti-sniper: max 1% per trade in the first 10 slots</li>
          <li>Fees: 0.7% platform, 0.3% to you on every trade</li>
        </ul>
      </aside>
    </div>
  );
}
