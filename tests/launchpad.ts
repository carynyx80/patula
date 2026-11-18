import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { expect } from "chai";
import { Launchpad } from "../target/types/launchpad";

const SOL = LAMPORTS_PER_SOL;
const TOKEN = 1_000_000;
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

describe("launchpad v2: fees, staking, pool graduation, admin", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.launchpad as Program<Launchpad>;
  const conn = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const feeRecipient = Keypair.generate().publicKey;
  const creator = Keypair.generate();
  const buyer = Keypair.generate();
  const staker = Keypair.generate();
  const mint = Keypair.generate();
  const cu: Record<string, number> = {};

  const pda = (seed: string, ...keys: PublicKey[]) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map((k) => k.toBuffer())], program.programId)[0];
  const curvePda = pda("curve", mint.publicKey);
  const vault = getAssociatedTokenAddressSync(mint.publicKey, curvePda, true);
  const rewards = pda("rewards", mint.publicKey);
  const FEES = { buyFeeBps: 200, sellFeeBps: 300, holderShareBps: 5000 }; // 2% buy, 3% sell, half to stakers

  const PARAMS = {
    feeRecipient,
    platformFeeBps: 50, // 0.5%
    maxTokenFeeBps: 1000, // creators may choose up to 10% per side
    launchFee: new BN(0.02 * SOL),
    virtualSol: new BN(0.25 * SOL),
    virtualToken: new BN("1050000000000000"),
    curveSupply: new BN("800000000000000"),
    totalSupply: new BN("1000000000000000"),
    maxCreatorBuyBps: 500,
    sniperSlots: new BN(10),
    sniperMaxBps: 100,
  };

  const tradeAccts = () => ({
    curve: curvePda, mint: mint.publicKey, curveTokenVault: vault, solVault: pda("sol_vault", mint.publicKey),
    rewards, feeRecipient, creator: creator.publicKey,
  });
  const txCu = async (sig: string) =>
    (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.computeUnitsConsumed!;

  async function buy(who: Keypair, sol: number, label?: string, minOut = 0) {
    const sig = await program.methods.buy(new BN(Math.round(sol * SOL)), new BN(minOut))
      .accountsPartial({ ...tradeAccts(), buyer: who.publicKey }).signers([who]).rpc({ commitment: "confirmed" });
    if (label) cu[label] = await txCu(sig);
  }
  async function sell(who: Keypair, tokens: BN | number, label?: string) {
    const sig = await program.methods.sell(new BN(tokens.toString()), new BN(0))
      .accountsPartial({ ...tradeAccts(), seller: who.publicKey }).signers([who]).rpc({ commitment: "confirmed" });
    if (label) cu[label] = await txCu(sig);
  }
  const stakeAccts = (who: Keypair) => ({
    curve: curvePda, mint: mint.publicKey, position: pda("stake", mint.publicKey, who.publicKey),
    stakeVault: pda("stake_vault", mint.publicKey), ownerToken: getAssociatedTokenAddressSync(mint.publicKey, who.publicKey),
    rewards, owner: who.publicKey,
  });
  const err = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { return String(e); } };
  const tokenBal = async (owner: PublicKey) => Number((await getAccount(conn, getAssociatedTokenAddressSync(mint.publicKey, owner))).amount);
  const curve = () => program.account.curve.fetch(curvePda);

  before(async () => {
    for (const kp of [creator, buyer, staker]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * SOL), "confirmed");
    }
  });

  it("initializes config and enforces hard caps", async () => {
    await program.methods.initConfig(PARAMS).rpc({ commitment: "confirmed" });
    expect(await err(program.methods.updateConfig({ ...PARAMS, platformFeeBps: 300 }).rpc())).to.match(/FeeTooHigh/);
    expect(await err(program.methods.updateConfig({ ...PARAMS, maxTokenFeeBps: 2000 }).rpc())).to.match(/FeeTooHigh/);
  });

  it("rejects admin calls from anyone but the authority", async () => {
    expect(await err(program.methods.setPaused(true).accountsPartial({ authority: buyer.publicKey }).signers([buyer]).rpc())).to.match(/Unauthorized|ConstraintHasOne|2001/);
  });

  it("rejects a launch with fees above the cap", async () => {
    const m = Keypair.generate();
    const c = pda("curve", m.publicKey);
    const r = await err(program.methods.createToken("Bad", "BAD", "", { buyFeeBps: 1500, sellFeeBps: 0, holderShareBps: 0 })
      .accountsPartial({ payer: creator.publicKey, creator: creator.publicKey, mint: m.publicKey, curve: c, curveTokenVault: getAssociatedTokenAddressSync(m.publicKey, c, true), feeRecipient })
      .signers([creator, m]).rpc());
    expect(r).to.match(/FeeTooHigh/);
  });

  it("creates a token: fixed supply, revoked authorities, metadata, creator fees locked in", async () => {
    const sig = await program.methods.createToken("Marigold", "MARI", "https://patula.vercel.app/t/mari.json", FEES)
      .accountsPartial({ payer: creator.publicKey, creator: creator.publicKey, mint: mint.publicKey, curve: curvePda, curveTokenVault: vault, feeRecipient })
      .signers([creator, mint]).rpc({ commitment: "confirmed" });
    cu["create token"] = await txCu(sig);
    const m = await getMint(conn, mint.publicKey);
    expect(m.supply.toString()).to.eq(PARAMS.totalSupply.toString());
    expect(m.mintAuthority).to.eq(null);
    expect(m.freezeAuthority).to.eq(null);
    const [md] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL.toBuffer(), mint.publicKey.toBuffer()], MPL);
    expect((await conn.getAccountInfo(md))!.data.toString()).to.include("Marigold");
    const c = await curve();
    expect(c.fees.buyFeeBps).to.eq(200);
    expect(c.fees.sellFeeBps).to.eq(300);
    expect(c.fees.holderShareBps).to.eq(5000);
  });

  it("anti-sniper window and creator cap still apply", async () => {
    expect(await err(buy(buyer, 0.5))).to.match(/SniperCap/);
    await buy(buyer, 0.002);
    const start = (await curve()).launchSlot.toNumber();
    while ((await conn.getSlot("confirmed")) < start + 11) await new Promise((r) => setTimeout(r, 400));
    expect(await err(buy(creator, 0.2))).to.match(/CreatorCap/);
  });

  it("splits a buy fee exactly: platform, creator and holders", async () => {
    const before = await Promise.all([conn.getBalance(feeRecipient), conn.getBalance(creator.publicKey), conn.getBalance(rewards)]);
    await buy(buyer, 0.1, "buy");
    const after = await Promise.all([conn.getBalance(feeRecipient), conn.getBalance(creator.publicKey), conn.getBalance(rewards)]);
    // 0.1 SOL × (0.5% platform + 2% buy fee) = 0.0025; buy fee split 50/50
    expect(after[0] - before[0]).to.eq(0.0005 * SOL);
    expect(after[1] - before[1]).to.eq(0.001 * SOL);
    expect(after[2] - before[2]).to.eq(0.001 * SOL);
  });

  it("stakers earn the holders fee pro-rata and can claim it", async () => {
    await buy(staker, 0.05);
    const bal = await tokenBal(staker.publicKey);
    expect(await err(program.methods.stake(new BN(TOKEN / 2)).accountsPartial(stakeAccts(staker)).signers([staker]).rpc())).to.match(/StakeTooSmall/);
    let sig = await program.methods.stake(new BN(bal)).accountsPartial(stakeAccts(staker)).signers([staker]).rpc({ commitment: "confirmed" });
    cu["stake"] = await txCu(sig);
    expect((await curve()).totalStaked.toNumber()).to.eq(bal);

    // fees collected while nobody was staked are distributed on the next trade
    const pendingBefore = (await curve()).pendingRewards.toNumber();
    await buy(buyer, 0.1); // holders fee 0.001 SOL
    expect((await curve()).accRewardPerShare.toString()).to.not.eq("0");

    const before = await conn.getBalance(staker.publicKey);
    sig = await program.methods.claim().accountsPartial({ curve: curvePda, mint: mint.publicKey, position: pda("stake", mint.publicKey, staker.publicKey), rewards, owner: staker.publicKey })
      .signers([staker]).rpc({ commitment: "confirmed" });
    cu["claim"] = await txCu(sig);
    const got = (await conn.getBalance(staker.publicKey)) - before; // fee payer is the provider wallet
    expect(got).to.be.closeTo(pendingBefore + 0.001 * SOL, 10); // sole staker gets it all, minus rounding dust
  });

  it("sells pay the sell fee, also into the holders pool", async () => {
    const r0 = await conn.getBalance(rewards);
    const tokens = await tokenBal(buyer.publicKey);
    await sell(buyer, Math.floor(tokens / 4), "sell");
    expect((await conn.getBalance(rewards)) - r0).to.be.greaterThan(0);
  });

  it("pause stops buys and launches, never sells or unstaking", async () => {
    await program.methods.setPaused(true).rpc({ commitment: "confirmed" });
    expect(await err(buy(buyer, 0.01))).to.match(/Paused/);
    await sell(buyer, 10 * TOKEN);
    const pos = await program.account.stakePosition.fetch(pda("stake", mint.publicKey, staker.publicKey));
    await program.methods.unstake(pos.amount).accountsPartial(stakeAccts(staker)).signers([staker]).rpc({ commitment: "confirmed" });
    expect((await curve()).totalStaked.toNumber()).to.eq(0);
    await program.methods.setPaused(false).rpc({ commitment: "confirmed" });
  });

  it("graduates into a locked pool when the curve sells out, and keeps trading", async () => {
    await buy(buyer, 5); // clamps to what's left on the curve
    let c = await curve();
    expect(c.graduated).to.eq(true);
    expect(c.realToken.toNumber()).to.eq(0);
    expect(c.ammToken.toString()).to.eq("200000000000000"); // the reserved 200M tokens
    const px = Number(c.ammSol) / Number(c.ammToken);
    await buy(buyer, 0.05, "pool buy");
    await sell(buyer, 1_000_000 * TOKEN, "pool sell");
    c = await curve();
    expect(c.graduated).to.eq(true);
    expect(Number(c.ammSol) / Number(c.ammToken)).to.be.closeTo(px, px * 0.5);
  });

  it("hands authority over in two steps", async () => {
    const next = Keypair.generate();
    await program.methods.proposeAuthority(next.publicKey).rpc({ commitment: "confirmed" });
    expect(await err(program.methods.acceptAuthority().accountsPartial({ newAuthority: buyer.publicKey }).signers([buyer]).rpc())).to.match(/Unauthorized/);
    await program.methods.acceptAuthority().accountsPartial({ newAuthority: next.publicKey }).signers([next]).rpc({ commitment: "confirmed" });
    expect((await program.account.config.fetch(pda("config"))).authority.toBase58()).to.eq(next.publicKey.toBase58());
    await program.methods.proposeAuthority(admin.publicKey).accountsPartial({ authority: next.publicKey }).signers([next]).rpc({ commitment: "confirmed" });
    await program.methods.acceptAuthority().accountsPartial({ newAuthority: admin.publicKey }).rpc({ commitment: "confirmed" });
  });

  after(() => {
    console.log("\n=== launchpad v2 compute units ===");
    console.table(cu);
  });
});
