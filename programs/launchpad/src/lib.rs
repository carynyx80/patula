//! Patula launchpad — bonding-curve token launches (Phase 1, public mode).
//!
//! Every token launched here gets these guarantees from the program itself:
//! - fixed supply: the whole supply is minted at creation, then the mint
//!   authority is revoked; there is no freeze authority
//! - liquidity cannot be pulled: curve SOL sits in a program-owned vault and
//!   there is no admin withdrawal instruction
//! - capped creator buy: the creator wallet can buy at most
//!   `max_creator_buy_bps` of supply
//! - anti-sniper window: during the first `sniper_slots` slots, one trade can
//!   buy at most `sniper_max_bps` of supply
//!
//! Pricing is a constant-product curve over virtual reserves. When the curve's
//! tokens sell out, the curve is marked complete and trading stops; migration
//! of the SOL and the reserved tokens to a DEX pool is the next instruction to
//! be built (until then they stay locked in the program).
//!
//! NOT AUDITED. Devnet only.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{
    self, set_authority, spl_token::instruction::AuthorityType, Mint, MintTo, SetAuthority, Token,
    TokenAccount, Transfer as SplTransfer,
};

declare_id!("C7eYK9wzuSWcC5daBfLB2MxXg34PNBQjMtDKcRkBdsFP");

pub const DECIMALS: u8 = 6;
const BPS: u128 = 10_000;

#[program]
pub mod launchpad {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
        require!(params.curve_supply < params.total_supply, LaunchpadError::BadConfig);
        require!(params.virtual_token > params.curve_supply, LaunchpadError::BadConfig);
        require!(params.trade_fee_bps + params.creator_fee_bps < 1_000, LaunchpadError::BadConfig);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.fee_recipient = params.fee_recipient;
        c.trade_fee_bps = params.trade_fee_bps;
        c.creator_fee_bps = params.creator_fee_bps;
        c.launch_fee = params.launch_fee;
        c.virtual_sol = params.virtual_sol;
        c.virtual_token = params.virtual_token;
        c.curve_supply = params.curve_supply;
        c.total_supply = params.total_supply;
        c.max_creator_buy_bps = params.max_creator_buy_bps;
        c.sniper_slots = params.sniper_slots;
        c.sniper_max_bps = params.sniper_max_bps;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_token(ctx: Context<CreateToken>, name: String, symbol: String, uri: String) -> Result<()> {
        require!(!name.is_empty() && name.len() <= 32, LaunchpadError::BadMetadata);
        require!(!symbol.is_empty() && symbol.len() <= 10, LaunchpadError::BadMetadata);
        require!(uri.len() <= 200, LaunchpadError::BadMetadata);
        let config = &ctx.accounts.config;
        let mint_key = ctx.accounts.mint.key();

        let curve = &mut ctx.accounts.curve;
        curve.mint = mint_key;
        curve.creator = ctx.accounts.creator.key();
        curve.virtual_sol = config.virtual_sol;
        curve.virtual_token = config.virtual_token;
        curve.real_sol = 0;
        curve.real_token = config.curve_supply;
        curve.creator_bought = 0;
        curve.launch_slot = Clock::get()?.slot;
        curve.complete = false;
        curve.bump = ctx.bumps.curve;
        curve.name = name.clone();
        curve.symbol = symbol.clone();
        curve.uri = uri.clone();

        // Mint the whole supply into the curve vault, then revoke minting forever.
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: curve.to_account_info(),
                },
                &[seeds],
            ),
            config.total_supply,
        )?;
        set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: curve.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        // Rent for the SOL vault, then the launch fee.
        let rent = Rent::get()?.minimum_balance(0);
        pay(&ctx.accounts.system_program, &ctx.accounts.payer, &ctx.accounts.sol_vault, rent)?;
        if config.launch_fee > 0 {
            pay(&ctx.accounts.system_program, &ctx.accounts.payer, &ctx.accounts.fee_recipient, config.launch_fee)?;
        }

        emit!(TokenCreated {
            mint: mint_key,
            creator: ctx.accounts.creator.key(),
            name,
            symbol,
            uri,
            slot: curve.launch_slot,
        });
        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(!ctx.accounts.curve.complete, LaunchpadError::CurveComplete);
        require!(sol_in > 0, LaunchpadError::ZeroAmount);
        let q = quote_buy(&ctx.accounts.curve, &ctx.accounts.config, sol_in)?;
        require!(q.tokens_out >= min_tokens_out, LaunchpadError::Slippage);
        execute_buy(ctx, q)
    }

    /// Buy exactly `tokens_out`, paying at most `max_sol_in` (fees included).
    /// Used by the shielded pool, whose proofs fix the token amount in advance.
    pub fn buy_exact_out(ctx: Context<Buy>, tokens_out: u64, max_sol_in: u64) -> Result<()> {
        require!(!ctx.accounts.curve.complete, LaunchpadError::CurveComplete);
        let q = quote_buy_exact_out(&ctx.accounts.curve, &ctx.accounts.config, tokens_out)?;
        require!(q.net_sol + q.fee + q.creator_fee <= max_sol_in, LaunchpadError::Slippage);
        execute_buy(ctx, q)
    }

    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        let curve = &mut ctx.accounts.curve;
        require!(!curve.complete, LaunchpadError::CurveComplete);
        require!(tokens_in > 0, LaunchpadError::ZeroAmount);

        let q = quote_sell(curve, config, tokens_in)?;
        require!(q.gross_sol <= curve.real_sol, LaunchpadError::InsufficientLiquidity);
        require!(q.net_sol >= min_sol_out && q.net_sol > 0, LaunchpadError::Slippage);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.seller_token.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        let mint_key = curve.mint;
        let bump = ctx.bumps.sol_vault;
        let seeds: &[&[u8]] = &[b"sol_vault", mint_key.as_ref(), &[bump]];
        let sys = &ctx.accounts.system_program;
        pay_signed(sys, &ctx.accounts.sol_vault, &ctx.accounts.seller.to_account_info(), q.net_sol, seeds)?;
        if q.fee > 0 {
            pay_signed(sys, &ctx.accounts.sol_vault, &ctx.accounts.fee_recipient.to_account_info(), q.fee, seeds)?;
        }
        if q.creator_fee > 0 {
            pay_signed(sys, &ctx.accounts.sol_vault, &ctx.accounts.creator.to_account_info(), q.creator_fee, seeds)?;
        }

        curve.virtual_sol = q.new_virtual_sol;
        curve.virtual_token = q.new_virtual_token;
        curve.real_sol -= q.gross_sol;
        curve.real_token = curve.real_token.checked_add(tokens_in).ok_or(LaunchpadError::MathOverflow)?;

        emit_trade(curve, ctx.accounts.seller.key(), false, q.net_sol, tokens_in)?;
        Ok(())
    }
}

// ------------------------------------------------------------------ math

pub struct BuyQuote {
    pub tokens_out: u64,
    pub net_sol: u64,
    pub fee: u64,
    pub creator_fee: u64,
    pub new_virtual_sol: u64,
    pub new_virtual_token: u64,
}

pub struct SellQuote {
    pub gross_sol: u64,
    pub net_sol: u64,
    pub fee: u64,
    pub creator_fee: u64,
    pub new_virtual_sol: u64,
    pub new_virtual_token: u64,
}

fn div_ceil(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

/// Fees are taken from `sol_in`; the rest moves the curve. Rounding always
/// favours the curve.
pub fn quote_buy(curve: &Curve, config: &Config, sol_in: u64) -> Result<BuyQuote> {
    let fee_bps = config.trade_fee_bps as u128;
    let cfee_bps = config.creator_fee_bps as u128;
    let vs = curve.virtual_sol as u128;
    let vt = curve.virtual_token as u128;
    let k = vs * vt;

    let mut fee = sol_in as u128 * fee_bps / BPS;
    let mut cfee = sol_in as u128 * cfee_bps / BPS;
    let mut net = sol_in as u128 - fee - cfee;
    let mut new_vs = vs + net;
    let mut new_vt = div_ceil(k, new_vs);
    let mut tokens_out = vt - new_vt;

    // Last buy: clamp to what is left and charge only what that costs.
    if tokens_out > curve.real_token as u128 {
        tokens_out = curve.real_token as u128;
        new_vt = vt - tokens_out;
        new_vs = div_ceil(k, new_vt);
        net = new_vs - vs;
        let keep = BPS - fee_bps - cfee_bps;
        fee = div_ceil(net * fee_bps, keep);
        cfee = div_ceil(net * cfee_bps, keep);
    }
    Ok(BuyQuote {
        tokens_out: tokens_out as u64,
        net_sol: net as u64,
        fee: fee as u64,
        creator_fee: cfee as u64,
        new_virtual_sol: new_vs as u64,
        new_virtual_token: new_vt as u64,
    })
}

pub fn quote_sell(curve: &Curve, config: &Config, tokens_in: u64) -> Result<SellQuote> {
    let vs = curve.virtual_sol as u128;
    let vt = curve.virtual_token as u128;
    let k = vs * vt;
    let new_vt = vt + tokens_in as u128;
    let new_vs = div_ceil(k, new_vt);
    let gross = vs - new_vs;
    let fee = gross * config.trade_fee_bps as u128 / BPS;
    let cfee = gross * config.creator_fee_bps as u128 / BPS;
    Ok(SellQuote {
        gross_sol: gross as u64,
        net_sol: (gross - fee - cfee) as u64,
        fee: fee as u64,
        creator_fee: cfee as u64,
        new_virtual_sol: new_vs as u64,
        new_virtual_token: new_vt as u64,
    })
}


fn execute_buy(ctx: Context<Buy>, q: BuyQuote) -> Result<()> {
    let config = &ctx.accounts.config;
    let curve = &mut ctx.accounts.curve;
    require!(q.tokens_out > 0, LaunchpadError::ZeroAmount);

    let slot = Clock::get()?.slot;
    if slot < curve.launch_slot.saturating_add(config.sniper_slots) {
        let cap = (config.total_supply as u128 * config.sniper_max_bps as u128 / BPS) as u64;
        require!(q.tokens_out <= cap, LaunchpadError::SniperCap);
    }
    if ctx.accounts.buyer.key() == curve.creator {
        let cap = (config.total_supply as u128 * config.max_creator_buy_bps as u128 / BPS) as u64;
        let total = curve.creator_bought.checked_add(q.tokens_out).ok_or(LaunchpadError::MathOverflow)?;
        require!(total <= cap, LaunchpadError::CreatorCap);
        curve.creator_bought = total;
    }

    let sys = &ctx.accounts.system_program;
    pay(sys, &ctx.accounts.buyer, &ctx.accounts.sol_vault, q.net_sol)?;
    if q.fee > 0 {
        pay(sys, &ctx.accounts.buyer, &ctx.accounts.fee_recipient, q.fee)?;
    }
    if q.creator_fee > 0 {
        pay(sys, &ctx.accounts.buyer, &ctx.accounts.creator, q.creator_fee)?;
    }

    let mint_key = curve.mint;
    let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.curve_token_vault.to_account_info(),
                to: ctx.accounts.buyer_token.to_account_info(),
                authority: curve.to_account_info(),
            },
            &[seeds],
        ),
        q.tokens_out,
    )?;

    curve.virtual_sol = q.new_virtual_sol;
    curve.virtual_token = q.new_virtual_token;
    curve.real_sol = curve.real_sol.checked_add(q.net_sol).ok_or(LaunchpadError::MathOverflow)?;
    curve.real_token -= q.tokens_out;

    emit_trade(curve, ctx.accounts.buyer.key(), true, q.net_sol + q.fee + q.creator_fee, q.tokens_out)?;
    if curve.real_token == 0 {
        curve.complete = true;
        emit!(Graduated { mint: curve.mint, real_sol: curve.real_sol, slot });
    }
    Ok(())
}

/// Cost of buying exactly `tokens_out`, fees grossed up on top of the curve cost.
pub fn quote_buy_exact_out(curve: &Curve, config: &Config, tokens_out: u64) -> Result<BuyQuote> {
    require!(tokens_out > 0 && tokens_out <= curve.real_token, LaunchpadError::InsufficientLiquidity);
    let fee_bps = config.trade_fee_bps as u128;
    let cfee_bps = config.creator_fee_bps as u128;
    let vs = curve.virtual_sol as u128;
    let vt = curve.virtual_token as u128;
    let k = vs * vt;
    let new_vt = vt - tokens_out as u128;
    let new_vs = div_ceil(k, new_vt);
    let net = new_vs - vs;
    let keep = BPS - fee_bps - cfee_bps;
    Ok(BuyQuote {
        tokens_out,
        net_sol: net as u64,
        fee: div_ceil(net * fee_bps, keep) as u64,
        creator_fee: div_ceil(net * cfee_bps, keep) as u64,
        new_virtual_sol: new_vs as u64,
        new_virtual_token: new_vt as u64,
    })
}

// ------------------------------------------------------------------ helpers

fn pay<'info>(sys: &Program<'info, System>, from: &Signer<'info>, to: &impl ToAccountInfo<'info>, amount: u64) -> Result<()> {
    transfer(
        CpiContext::new(sys.to_account_info(), Transfer { from: from.to_account_info(), to: to.to_account_info() }),
        amount,
    )
}

fn pay_signed<'info>(
    sys: &Program<'info, System>,
    from: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    transfer(
        CpiContext::new_with_signer(
            sys.to_account_info(),
            Transfer { from: from.to_account_info(), to: to.clone() },
            &[seeds],
        ),
        amount,
    )
}

fn emit_trade(curve: &Curve, trader: Pubkey, is_buy: bool, sol: u64, tokens: u64) -> Result<()> {
    emit!(Trade {
        mint: curve.mint,
        trader,
        is_buy,
        sol,
        tokens,
        virtual_sol: curve.virtual_sol,
        virtual_token: curve.virtual_token,
        real_sol: curve.real_sol,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ------------------------------------------------------------------ state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub trade_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub launch_fee: u64,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub total_supply: u64,
    pub max_creator_buy_bps: u16,
    pub sniper_slots: u64,
    pub sniper_max_bps: u16,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub fee_recipient: Pubkey,
    pub trade_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub launch_fee: u64,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub total_supply: u64,
    pub max_creator_buy_bps: u16,
    pub sniper_slots: u64,
    pub sniper_max_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub real_token: u64,
    pub creator_bought: u64,
    pub launch_slot: u64,
    pub complete: bool,
    pub bump: u8,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
}

// ------------------------------------------------------------------ contexts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateToken<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// Pays rent and the launch fee. In public mode this is the creator; in
    /// private mode it is a relayer, so the creator key never needs funding.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Recorded as the token's creator and receives creator fees. Signs so a
    /// launch cannot be attributed to someone else.
    pub creator: Signer<'info>,
    #[account(init, payer = payer, mint::decimals = DECIMALS, mint::authority = curve)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = payer, space = 8 + Curve::INIT_SPACE, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(init, payer = payer, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"sol_vault", mint.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    /// CHECK: checked against config
    #[account(mut, address = config.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"sol_vault", mint.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(init_if_needed, payer = buyer, associated_token::mint = mint, associated_token::authority = buyer)]
    pub buyer_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against config
    #[account(mut, address = config.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against curve
    #[account(mut, address = curve.creator)]
    pub creator: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"sol_vault", mint.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = seller)]
    pub seller_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against config
    #[account(mut, address = config.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against curve
    #[account(mut, address = curve.creator)]
    pub creator: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------ events & errors

#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub slot: u64,
}

#[event]
pub struct Trade {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub sol: u64,
    pub tokens: u64,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub timestamp: i64,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub real_sol: u64,
    pub slot: u64,
}

#[error_code]
pub enum LaunchpadError {
    #[msg("Invalid config")]
    BadConfig,
    #[msg("Name 1-32, symbol 1-10, uri up to 200 characters")]
    BadMetadata,
    #[msg("Curve is complete; trading has stopped")]
    CurveComplete,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Price moved beyond your slippage limit")]
    Slippage,
    #[msg("Anti-sniper window: trade too large")]
    SniperCap,
    #[msg("Creator buy cap reached")]
    CreatorCap,
    #[msg("Not enough SOL in the curve")]
    InsufficientLiquidity,
    #[msg("Math overflow")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            authority: Pubkey::default(),
            fee_recipient: Pubkey::default(),
            trade_fee_bps: 70,
            creator_fee_bps: 30,
            launch_fee: 0,
            virtual_sol: 25_000_000_000,
            virtual_token: 1_050_000_000_000_000,
            curve_supply: 800_000_000_000_000,
            total_supply: 1_000_000_000_000_000,
            max_creator_buy_bps: 500,
            sniper_slots: 0,
            sniper_max_bps: 100,
            bump: 0,
        }
    }
    fn curve(c: &Config) -> Curve {
        Curve {
            mint: Pubkey::default(),
            creator: Pubkey::default(),
            virtual_sol: c.virtual_sol,
            virtual_token: c.virtual_token,
            real_sol: 0,
            real_token: c.curve_supply,
            creator_bought: 0,
            launch_slot: 0,
            complete: false,
            bump: 0,
            name: String::new(),
            symbol: String::new(),
            uri: String::new(),
        }
    }

    #[test]
    fn buy_then_sell_never_profits() {
        let c = cfg();
        let mut cv = curve(&c);
        let b = quote_buy(&cv, &c, 1_000_000_000).unwrap();
        cv.virtual_sol = b.new_virtual_sol;
        cv.virtual_token = b.new_virtual_token;
        cv.real_sol = b.net_sol;
        let s = quote_sell(&cv, &c, b.tokens_out).unwrap();
        assert!(s.net_sol < 1_000_000_000);
        assert!(s.gross_sol <= cv.real_sol);
    }

    #[test]
    fn last_buy_is_clamped() {
        let c = cfg();
        let cv = curve(&c);
        let b = quote_buy(&cv, &c, 1_000_000_000_000).unwrap();
        assert_eq!(b.tokens_out, c.curve_supply);
        // Raising the whole curve costs 80 SOL of net liquidity.
        assert_eq!(b.net_sol, 80_000_000_000);
    }
}
