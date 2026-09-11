# R4: Workload assumptions

Use when a change introduces or moves a deadline, probe, scan, snapshot, or admission check.

## Check

Name the operating condition the algorithm assumes, then exercise the supported condition most likely to violate it: a substantial database, a concurrent writer, or a slow but valid platform response. Trace the caller's budget through the actual adapter and child process. Verify completion or a justified refusal while the owning lease remains valid.

Measure the operation that determines cost. A small warm fixture cannot justify a full-file inspection deadline. A running Gateway cannot promise unchanging database bytes. A generous caller deadline has no effect when a lower adapter silently replaces it. The correction may require a different inspection strategy rather than more waiting.

## Valid counterexample

A deadline may protect a measured host limit or terminate a stuck child. Preserve that bound and its reason. The check does not require unbounded waits, suppressing integrity checks, or enlarging timeouts until a test passes.

## Evidence

- [#136578](https://github.com/openclaw/openclaw/pull/136578) routed Windows status through a fixed five-second probe despite the caller budget; [#143292](https://github.com/openclaw/openclaw/pull/143292) repaired propagation.
- [#138868](https://github.com/openclaw/openclaw/pull/138868) required quiescent bytes during live update inspection; [#142419](https://github.com/openclaw/openclaw/pull/142419) repaired the strategy.
- [#141412](https://github.com/openclaw/openclaw/pull/141412) reused a small-fixture timeout for full-file integrity work; [#141918](https://github.com/openclaw/openclaw/pull/141918) repaired that assumption.

## Done

Cite the supported workload, measured or source-proven cost, effective deadline through the full call chain, and completion or justified refusal; state any proof gap.

[Supporting incidents and limits](evidence.md).
