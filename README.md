# Chat model and command proof

These screenshots show the real web interface against isolated test Gateways.
The sidebar is cropped, and provider/model names are synthetic fixture labels.

- Before: `f32dcfefe6e013dafd660845d008f1cf6b158170`.
- Routing after: `981050e982410cac1c3e440272b671dbd8ee2dfe`.
- Commands after: `6956cd7e53f2e53bf852c2da2bb77919c2f78a15`.

`routing-before.png` shows the first reply changing to Model Y after New session displayed Model X. `routing-after.png` keeps Model X. Later corrections do not change session creation or reply selection.

`commands-before.png` shows a disabled composer despite a model-free command being available through the API. `commands-after.png` shows supported custom-connection guidance, an editable `/model` command with Send enabled, and a direct connection action. Independent browser checks also exercised Send, Enter, menu selection, clear, export initiation, blocked ordinary messages, and a cached picker while its catalog request had no response.

No successful real-provider login or live catalog refresh is claimed by these captures.
