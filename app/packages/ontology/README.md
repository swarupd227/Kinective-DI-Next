# DI Next ontology

A model of what credit unions and banks deal in, for agents and for mapping core systems into DI. Phase 1 of the Core Mapping and Ontology design.

| File | Holds |
|---|---|
| `model/classes.yaml` | Concepts (member, account, share or deposit, loan, collateral, branch, regulatory line, …), their parents and relations, with each institution's own words |
| `model/properties.yaml` | What each concept carries: semantic type, privacy class, checks, synonyms, and the DI columns that hold it (`realized_by`) |
| `model/values.yaml` | Code lists, with the values DI's tables hold for each code at a credit union and at a bank |
| `model/vendors/*.yaml` | A core vendor's vocabulary and Kinective's standard mapping. DI's pulls build their SQL from `symitar.yaml` |

The seed loads it into each tenant database (`onto_concept`, `onto_edge`, `onto_term`, `onto_value`, `core_vocab`, `core_denotes`). The Data Lineage agent answers data dictionary questions from those tables ("What does DI mean by a share draft?", "Which column holds the loan balance?").

## Checks

`test/ontology.test.ts` fails the build when:
- a binding names a column that isn't in a `CREATE TABLE` under `packages/*/src`;
- a column of a hub table (`HUB_TABLES` in `src/index.ts`) has no property;
- a column the semantic model reads has no property;
- a semantic-model metric measures no property, no counted concept and no regulatory line;
- a vendor mapping denotes a property that isn't held in that DI column, or names a core column that isn't in its vocabulary.

Add a property when a hub table gains a column; admit a new concept only when a DI table, metric, report or rule needs it.

## Proposing a core's mapping (phase 2)

`di-core/src/mappingEngine.ts` scores every core column against every DI column a core feeds (members, shares, loans) on five signals: the column's name, split into words with `model/abbreviations.yaml` (and the vendor's description where the vocabulary has one); what its values look like (YYYYMMDD dates, rates in thousandths, money, codes, flags, keys, references); its place in the tables (which DI table its table lines up with, keys and references); Kinective's mapping for the same core, when it isn't hidden; and tie-outs of loan and share totals and the member count to the 5300. A property's `derive` entries say how another kind of column can give it (a due date gives days past due). `SourceService.discover` profiles the core read-only, runs the engine, records `map_run`, `map_profile` and `map_candidate`, and with `hideStandard` measures the proposals against Kinective's mapping. The Core Mapping agent's `map_discover`, `map_review` and `map_explain` tools answer from it.

On the Symitar replica, with Kinective's mapping hidden, the proposals match it on 31 of 31 columns and read all 31 the same way, from names alone or with the vendor's descriptions. The replica uses real Symitar column names over synthetic rows, and a few synonyms were added in the same change (a member's join date is the membership's open date; a member's segment is the member type), so this shows the method works, not how it will do on another core.

## Versions, drift and the raw zone (phase 3)

Each connection's mapping is versioned in `map_version`: version 1 is Kinective's standard mapping, recorded the first time it's needed, and every approved crosswalk change adds one. A pull uses the latest version and records which. On each pull DI checks the core against the version and records what doesn't fit in `map_drift`:
- a code the crosswalk doesn't know: its rows land without that value (held), so nothing counts them under a wrong name, and DI proposes the known code whose rows they look most like (balances, rates, which dates they have);
- a column that appeared in a mapped table, or one the mapping reads that's gone (the pull then stops and replaces nothing);
- open loan or share balances that no longer tie out to the 5300.

"Map share type 14 to money market" adds the code in a new version through an approval card, and resolves the drift; the next pull maps the held rows. Each pull also copies the core's mapped tables as they are into the raw zone (`src_raw_account`, `src_raw_name`, `src_raw_savings`, `src_raw_loan`), so reports written against core tables can read them.

## A core Kinective hasn't mapped (phase 4)

The seed builds a second stand-in core beside the Symitar replica (`<tenant>_coreb`), in a deliberately different shape that isn't any vendor's: members in `person`; shares and loans together in `acct`, told apart by `acct_class`; lower-case names with their own abbreviations; DATE columns; rates as percent decimals; text codes (CHK, MMA, UNSEC, VISA, SEN); a Y/N non-member flag; and days past due beside the next payment date. The demo connects it as "Core B stand-in", with nothing mapped.

For it the engine learned: ISO dates and percent rates; a seeded random profile sample spread over each table; splitting a table whose rows are two or three kinds (a short code under which other columns are filled for one kind and empty for another) into slices, `acct[acct_class=LN]`; text codes and Y/N flags in transforms; and proposing each code list's crosswalk from the codes themselves, through `code_words` in `model/abbreviations.yaml`. "Freeze the proposed mapping" records the latest proposals as a mapping version through an approval card (close calls named), with joins and the slice filter; codes nothing fits are held on pulls, and DI offers its types the core doesn't use yet as the options, rather than a wrong nearest guess.

Measured against an answer key the engine never sees: 27 of 31 DI columns right on the first run, 31 of 31 after adding common abbreviations it lacked (prod, cd for code, dlr, dlq, brch, hhld, nm, pers, cur) and "product type" as a synonym of the share and loan type. Code words for values were written with this core in view. After freezing, shares reconcile row for row; loans and member types with codes DI couldn't read are held until mapped, and two approvals bring loans to row-for-row.

## The ontology across agents (phase 5)

`src/concepts.ts` finds the concepts a question names, by phrase, with no model: a code by its label, its other names (`synonyms` on each code in `model/values.yaml`) or a core's abbreviation (`code_words`), as the value the institution's data holds ("DDA", "share drafts" and "checking" are Checking); a class by its scoped synonyms ("owners" are members at a credit union, not at a bank); a property a metric reads ("past due" is days past due). The longest phrase from the left wins ("car loan balances" is a car loan), a code beats a class that shares its words, and a word with two meanings ("balances") takes the one whose class the rest of the question names, or is left out.
- **Analytics Q&A** searches the catalog with the person's words plus what the concepts add: the value to filter by, a class's own word, a lift for the metrics that read a named property, and the value's class (share, loan, member) only when nothing else matches. Words the ontology understood don't count as unknown, so "How much is in DDA accounts?" is answered instead of refused. The plan step says how the words were read; the offline planner does the same and names the filter it applied.
- **Routing**: the classes named go to the router as a hint and into the audit's "Routed as" line.
- **Data Lineage**: "What changes if the core changes how it codes loan type?" or "What breaks if LOAN.TYPE changes?" goes from the concept or core column, through the ontology, to every DI column that holds it, then by lineage to the measures and reports that read those columns, including through a dimension (loan category).

On 19 everyday phrasings at a credit union and a bank, the catalog search answered 13 of 19 at a credit union and 13 of 19 at a bank before, and 18 and 17 after; the ones left are a figure nothing defines (dividends paid) and "owners" at a bank. Code synonyms were written with these phrasings in view.

## Data quality and privacy (phase 6)

`src/quality.ts` turns each property's `constraints` and fixed code list into checks on every DI column that holds it: a range (`cdm_loan.rate between 0 and 30`, "Every loan interest rate is between 0% and 30%"), no date after the data's as-of date, and every code on its list (open lists are left alone). `di-core/src/ontologyDq.ts` runs them on the institution's current `cdm_*` tables when the app starts and records the results in `ops_dq_check` beside the seeded checks, so the data quality page, Operations ("Which checks failed?") and lineage's checks by domain read them with no change. A rerun replaces its own rows, and a seeded check whose result was written by hand is dropped once a real check covers it (deposits opening in the future; negative days past due). On the synthetic warehouses all 44 checks pass; the seed grants the app INSERT and DELETE on `ops_dq_check` only.

Privacy classes now decide, not just describe: the Query Browser refuses any column the ontology classes as identifying a person (direct or quasi) in the tables it may read, naming the column, as well as the ones it refused before; a custom mapping's preview masks its values when the field's name is one the ontology classes as identifying ("birth date"); and `map_explain` leaves out the range of a core column proposed as one.

## People and roles (phase 7)

Each code on `role_on_account` now says what the role allows (a beneficiary "receives the funds when the owner dies; has no access before then"), and the "Identity and Roles" agent answers "Who is on loan 13?" from `cdm_account_owner` in those roles, with what each allows, the membership's representative payee flag and the primary owner's household; people outside the asker's branches are counted, not named. Member 360's account lines take their role words from the same list. Share and loan numbers are separate series, so a number that is one of each needs "share account" or "loan".

The identity properties carry `match` weights (birth date 30%, last name and last four of the tax ID 25%, first name and email 15%, street and phone 10%, ZIP 5%) and how each compares (names, dates, digits, text); `nicknames` in `model/abbreviations.yaml` lets a familiar first name nearly count (Bob for Robert). `di-core/src/people.ts` scores a person against the records sharing their last name or birth date as the weighted share of the person's own details that agree: 85% or more with no close second is the same person, 60% or more a possible match for a person to check. "Which membership applicants are already members?" matches every applicant and compares DI's decisions with the person each application is recorded against: on both synthetic warehouses every linked applicant (5,522 and 3,724, including 83 and 63 who were members before applying) is matched as the same person, to the right record, none is missed, and 3 and 1 of the unlinked applicants are left as possible matches (a shared name, ZIP and birth date or first name). The synthetic applicants copy their member's details exactly and the nickname list overlaps the seed's, so this shows the method, not its accuracy on real, messier data.

## Not yet

FIBO alignment (the `fibo` field is empty until each reference is checked); matching on misspellings and moved addresses; masking by privacy class everywhere a value is shown (Member 360 and records still use their own rules); checks on history tables. The raw zone's tables are created with each stand-in core at seed time, so a real new core's raw tables need a seed step too.
