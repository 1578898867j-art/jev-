# Beyond the Dome holdout history

Date: 2026-10-21. Puzzle content remains `beyond-the-dome` version `1.0.0`.

## Split change

The original 35-case file was copied byte-for-byte before edits to `eval/archive/beyond-the-dome-cases-20261021.json`. Its SHA-256 is:

`1a09aab59154a7dd427dae8d138b89e042460447f454726a987c920d87250589`

All five cases in the previous holdout split are now regression: `BOD-P02`, `BOD-R02`, `BOD-V02`, `BOD-C01`, and `BOD-X02`. The `qav5` first holdout run observed four of five cases and failed `BOD-C01`. That case is also being used for parameter diagnostics, so it is exposed to tuning. The complete prior holdout set is retired to avoid treating any previously observed expression as sealed. Existing case annotations, including `expected`, `action`, and `history`, were preserved; only those split labels changed.

Six new cases are reserved as holdout: `BOD-H2-01` through `BOD-H2-06`. They cover fresh fact paraphrases for the projection source, openable roof, and actual viewing result; a contextual purpose-cause question with prior player-confirmed facts; a reverse-cause negative; and an unknown-detail question with an injected host-history boundary fixture. Their expected labels are manual annotations and have not been evaluated against a live model.

The active file now contains 35 regression cases and 6 holdout cases (41 total). `BOD-C01`, `BOD-C02`, and `BOD-C07` remain regression cases for the next bounded 12-call diagnostic batch.

The active case file SHA-256 is:

`77cbae9960026af3d11633150a50c80777e70a5e4c2bdac6d3fc2f03f69f5740`

After independent sealed-content review, `BOD-H2-04` received additional player/host history confirming both operations before its contextual purpose question. Its action, expected judgment, added clue, and status were unchanged. A second independent semantic/state review accepted all six new cases. These are annotation reviews, not model scores; all six new holdout cases remain unrun against a live model and sealed from prompt or parameter tuning.

No existing result files were rewritten. The validate-only run selected all 41 cases, made no model calls, and does not establish holdout performance.
