// Mainnet initialisation: launchpad config (mainnet-sized curve), pool, lookup
// table, and a proposal to move config authority to the multisig.
// Called by scripts/mainnet/deploy.sh. Env: RPC_URL, DEPLOYER, MULTISIG,
// optional FEE_RECIPIENT, RELAYER (public key that will run the relayer).
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";

const SOL = LAMPORTS_PER_SOL;
const conn = new Connection(process.env.RPC_URL!, "confirmed");
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOYER!, "utf8"))));
const multisig = new PublicKey(process.env.MULTISIG!);
const feeRecipient = new PublicKey(process.env.FEE_RECIPIENT || multisig);

// Mainnet curve: 28 SOL virtual, 1.05B virtual tokens, 800M sold on the curve
// (raises ≈ 89.6 SOL before graduating into the locked pool with 200M tokens).
export const MAINNET_PARAMS = {
  feeRecipient,
  platformFeeBps: 50, // 0.5%
  maxTokenFeeBps: 500, // creators may choose up to 5% per side
  launchFee: new BN(0.02 * SOL),
  virtualSol: new BN(28 * SOL),
  virtualToken: new BN("1050000000000000"),
  curveSupply: new BN("800000000000000"),
  totalSupply: new BN("1000000000000000"),
  maxCreatorBuyBps: 500,
  sniperSlots: new BN(10),
  sniperMaxBps: 100,
};

async function main() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: "confirmed" });
  const lp = new Program(JSON.parse(readFileSync("target/idl/launchpad.json", "utf8")), provider) as any;
  const pool = new Program(JSON.parse(readFileSync("target/idl/patula.json", "utf8")), provider) as any;
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], lp.programId)[0];
  const poolPda = PublicKey.findProgramAddressSync([Buffer.from("pool2")], pool.programId)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault2")], pool.programId)[0];

  if (!(await conn.getAccountInfo(config))) console.log("config:", await lp.methods.initConfig(MAINNET_PARAMS).rpc());
  if (!(await conn.getAccountInfo(poolPda))) {
    console.log("pool:", await pool.methods.initialize().accountsPartial({ pool: poolPda, vault })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc());
  }
  console.log("propose config authority → multisig:", await lp.methods.proposeAuthority(multisig).rpc());

  const authority = new PublicKey(process.env.RELAYER || deployer.publicKey);
  const [create, alt] = AddressLookupTableProgram.createLookupTable({ authority, payer: deployer.publicKey, recentSlot: await conn.getSlot("finalized") });
  const extend = AddressLookupTableProgram.extendLookupTable({
    lookupTable: alt, authority, payer: deployer.publicKey,
    addresses: [poolPda, vault, lp.programId, config, feeRecipient, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, ComputeBudgetProgram.programId],
  });
  if (authority.equals(deployer.publicKey)) {
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: deployer.publicKey, recentBlockhash: blockhash, instructions: [create, extend] }).compileToV0Message());
    tx.sign([deployer]);
    await conn.confirmTransaction(await conn.sendTransaction(tx), "confirmed");
    console.log("ALT_ADDRESS=" + alt.toBase58());
  } else {
    console.log("Create the lookup table from the relayer key with these addresses:", extend.keys.length);
  }
  console.log(`LAUNCHPAD_ID=${lp.programId.toBase58()}\nPROGRAM_ID=${pool.programId.toBase58()}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
