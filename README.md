# Setup-action evidence

## Post-merge real-product audit

[Real Gateway screenshots and observations](product/README.md) cover no provider, a configured provider with a missing credential, and a working provider. They show 0, 1, and 0 setup buttons respectively. No requested product state showed the duplicate.

**Verdict: not reachable in the product; fixture-only.** PR #145077 removes a duplicate from a renderer state that the current Gateway did not produce. It was already merged when the audit was requested; no revert was made.

## Historical fixture comparison

The root `before.png`, `after.png`, and `after-help.png` images came from the production-built UI with the existing mock Gateway supplying a sparse agent row. They show the renderer change only; they are not product-reachability proof.

- Before source: `bc402a14479424cd559d172e977a35d2abbe3427`.
- After source: candidate later committed as `5e4abe26c1389c29424bcec5f3483831ef31b562`; the affected UI directories did not change during its ancestry-only rebase.
- The historical images use the identical crop `(440, 0, 1240, 810)` from a 1440 by 900 viewport. No rendered controls or text were edited.
