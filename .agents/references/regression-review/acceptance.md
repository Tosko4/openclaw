# R5: Preserve valid inputs when tightening acceptance

Use when a guard, parser, or migration newly rejects input or state, or runs from a broader set of callers.

## Check

Identify the invalid state the stricter check is meant to reject. Enumerate the supported existing inputs and retained states that will now reach it. Exercise a valid old case beside the invalid case through the actual entry point, including callers outside the original operation's scope. Show that rejection follows the intended distinction.

Establish validity from the prior supported contract and ownership facts. A legacy plugin without a newly introduced lifecycle, accepted freeform skill text, and a harmless deferred migration warning each differ from the malformed or unowned case the guard protects against. A healthy missing table and an exactly recognized retired row differ from unreadable custody state.

## Valid counterexample

Previously accepted input can be intentionally retired under an accepted migration or security contract. Do not restore it merely to pass a compatibility test. Unknown or corrupt custody must not be assumed harmless, and real adoption ownership must still be enforced.

## Evidence

- [#110981](https://github.com/openclaw/openclaw/pull/110981) required a new lifecycle from legacy plugins; [#135179](https://github.com/openclaw/openclaw/pull/135179) restored the intended distinction.
- [#108926](https://github.com/openclaw/openclaw/pull/108926) rejected supported freeform skill fields; [#122884](https://github.com/openclaw/openclaw/pull/122884) repaired acceptance.
- [#139683](https://github.com/openclaw/openclaw/pull/139683) made ownership-only migration warnings fatal; [#143141](https://github.com/openclaw/openclaw/pull/143141) distinguished safe deferral.
- [#140339](https://github.com/openclaw/openclaw/pull/140339) extended retained-state refusal to config/service writes; [#144208](https://github.com/openclaw/openclaw/pull/144208) handles recognized retired rows and [#144715](https://github.com/openclaw/openclaw/pull/144715) handles the healthy missing-table case.

## Done

Cite the valid and invalid states, why they differ, and observed acceptance/refusal through the real caller; state any proof gap.

[Supporting incidents and limits](evidence.md).
