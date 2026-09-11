# Empty-chat setup action proof

- Before: baseline `bc402a14479424cd559d172e977a35d2abbe3427` renders two setup actions.
- After: the three-file candidate committed as `5e4abe26c1389c29424bcec5f3483831ef31b562` keeps the action beside the composer and preserves the welcome explanation.
- Captures came from the production-built Control UI and the existing mock-Gateway browser suite, using a schema-valid agent row with no model. The current real Gateway supplies a default model and did not reproduce that sparse state. These images do not establish a current-Gateway defect or an old-server/new-client connection.
- The after captures preceded the final ancestry-only rebase; the affected chat, New Session, and agent UI directories had no intervening base changes.
- `after-help.png` shows the persistent action after local help. The browser checks also verify setup navigation, blocked ordinary sends, and New Session recovery.
- Originals use a 1440 by 900 viewport. These images crop the same rectangle `(440, 0, 1240, 810)` to omit the sidebar and model footer. No rendered controls or text were edited.
