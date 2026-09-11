# R2: Ownership across completion

Use when a change transfers work, replaces a page, process, or package generation, or retains an admission/deduplication record.

## Check

Identify who owns admission, completion, and retained state before and after replacement. Exercise the handoff while work is pending, then complete or abandon the old attempt. Show that a valid successor can proceed and that the old attempt cannot finish, release, or suppress the successor's work. When package identity changes, distinguish a legitimate successor generation from another installation.

Include the actual lifetime boundary. An old updater starting a new package, a page navigating away before a response, and an idle process awaiting a child can all destroy an owner that an in-process test quietly keeps alive. Inspect retained state from an already interrupted run as well as a clean new run; preventing another orphan does not settle an existing one.

## Valid counterexample

A live owner or uncertain side effect can legitimately retain admission. Do not clear its state to make the test finish. Establish that the specific attempt is abandoned or terminal, and preserve the current owner's authority.

## Evidence

- [#138690](https://github.com/openclaw/openclaw/pull/138690) admitted child update runs without a completion owner; [#139660](https://github.com/openclaw/openclaw/pull/139660) prevented new orphans and [#143774](https://github.com/openclaw/openclaw/pull/143774) repaired retained ones. This is one cause.
- [#127090](https://github.com/openclaw/openclaw/pull/127090) let deduplication state outlive an abandoned dispatch; [#139661](https://github.com/openclaw/openclaw/pull/139661) repaired successor admission.
- [#121288](https://github.com/openclaw/openclaw/pull/121288) bound descendants to the old package generation; [#143137](https://github.com/openclaw/openclaw/pull/143137) restored valid successor identity after pnpm replacement.

## Done

Cite the pending work’s owner, any successor identity, and evidence that completion or abandonment preserves valid work and rejects unrelated work; state any proof gap.

[Supporting incidents and limits](evidence.md).
