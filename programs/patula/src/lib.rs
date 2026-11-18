//! Patula shielded pool v2 (Phase 1b): multi-asset notes and private trading.
//!
//! Notes hold SOL or a launchpad token. Every instruction spends 2 notes and
//! creates 2, proven with one Groth16 proof (circuits/spend.circom):
//! - `transact`      SOL deposit / private transfer / withdrawal
//! - `private_buy`   SOL notes -> exact token amount, bought on the launchpad
//!                   with the pool vault as buyer (no user wallet appears)
//! - `private_sell`  token notes -> SOL, sold on the launchpad by the pool
//!
//! Proofs fix amounts in advance, so trades use limits: a buy pays at most
//! `max_sol`, a sell receives at least `min_sol`. Any price improvement over
//! the limit goes to the relayer that submitted the trade.
//!
//! NOT AUDITED. DEV TRUSTED SETUP. Devnet only.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use groth16_solana::groth16::Groth16Verifier;
use launchpad::program::Launchpad;
use solana_poseidon::{Endianness, Parameters};
use solana_sha256_hasher::hashv;

mod verifying_key;
use verifying_key::{NR_PUBLIC_INPUTS, VERIFYING_KEY};

declare_id!("GVrC5uW3cXm3JReHtG7R1zmJ8Sf1Zx6PHr1Hnt9Ld8GV");

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: usize = 32;
/// Compliance decision: no KYC, capped deposits (100 SOL per transaction).
pub const MAX_DEPOSIT_LAMPORTS: i64 = 100_000_000_000;
pub const POOL_SEED: &[u8] = b"pool2";
pub const VAULT_SEED: &[u8] = b"vault2";

/// BN254 scalar field modulus, big-endian.
const FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[program]
pub mod patula {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mut pool = ctx.accounts.pool.load_init()?;
        let mut zero = [0u8; 32];
        for i in 0..LEVELS {
            pool.zeros[i] = zero;
            pool.filled_subtrees[i] = zero;
            zero = poseidon2(&zero, &zero)?;
        }
        pool.roots[0] = zero;
        drop(pool);
        let rent = Rent::get()?.minimum_balance(0);
        pay(&ctx.accounts.system_program, &ctx.accounts.payer.to_account_info(), &ctx.accounts.vault.to_account_info(), rent, None)
    }

    /// SOL deposit (ext_amount > 0), private transfer (= 0) or withdrawal (< 0).
    pub fn transact(ctx: Context<Transact>, proof: Proof, ext_amount: i64, fee: u64) -> Result<()> {
        require!(ext_amount <= MAX_DEPOSIT_LAMPORTS && ext_amount > i64::MIN, PatulaError::InvalidAmount);
        let ext_hash = ext_data_hash(&[
            &[0u8],
            ctx.accounts.recipient.key.as_ref(),
            ctx.accounts.signer.key.as_ref(),
            &ext_amount.to_le_bytes(),
            &fee.to_le_bytes(),
        ]);
        verify_and_record(
            &ctx.accounts.pool,
            &proof,
            field(ext_amount as i128 - fee as i128),
            [0u8; 32],
            [0u8; 32],
            ext_hash,
        )?;

        let sys = &ctx.accounts.system_program;
        let vault = ctx.accounts.vault.to_account_info();
        let seeds: &[&[u8]] = &[VAULT_SEED, &[ctx.bumps.vault]];
        if ext_amount > 0 {
            pay(sys, &ctx.accounts.signer.to_account_info(), &vault, ext_amount as u64, None)?;
        } else if ext_amount < 0 {
            pay(sys, &vault, &ctx.accounts.recipient.to_account_info(), ext_amount.unsigned_abs(), Some(seeds))?;
        }
        if fee > 0 {
            pay(sys, &vault, &ctx.accounts.signer.to_account_info(), fee, Some(seeds))?;
        }
        Ok(())
    }

    /// Spend SOL notes to buy exactly `tokens_out`, paying at most `max_sol`.
    /// The proof creates the token note(s) and any SOL change.
    pub fn private_buy(ctx: Context<PrivateTrade>, proof: Proof, tokens_out: u64, max_sol: u64, fee: u64) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let ext_hash = ext_data_hash(&[
            &[1u8],
            mint.as_ref(),
            ctx.accounts.relayer.key.as_ref(),
            &tokens_out.to_le_bytes(),
            &max_sol.to_le_bytes(),
            &fee.to_le_bytes(),
        ]);
        verify_and_record(
            &ctx.accounts.pool,
            &proof,
            field(-(max_sol as i128) - fee as i128),
            field(tokens_out as i128),
            mint_field(&mint),
            ext_hash,
        )?;

        let before = ctx.accounts.vault.lamports();
        let seeds: &[&[u8]] = &[VAULT_SEED, &[ctx.bumps.vault]];
        launchpad::cpi::buy_exact_out(ctx.accounts.launchpad_ctx(seeds_ref(&seeds)), tokens_out, max_sol)?;
        let spent = before - ctx.accounts.vault.lamports();
        require!(spent <= max_sol, PatulaError::LimitExceeded);

        let tip = (max_sol - spent) + fee;
        if tip > 0 {
            pay(&ctx.accounts.system_program, &ctx.accounts.vault.to_account_info(), &ctx.accounts.relayer.to_account_info(), tip, Some(seeds))?;
        }
        emit!(PrivateTradeEvent { mint, is_buy: true, sol: spent, tokens: tokens_out });
        Ok(())
    }

    /// Spend token notes to sell `tokens_in` for at least `min_sol`.
    /// The proof creates the SOL note (min_sol - fee) and any token change.
    pub fn private_sell(ctx: Context<PrivateTrade>, proof: Proof, tokens_in: u64, min_sol: u64, fee: u64) -> Result<()> {
        require!(min_sol >= fee, PatulaError::InvalidAmount);
        let mint = ctx.accounts.mint.key();
        let ext_hash = ext_data_hash(&[
            &[2u8],
            mint.as_ref(),
            ctx.accounts.relayer.key.as_ref(),
            &tokens_in.to_le_bytes(),
            &min_sol.to_le_bytes(),
            &fee.to_le_bytes(),
        ]);
        verify_and_record(
            &ctx.accounts.pool,
            &proof,
            field(min_sol as i128 - fee as i128),
            field(-(tokens_in as i128)),
            mint_field(&mint),
            ext_hash,
        )?;

        let before = ctx.accounts.vault.lamports();
        let seeds: &[&[u8]] = &[VAULT_SEED, &[ctx.bumps.vault]];
        launchpad::cpi::sell(ctx.accounts.launchpad_sell_ctx(seeds_ref(&seeds)), tokens_in, min_sol)?;
        let received = ctx.accounts.vault.lamports() - before;
        require!(received >= min_sol, PatulaError::LimitExceeded);

        let tip = (received - min_sol) + fee;
        if tip > 0 {
            pay(&ctx.accounts.system_program, &ctx.accounts.vault.to_account_info(), &ctx.accounts.relayer.to_account_info(), tip, Some(seeds))?;
        }
        emit!(PrivateTradeEvent { mint, is_buy: false, sol: received, tokens: tokens_in });
        Ok(())
    }
}

fn seeds_ref<'a>(s: &'a &'a [&'a [u8]]) -> &'a [&'a [&'a [u8]]] {
    std::slice::from_ref(s)
}

// ---------------------------------------------------------------- shared logic

fn verify_and_record(
    pool: &AccountLoader<Pool>,
    proof: &Proof,
    public_sol: [u8; 32],
    public_token: [u8; 32],
    asset: [u8; 32],
    ext_hash: [u8; 32],
) -> Result<()> {
    {
        let p = pool.load()?;
        require!(p.is_known_root(&proof.root), PatulaError::UnknownRoot);
    }
    let inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
        proof.root,
        public_sol,
        public_token,
        asset,
        ext_hash,
        proof.input_nullifiers[0],
        proof.input_nullifiers[1],
        proof.output_commitments[0],
        proof.output_commitments[1],
    ];
    let mut v = Groth16Verifier::new(&proof.a, &proof.b, &proof.c, &inputs, &VERIFYING_KEY)
        .map_err(|_| error!(PatulaError::InvalidProof))?;
    v.verify().map_err(|_| error!(PatulaError::InvalidProof))?;

    // Nullifier PDAs were created by `init` in the accounts struct: a reused
    // nullifier fails account creation, which blocks double spends.
    let index = pool.load_mut()?.insert_pair(&proof.output_commitments[0], &proof.output_commitments[1])?;
    emit!(NewCommitments { index, commitments: proof.output_commitments });
    emit!(NullifiersSpent { nullifiers: proof.input_nullifiers });
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[account(zero_copy)]
pub struct Pool {
    pub next_index: u64,
    pub current_root_index: u64,
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub zeros: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

impl Pool {
    fn is_known_root(&self, root: &[u8; 32]) -> bool {
        *root != [0u8; 32] && self.roots.iter().any(|r| r == root)
    }

    fn insert_pair(&mut self, left: &[u8; 32], right: &[u8; 32]) -> Result<u64> {
        let index = self.next_index;
        require!(index + 2 <= 1u64 << LEVELS, PatulaError::TreeFull);
        let mut current = poseidon2(left, right)?;
        let mut idx = index >> 1;
        for i in 1..LEVELS {
            let (l, r) = if idx & 1 == 0 {
                self.filled_subtrees[i] = current;
                (current, self.zeros[i])
            } else {
                (self.filled_subtrees[i], current)
            };
            current = poseidon2(&l, &r)?;
            idx >>= 1;
        }
        self.current_root_index = (self.current_root_index + 1) % ROOT_HISTORY as u64;
        self.roots[self.current_root_index as usize] = current;
        self.next_index = index + 2;
        Ok(index)
    }
}

#[account]
pub struct Nullifier {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
    pub root: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + std::mem::size_of::<Pool>(), seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Proof)]
pub struct Transact<'info> {
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: SystemAccount<'info>,
    #[account(init, payer = signer, space = 8, seeds = [b"nullifier", proof.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Box<Account<'info, Nullifier>>,
    #[account(init, payer = signer, space = 8, seeds = [b"nullifier", proof.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Box<Account<'info, Nullifier>>,
    /// Depositor for deposits; the relayer for private transfers/withdrawals.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: only receives lamports; bound to the proof via ext_data_hash.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Proof)]
pub struct PrivateTrade<'info> {
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: SystemAccount<'info>,
    #[account(init, payer = relayer, space = 8, seeds = [b"nullifier", proof.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Box<Account<'info, Nullifier>>,
    #[account(init, payer = relayer, space = 8, seeds = [b"nullifier", proof.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Box<Account<'info, Nullifier>>,
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub mint: Box<Account<'info, Mint>>,
    /// The pool's token account for this mint. The relayer pays its rent once,
    /// so pool funds never cover it.
    #[account(init_if_needed, payer = relayer, associated_token::mint = mint, associated_token::authority = vault)]
    pub pool_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: validated by the launchpad program
    pub lp_config: UncheckedAccount<'info>,
    /// CHECK: validated by the launchpad program
    #[account(mut)]
    pub lp_curve: UncheckedAccount<'info>,
    /// CHECK: validated by the launchpad program
    #[account(mut)]
    pub lp_curve_token_vault: UncheckedAccount<'info>,
    /// CHECK: validated by the launchpad program
    #[account(mut)]
    pub lp_sol_vault: UncheckedAccount<'info>,
    /// CHECK: validated by the launchpad program
    #[account(mut)]
    pub lp_rewards: UncheckedAccount<'info>,
    /// CHECK: validated by the launchpad program
    #[account(mut)]
    pub lp_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: validated by the launchpad program
    #[account(mut)]
    pub lp_creator: UncheckedAccount<'info>,
    pub launchpad_program: Program<'info, Launchpad>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> PrivateTrade<'info> {
    fn launchpad_ctx<'a>(&self, seeds: &'a [&'a [&'a [u8]]]) -> CpiContext<'a, 'a, 'a, 'info, launchpad::cpi::accounts::Buy<'info>> {
        CpiContext::new_with_signer(
            self.launchpad_program.to_account_info(),
            launchpad::cpi::accounts::Buy {
                config: self.lp_config.to_account_info(),
                curve: self.lp_curve.to_account_info(),
                mint: self.mint.to_account_info(),
                curve_token_vault: self.lp_curve_token_vault.to_account_info(),
                sol_vault: self.lp_sol_vault.to_account_info(),
                rewards: self.lp_rewards.to_account_info(),
                buyer: self.vault.to_account_info(),
                buyer_token: self.pool_token.to_account_info(),
                fee_recipient: self.lp_fee_recipient.to_account_info(),
                creator: self.lp_creator.to_account_info(),
                token_program: self.token_program.to_account_info(),
                associated_token_program: self.associated_token_program.to_account_info(),
                system_program: self.system_program.to_account_info(),
            },
            seeds,
        )
    }

    fn launchpad_sell_ctx<'a>(&self, seeds: &'a [&'a [&'a [u8]]]) -> CpiContext<'a, 'a, 'a, 'info, launchpad::cpi::accounts::Sell<'info>> {
        CpiContext::new_with_signer(
            self.launchpad_program.to_account_info(),
            launchpad::cpi::accounts::Sell {
                config: self.lp_config.to_account_info(),
                curve: self.lp_curve.to_account_info(),
                mint: self.mint.to_account_info(),
                curve_token_vault: self.lp_curve_token_vault.to_account_info(),
                sol_vault: self.lp_sol_vault.to_account_info(),
                rewards: self.lp_rewards.to_account_info(),
                seller: self.vault.to_account_info(),
                seller_token: self.pool_token.to_account_info(),
                fee_recipient: self.lp_fee_recipient.to_account_info(),
                creator: self.lp_creator.to_account_info(),
                token_program: self.token_program.to_account_info(),
                system_program: self.system_program.to_account_info(),
            },
            seeds,
        )
    }
}

#[event]
pub struct NewCommitments {
    pub index: u64,
    pub commitments: [[u8; 32]; 2],
}

#[event]
pub struct NullifiersSpent {
    pub nullifiers: [[u8; 32]; 2],
}

#[event]
pub struct PrivateTradeEvent {
    pub mint: Pubkey,
    pub is_buy: bool,
    pub sol: u64,
    pub tokens: u64,
}

#[error_code]
pub enum PatulaError {
    #[msg("Poseidon hash failed")]
    Poseidon,
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Root is not in recent history")]
    UnknownRoot,
    #[msg("Invalid zero-knowledge proof")]
    InvalidProof,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Trade limit exceeded")]
    LimitExceeded,
}

// ---------------------------------------------------------------- helpers

fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
    solana_poseidon::hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b])
        .map(|h| h.to_bytes())
        .map_err(|_| error!(PatulaError::Poseidon))
}

fn pay<'info>(
    sys: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> Result<()> {
    let accounts = Transfer { from: from.clone(), to: to.clone() };
    match seeds {
        Some(s) => transfer(CpiContext::new_with_signer(sys.to_account_info(), accounts, &[s]), amount),
        None => transfer(CpiContext::new(sys.to_account_info(), accounts), amount),
    }
}

/// sha256 of the parts with the top byte cleared, so it is a valid field element.
pub fn ext_data_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = hashv(parts).to_bytes();
    h[0] = 0;
    h
}

/// A token's asset id inside notes: its mint address with the top byte cleared.
pub fn mint_field(mint: &Pubkey) -> [u8; 32] {
    let mut b = mint.to_bytes();
    b[0] = 0;
    b
}

/// v mod p, big-endian.
pub fn field(v: i128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&v.unsigned_abs().to_be_bytes());
    if v >= 0 {
        return out;
    }
    let mut res = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = FIELD_MODULUS[i] as i16 - out[i] as i16 - borrow;
        if d < 0 {
            res[i] = (d + 256) as u8;
            borrow = 1;
        } else {
            res[i] = d as u8;
            borrow = 0;
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_field_wraps() {
        let mut expect = FIELD_MODULUS;
        expect[31] = 0;
        assert_eq!(field(-1), expect);
        assert_eq!(field(3)[31], 3);
    }
}
