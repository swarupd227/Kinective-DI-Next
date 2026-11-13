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

Business layer: 244 covered, 43 partial, 106 missing, 356 not needed. See `mapping.md`.

## Phases

| Phase | Adds | Partial or missing tables |
|---|---|---|
| 1 | Accounts (the membership or account number), households, missing customer details (deceased, language, TIN type, opt-out, e-statements, address), loan and share details (account numbers, payment, APR, rate type, credit limit), product flags | 25 |
| 2 | Charge-off amounts and recoveries per account; insider and employee loans (Regulation O, NCUA 701.21(d)) | 11 |
| 3 | FHLB collateral eligibility, lien position, participations | 8 |
| 4 | Account-level month-end snapshots (loans, shares, people, accounts, households); waits for 1 to 3 | 17 |
| 5 | Services per account, channel activity, logins | 17 |
| 6 | Profitability per account and member, funds transfer pricing | 15 |
| 7 | Membership applications, alerts, deduplication, marketing touches | 29 |
| 8 | Business members (brm), census geography | 27 |

## Guardrails for every phase

- **Additive only.** New tables beside existing ones. No ALTER of an existing table, and no changed value: new random draws use salts of their own. Existing metrics keep their SQL; new metrics get new names.
- **Fingerprints.** Every table in both demo databases is fingerprinted over its existing columns, before and after the phase. The only differences allowed are the new tables, plus referral dates, which change on every reseed.
- **Tests.**
  - The full test suite and the offline evals.
  - Golden evals for each new question.
  - A routing check that no new agent pattern takes a question an existing agent answers.
- **Tie-outs.** New detail sums to the figures DI already shows: snapshots to the hist tables, recoveries to the Call Report's net charge-offs, households to member counts.
- **Local first, cloud last.** One phase per deploy and seed run. Check the seed time (the job allows 60 minutes) and the database size after each.
- **This mapping is regenerated in the same change,** so each phase moves its tables from missing to covered.
