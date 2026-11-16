# ESP alignment

How DI-Next's warehouse lines up with ESP's data model (2,960 registered tables in 93 app domains), and the plan for closing the gaps.

## Files

| File | What it is |
|---|---|
| `build_mapping.py` | The generator. It holds the rules: which DI-Next tables cover each ESP table, and the column maps for the hub tables. |
| `mapping.csv` | Every ESP table: app, layer, kind, status, DI-Next tables, phase, note. |
| `mapping.md` | The business layer by status and phase, the part DI aligns to. |
| `columns.csv`, `columns.md` | The hub tables column by column: loans, shares, customers, accounts, households, loan and share products, cards, credit score history. |

The four generated files stay on the machine that ran the script (they're in `.gitignore`): this repository is public, and they would publish ESP's data model.

To regenerate after changing a rule or the schema:

```bash
python -I app/docs/esp-alignment/build_mapping.py path/to/esp-data-dictionary.md
```

ESP's dictionary is not kept in the repository; pass its path. The generator fails, and writes nothing, if:
- any rule or column map names a DI-Next table or column that doesn't exist in a `CREATE TABLE` under `app/packages/*/src`;
- an ESP business table has no rule;
- a hub column has no mapping.

Run it after any schema change, so the mapping can't drift unnoticed.

## Decisions (13 Nov 2026)

1. **The account becomes a real entity.** The membership or account number sits between a person and their loans and shares, as ESP's `crm_accountdata` does. Phase 1.
2. **DI-Next keeps its own table names** (`cdm_*`, `hist_*`, …). ESP names appear in lineage and in this mapping.
3. **Account-level monthly snapshots (phase 4) wait** until phases 1 to 3 have landed.
4. **Seed data stays.** There is no real core feed; each phase extends the synthetic seed for both demo tenants.

## Layers

| Layer | Tables | DI-Next stance |
|---|---|---|
| Core-system feed (Prodigy, Corelation, Symitar, DNA, FIS, FICS) | 1,369 | Not modeled. A tenant runs one core; Core mapping (`src_mapping`, `src_column_map`) is where one would be mapped. |
| Business and analytics | 749 | The alignment target. 356 are not needed: generated tables with no columns, picker trees, forms, link tables, audit copies, test fixtures and settings. |
| ESP platform | 583 | Not modeled; DI-Next has its own platform. |
| Third-party feed | 147 | Sources, when a feature needs one. |
| Work and people | 128 | DI-Next has its own where needed. |

Business layer: 317 covered, 10 partial, 63 missing, 359 not needed (after phase 5; 244, 43 and 106 before phase 1). See `mapping.md`.

## Phases

| Phase | Adds | Partial or missing tables |
|---|---|---|
| 1 (done) | `cdm_account`, `cdm_account_holding`, `cdm_household`, `cdm_party_detail`, `cdm_party_address`, `cdm_loan_terms`, `cdm_deposit_terms`: accounts and which loans and shares sit under each, households, member number, names, TIN type, language, deceased, marketing opt-out, address, and loan and share terms (payment, due date, APR, rate type, credit limit, opening deposit, certificate term, auto-renew) | 0 |
| 1b (done) | `cdm_product_detail`, `cdm_cross_sell_group`, `cdm_dividend_tier`, `cdm_card_product`, `cdm_card_terms`, `cdm_misc_product`, `cdm_misc_account`, and columns on phase 1's tables: product details and cross-sell groups, rate tiers by balance, card products and expiry, safe deposit boxes, servicing-branch overrides, each indirect loan's dealer (as Indirect's dealer figures assign it), loan maturity, the renewing amount, account titles and relationship codes, name prefix and suffix, phones and a second email. The loan's application link and who decided it stay out: the demo seed builds applications apart from the loan book. | 0 |
| 2 (done) | `cdm_loan_chargeoff`, `cdm_loan_recovery`, `cdm_deposit_chargeoff`, `cdm_deposit_recovery`, `cdm_insider`, `cdm_insider_loan`: each charge-off and recovery, loan by loan and for overdrawn checking closed with a negative balance; directors, committee members, executive officers, principal shareholders and employees, and their loans with the board's approval (Regulation O, NCUA 701.21(d)). The seed's loan book had charged off too few loans for the losses its Call Report reported, so loans now charge off at realistic yearly rates by product, and the Call Report's charge-off and recovery lines are the sums of these rows. Off-core deposits have no feed in DI, so their charge-offs are not needed yet. | 0 |
| 3 (done) | `cdm_lien_position`, `cdm_participation_type`, `cdm_fhlb_investor`, `cdm_loan_collateral`, `cdm_fhlb_ineligibility_type`, `cdm_fhlb_ineligibility`, `cdm_fhlb_manual_ineligibility`: each real-estate loan's lien and FHLB collateral category, a bank's participations sold and bought with the other bank, and every reason a loan can't be pledged, ranked (60+ days late, classified, to an insider, bought into, over the LTV limit, a document missing from the file). The liquidity model now lends against the eligible loans instead of assuming 70% of performing loans are listed; the FHLB's 20%-of-assets cap still binds for both demo tenants, so capacity is unchanged. `cdm_loan.balance` stays the institution's own share of a participation. | 0 |
| 4 (done) | `hist_loan_account_month`, `hist_deposit_account_month`, `hist_account_month`, `hist_person_month`, `hist_household_month`, `hist_fhlb_collateral_quarter`, `cdm_transaction_exception`: each loan and share at each month-end, and the same added up by account, person and household; the qualifying collateral report at each quarter-end; entries voided and keyed again, fees charged and refunded, and loan payments returned. The seed already walked every account month by month to build the month-end totals; these are the same paths kept per account, so they add up to `hist_loan_month` and `hist_deposit_month`. Posted transactions leave out voids and the pairs that cancel, so no balance moves. Daily balances stay partial: they would need a core feed. | 0 |
| 5 (done) | `cdm_login`, `cdm_service_type`, `cdm_account_service`, `cdm_deposit_service`, `cdm_loan_service`, `cdm_product_service`: each online and mobile login over the last 90 days, adding up to the 90-day counts Member 360 shows; online and mobile banking, e-statements, bill pay, mobile deposit and phone banking on each account, following the digital-use dates; courtesy pay (a bank's overdraft privilege), overdraft transfer, direct deposit and debit cards on each share, following the cards and the overdraft fees; GAP, mechanical repair coverage and debt protection sold with each loan, and which services each loan product allows. ESP's channel tables need no table: each posted transaction carries its channel and code. Login addresses come from the ranges set aside for documentation. | 0 |
| 6 | Profitability per account and member, funds transfer pricing | 15 |
| 7 | Membership applications, alerts, deduplication, marketing touches | 29 |
| 8 | Business members (brm), census geography | 27 |

## Guardrails for every phase

- **Additive only,** unless the existing data is wrong and the user agrees to correct it (phase 2's charge-offs); then every changed figure is listed in the commit. New tables beside existing ones. No ALTER of an existing table, and no changed value: new random draws use salts of their own. Existing metrics keep their SQL; new metrics get new names.
- **Fingerprints.** Every table in both demo databases is fingerprinted over its existing columns, before and after the phase. The only differences allowed are the new tables, plus referral dates, which change on every reseed.
- **Tests.**
  - The full test suite and the offline evals.
  - Golden evals for each new question.
  - A routing check that no new agent pattern takes a question an existing agent answers.
- **Tie-outs.** New detail sums to the figures DI already shows: snapshots to the hist tables, recoveries to the Call Report's net charge-offs, households to member counts.
- **Local first, cloud last.** One phase per deploy and seed run. Check the seed time (the job allows 60 minutes) and the database size after each.
- **This mapping is regenerated in the same change,** so each phase moves its tables from missing to covered.
