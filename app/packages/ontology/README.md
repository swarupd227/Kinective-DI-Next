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

## Not yet

FIBO alignment (the `fibo` field is empty until each reference is checked), proposing mappings for a new core, and using the ontology in other agents are later phases.
