# Chat model and command proof

These screenshots show the real web interface against isolated test Gateways.
The sidebar is cropped, and provider/model names are synthetic fixture labels.

- Before: `f32dcfefe6e013dafd660845d008f1cf6b158170`.
- After: `981050e982410cac1c3e440272b671dbd8ee2dfe`.
- Final change: `2a4d66c4170717ca6d7c30bede2d85c360b11f05` adds a connection action for unknown readiness. The depicted routing and missing-credential behavior is unchanged.

`routing-before.png` shows the first reply changing to Model Y after New session displayed Model X. `routing-after.png` keeps Model X.

`commands-before.png` shows a disabled composer despite a model-free command being available through the API. `commands-after.png` shows the command working from the composer and a direct connection action.
