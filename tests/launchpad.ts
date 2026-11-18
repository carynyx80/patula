import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { expect } from "chai";
import { Launchpad } from "../target/types/launchpad";

const SOL = LAMPORTS_PER_SOL;
const TOKEN = 1_000_000; // 6 decimals

describe("launchpad (phase 1, public mode)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.launchpad as Program<Launchpad>;
  const conn = provider.connection;

  const feeRecipient = Keypair.generate().publicKey;
  const creator = Keypair.generate();
  const buyer = Keypair.generate();
  const mint = Keypair.generate();
  const cu: Record<string, number> = {};

  const pda = (seed: string, key?: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), ...(key ? [key.toBuffer()] : [])], program.programId)[0];
  const curvePda = pda("curve", mint.publicKey);
  const vault = getAssociatedTokenAddressSync(mint.publicKey, curvePda, true);

  const CONFIG = {
    feeRecipient,
    tradeFeeBps: 70,
    creatorFeeBps: 30,
    launchFee: new BN(0.02 * SOL),
    virtualSol: new BN(0.25 * SOL), // devnet-sized: graduates after 0.8 SOL
    virtualToken: new BN("1050000000000000"),
    curveSupply: new BN("800000000000000"),
    totalSupply: new BN("1000000000000000"),
    maxCreatorBuyBps: 500, // 5%
    sniperSlots: new BN(10),
    sniperMaxBps: 100, // 1% per trade in the window
  };

  const accounts = (who: Keypair) => ({
    curve: curvePda,
    mint: mint.publicKey,
    curveTokenVault: vault,
    solVault: pda("sol_vault", mint.publicKey),
    feeRecipient,
    creator: creator.publicKey,
  });

  async function buy(who: Keypair, sol: number, minOut = 0, label?: string) {
    const sig = await program.methods
      .buy(new BN(Math.round(sol * SOL)), new BN(minOut))
      .accountsPartial({ ...accounts(who), buyer: who.publicKey })
      .signers([who])
      .rpc({ commitment: "confirmed" });
    if (label) cu[label] = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.computeUnitsConsumed!;
    return sig;
  }
  async function sell(who: Keypair, tokens: BN, label?: string) {
    const sig = await program.methods
      .sell(tokens, new BN(0))
      .accountsPartial({ ...accounts(who), seller: who.publicKey })
      .signers([who])
      .rpc({ commitment: "confirmed" });
    if (label) cu[label] = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.computeUnitsConsumed!;
  }
  const err = async (p: Promise<unknown>) => {
    try { await p; return ""; } catch (e) { return String(e); }
  };
  const tokenBal = async (owner: PublicKey) =>
    Number((await getAccount(conn, getAssociatedTokenAddressSync(mint.publicKey, owner))).amount);

  before(async () => {
    for (const kp of [creator, buyer]) {
      const s = await conn.requestAirdrop(kp.publicKey, 10 * SOL);
      await conn.confirmTransaction(s, "confirmed");
    }
  });

  it("initializes the global config", async () => {
    await program.methods.initConfig(CONFIG).rpc({ commitment: "confirmed" });
    const c = await program.account.config.fetch(pda("config"));
    expect(c.tradeFeeBps).to.eq(70);
  });

  it("creates a token with fixed supply, no mint or freeze authority", async () => {
    const sig = await program.methods
      .createToken("Marigold", "MARI", "https://patula.vercel.app/t/mari.json")
      .accountsPartial({
        payer: creator.publicKey,
        creator: creator.publicKey,
        mint: mint.publicKey,
        curve: curvePda,
        curveTokenVault: vault,
        solVault: pda("sol_vault", mint.publicKey),
        feeRecipient,
      })
      .signers([creator, mint])
      .rpc({ commitment: "confirmed" });
    cu["create token"] = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.computeUnitsConsumed!;
    const m = await getMint(conn, mint.publicKey);
    expect(m.supply.toString()).to.eq(CONFIG.totalSupply.toString());
    expect(m.mintAuthority).to.eq(null);
    expect(m.freezeAuthority).to.eq(null);
    expect((await getAccount(conn, vault)).amount.toString()).to.eq(CONFIG.totalSupply.toString());
    expect(await conn.getBalance(feeRecipient)).to.eq(0.02 * SOL);
  });

  it("anti-sniper window blocks a large first buy but allows a small one", async () => {
    expect(await err(buy(buyer, 0.5))).to.match(/SniperCap|Anti-sniper/);
    await buy(buyer, 0.002);
    expect(await tokenBal(buyer.publicKey)).to.be.greaterThan(0);
  });

  it("caps the creator's own buy at 5% of supply", async () => {
    // wait out the sniper window
    const start = (await program.account.curve.fetch(curvePda)).launchSlot.toNumber();
    while ((await conn.getSlot("confirmed")) < start + 11) await new Promise((r) => setTimeout(r, 400));
    expect(await err(buy(creator, 0.2))).to.match(/CreatorCap|Creator buy cap/);
    await buy(creator, 0.01);
  });

  it("buys with fees to the platform and creator, and respects slippage", async () => {
    const feeBefore = await conn.getBalance(feeRecipient);
    const creatorBefore = await conn.getBalance(creator.publicKey);
    await buy(buyer, 0.1, 0, "buy");
    expect(await conn.getBalance(feeRecipient) - feeBefore).to.eq(0.0007 * SOL);
    expect(await conn.getBalance(creator.publicKey) - creatorBefore).to.eq(0.0003 * SOL);
    expect(await err(buy(buyer, 0.01, Number.MAX_SAFE_INTEGER))).to.match(/Slippage/);
  });

  it("sells back to the curve, never for more than was paid", async () => {
    const tokens = await tokenBal(buyer.publicKey);
    const before = await conn.getBalance(buyer.publicKey);
    await sell(buyer, new BN(Math.floor(tokens / 2)), "sell");
    const got = (await conn.getBalance(buyer.publicKey)) - before;
    expect(got).to.be.greaterThan(0);
    expect(got).to.be.lessThan(0.06 * SOL);
  });

  it("graduates when the curve sells out, then stops trading", async () => {
    await buy(buyer, 5); // clamped to what is left
    const c = await program.account.curve.fetch(curvePda);
    expect(c.complete).to.eq(true);
    expect(c.realToken.toNumber()).to.eq(0);
    expect(c.realSol.toNumber()).to.be.closeTo(0.8 * SOL, 1000);
    expect(await err(buy(buyer, 0.01))).to.match(/CurveComplete|complete/);
    expect(await err(sell(buyer, new BN(TOKEN)))).to.match(/CurveComplete|complete/);
  });

  after(() => {
    console.log("\n=== launchpad compute units ===");
    console.table(cu);
  });
});
