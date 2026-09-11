# R3: Recovery progress

Use when a change classifies an outcome or decides whether work waits, retries, stops, or permits recovery.

## Check

Drive a permanent failure, an uncertain outcome, and a temporarily blocked attempt through the real owner. Identify the event or changed state that makes another attempt useful. Show that unchanged failure does not immediately reschedule itself, settled failure releases only its own admission, and an authorized recovery action can reach the owner.

Preserve the failed attempt as evidence. A stopped run with an explicit reason is a valid outcome. A queue that keeps the repair command behind an unrecoverable predecessor is not a recovery path. A terminal error must not remain pending solely because its new error type was omitted from classification.

## Valid counterexample

A lost response can leave the side effect uncertain. Keep that attempt pending until the owner reconciles it; do not convert every exception into failure or success. A timer waiting for new evidence is also legitimate and differs from immediately repeating the same rejected work.

## Evidence

- [#119195](https://github.com/openclaw/openclaw/pull/119195) treated an empty cron reservation as progress and requested another unchanged tick; [#142741](https://github.com/openclaw/openclaw/pull/142741) repaired tick retirement.
- [#130196](https://github.com/openclaw/openclaw/pull/130196) introduced a permanent tombstone rejection that blocked a queued reset; [#137235](https://github.com/openclaw/openclaw/pull/137235) repaired terminal handling.
- [#134101](https://github.com/openclaw/openclaw/pull/134101) left a settled wizard error classified as uncertain; [#134756](https://github.com/openclaw/openclaw/pull/134756) restored deliberate retry while preserving uncertain outcomes.

## Done

Cite the terminal, uncertain, or temporary outcome and the owner transition that stops, waits, or enables deliberate recovery without repeating unchanged failure; state any proof gap.

[Supporting incidents and limits](evidence.md).
