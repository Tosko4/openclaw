# Real-product reachability audit

PR #145077 was already merged as `7af0464ba9605aba84db3fbdfaa12e5751da9797` when this audit was requested. No revert was made.

All three cases used a real Gateway built from current main at `83418dceaf9a261f9e45c85666faa469330035d4`, separate fresh state directories, normal plugin/catalog behavior, and a real browser. No mock Gateway response or browser fixture was installed.

| State | Visible “Connect an AI provider” buttons | Observation |
| --- | ---: | --- |
| No provider configured | 0 | Initial setup opened first; Back to app reached the empty chat shown in `none.png`. |
| One configured provider, missing credential | 1 | Readiness reported `missing-auth`; Send stayed disabled for a populated draft. The action opened Model Setup. |
| Working configured provider | 0 | A real completion returned `READY`; a separately created empty chat is shown in `working.png`. Its history contains zero messages. |

Verdict: **not reachable in the product; fixture-only** for the duplicate action at this main revision and these requested states. The earlier two-button images in the parent directory are mock-Gateway fixture evidence, not a reproduced current-product defect.

`working-completion.png` records the successful real completion. It does not establish billing or broader provider entitlement. Credentials were kept out of the browser and publication.

Original screenshots use a 1440 by 900 viewport. All published images use the same crop `(280, 60, 1400, 900)` to omit the sidebar and header. No controls or text were edited. The different horizontal content positions follow normal sidebar state.
