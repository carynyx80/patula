"use client";
// Holders fee: stake tokens, earn SOL from every trade's holder share, claim any time.
import { BN } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useCallback, useEffect, useState } from "react";
import {
  CurveView, explorer, fmtSol, getProgram, LAMPORTS, pct, rewardsPda, stakePositionPda, stakeVaultPda, TOKEN_DECIMALS, TOTAL_SUPPLY,
} from "@/lib/solana";

const ACC_SCALE = 1_000_000_000_000n;
const fmtTok = (b: bigint) => (Number(b) / 10 ** TOKEN_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function StakePanel({ curve, onChange }: { curve: CurveView; onChange: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const mint = new PublicKey(curve.mint);
  const [pos, setPos] = useState<{ amount: bigint; debt: bigint } | null>(null);
  const [walletTokens, setWalletTokens] = useState(0n);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; sig?: string } | null>(null);

  const load = useCallback(async () => {
    if (!wallet.publicKey) return setPos(null);
    const p = await getProgram(connection).account.stakePosition.fetchNullable(stakePositionPda(mint, wallet.publicKey));
    setPos(p ? { amount: BigInt(p.amount.toString()), debt: BigInt(p.rewardDebt.toString()) } : { amount: 0n, debt: 0n });
    try { setWalletTokens((await getAccount(connection, getAssociatedTokenAddressSync(mint, wallet.publicKey))).amount); } catch { setWalletTokens(0n); }
  }, [connection, wallet.publicKey, curve.mint]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, curve.accRewardPerShare]);

  const claimable = pos ? (pos.amount * curve.accRewardPerShare) / ACC_SCALE - pos.debt : 0n;
  const share = curve.totalStaked > 0n && pos ? Number((pos.amount * 10000n) / curve.totalStaked) / 100 : 0;
  const stakedPct = (Number(curve.totalStaked) / 10 ** TOKEN_DECIMALS / TOTAL_SUPPLY) * 100;

  async function act(kind: "stake" | "unstake" | "claim") {
    if (!wallet.publicKey) return setVisible(true);
    setBusy(true);
    setMsg(null);
    try {
      const program = getProgram(connection, wallet);
      const accts = {
        curve: new PublicKey(curve.address), mint, position: stakePositionPda(mint, wallet.publicKey),
        stakeVault: stakeVaultPda(mint), ownerToken: getAssociatedTokenAddressSync(mint, wallet.publicKey),
        rewards: rewardsPda(mint), owner: wallet.publicKey,
      };
      const raw = BigInt(Math.round((parseFloat(amt) || 0) * 10 ** TOKEN_DECIMALS));
      const ix = kind === "claim"
        ? await program.methods.claim().accountsPartial({ curve: accts.curve, mint, position: accts.position, rewards: accts.rewards, owner: wallet.publicKey }).instruction()
        : await program.methods[kind](new BN(raw.toString())).accountsPartial(accts).instruction();
      const sig = await wallet.sendTransaction(new Transaction().add(ix), connection);
      await connection.confirmTransaction(sig, "confirmed");
      setMsg({ text: kind === "claim" ? "Rewards claimed." : kind === "stake" ? "Staked. You now earn the holders fee." : "Unstaked.", sig });
      setAmt("");
      onChange();
      await load();
    } catch (e) {
      const s = String((e as Error)?.message || e);
      setMsg({ text: /StakeTooSmall/.test(s) ? "Stake at least 1 token (or unstake everything)." : /User rejected/i.test(s) ? "Cancelled in wallet." : s.slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }

  const holderFee = curve.fees.holderShareBps > 0 && (curve.fees.buyFeeBps > 0 || curve.fees.sellFeeBps > 0);

  return (
    <div className="card stake-card">
      <div className="feed-head"><span>Stake to earn</span><span>holders fee</span></div>
      {!holderFee ? (
        <p className="muted small" style={{ padding: "14px 4px" }}>This token’s creator set no holders fee, so staking earns nothing here.</p>
      ) : (
        <>
          <p className="muted small" style={{ margin: "12px 4px" }}>
            {pct(curve.fees.holderShareBps)} of the {pct(curve.fees.buyFeeBps)} buy / {pct(curve.fees.sellFeeBps)} sell fee goes to stakers, pro-rata. Unstake any time.
          </p>
          <div className="stake-stats">
            <div><small>Total staked</small><b>{stakedPct.toFixed(2)}%</b><small>of supply</small></div>
            <div><small>Paid to stakers</small><b>{fmtSol(Number(curve.holderRewardsTotal) / LAMPORTS, 6)}</b><small>SOL all-time</small></div>
            <div><small>Your stake</small><b>{pos ? fmtTok(pos.amount) : "—"}</b><small>{share ? `${share}% of pool` : curve.symbol}</small></div>
            <div><small>Claimable</small><b className="grad">{fmtSol(Number(claimable) / LAMPORTS, 6)}</b><small>SOL</small></div>
          </div>
          <div className="stake-row">
            <div className="suffixed">
              <input value={amt} inputMode="decimal" placeholder="Amount" onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span>{curve.symbol}</span>
            </div>
            <button className="btn btn-primary" disabled={busy || !(parseFloat(amt) > 0)} onClick={() => act("stake")}>Stake</button>
            <button className="btn btn-ghost" disabled={busy || !(parseFloat(amt) > 0) || !pos?.amount} onClick={() => act("unstake")}>Unstake</button>
          </div>
          <small className="muted">
            Wallet: {fmtTok(walletTokens)} {curve.symbol}
            {walletTokens > 0n && <button className="link" onClick={() => setAmt((Number(walletTokens) / 10 ** TOKEN_DECIMALS).toString())}>Max</button>}
            {pos && pos.amount > 0n && <button className="link" onClick={() => setAmt((Number(pos.amount) / 10 ** TOKEN_DECIMALS).toString())}>All staked</button>}
          </small>
          <button className="btn btn-ghost big" disabled={busy || claimable <= 0n} onClick={() => act("claim")}>
            {!wallet.publicKey ? "Connect wallet" : `Claim ${fmtSol(Number(claimable) / LAMPORTS, 6)} SOL`}
          </button>
          <p className="muted small">Staking needs a visible wallet, so tokens held in your shielded balance can’t be staked.</p>
        </>
      )}
      {msg && <p className="form-msg">{msg.text} {msg.sig && <a href={explorer("tx", msg.sig)} target="_blank" rel="noreferrer">View ↗</a>}</p>}
    </div>
  );
}
