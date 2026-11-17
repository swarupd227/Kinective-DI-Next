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

## Not yet

FIBO alignment (the `fibo` field is empty until each reference is checked); freezing a mapping built from proposals, and a second core (phase 4); using the ontology in other agents (phase 5). The raw zone's tables are created with the replica at seed time, so a new core's raw tables need a seed step too.
