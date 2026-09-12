# Refresh the regression playbook

Use for a release regression audit or when new evidence changes a lesson. Keep the five check pages as the shared instruction owner; incident evidence grows separately.

## Audit a release

1. **Set the window.** Record the previous stable tag, target tag or current source revision, publication times, and observation cutoff. Follow the correct release track. Done: source identities and the report window are explicit.
2. **Collect candidates.** Start with Gitcrawl and Discrawl discovery across release notes, fixes, reports, linked discussions, and later repairs. Check archive freshness and record search coverage and omissions. Metadata can lag captured content, and captured bodies can be incomplete. Verify complete bodies, relevant comments or attachments, and current issue/PR state against live sources; use narrow GitHub lookups when archive capture fails. Deduplicate mirrored reports by their underlying observation. Labels and fix titles identify candidates, not causes. Done: each collected candidate has a disposition or an explicit evidence gap.
3. **Attribute the cause.** Establish a prior working contract, then inspect the introducing and fixing changes, touched owners, callers, history, and linked evidence. Use blame and source comparison; use executable bisect only in an authorized environment. For a contributor-scoped audit, verify authorship and merge responsibility separately; neither establishes code causality. Separate new-feature bugs, preexisting failures, between-release defects, and released regressions. Done: each attributed regression has source evidence for the changed decision, or remains uncertain.
4. **Map exposure and repair.** Verify cause and repair presence in the actual release sources; account for equivalent patches and reversions. Merge dates alone do not prove release inclusion. Distinguish an incomplete repair from a repair that introduced another defect. Done: affected-release claims, repair stages, and remaining uncertainty are recorded separately.
5. **Analyze before writing rules.** Group independent causes by the decision a reviewer could check. Record subsystem, a two- or three-level failure class, one-sentence root decision, one-sentence review check, cause/fix links, confidence, and later-fix evidence. Count each cause once. Done: the dataset and clustering analysis exist before any new instruction is drafted.

Keep raw reports and private investigation material in task artifacts. Publish only reviewed, relevant evidence and public source links. Unknown causes remain visible in the audit; they do not support a rule.

## Change a lesson

- Prefer a product correction or meaningful regression test when it directly protects the contract. Guidance addresses the remaining review decision.
- Strengthen, merge, replace, or retire an existing page before adding one. A new check needs at least two independent high-confidence regressions with shipped-contract evidence; two fixes of one cause count once.
- Preserve valid counterexamples. An accepted migration or real ownership refusal must not become a false positive just to avoid an old failure.
- Update the index and [supporting incidents](evidence.md) together. Keep representative examples on the page and further evidence separate. Preserve corrections through Git history, with the reason in the change description.
- Recheck applicability when the current owner or contract changes. Dates identify historical evidence; they do not decide which instructions apply. Retire superseded checks from the active index.

Done: a fresh reviewer has checked the complete revised page, its support, its trigger, and its valid counterexamples. Record unresolved disagreements rather than repeating unchanged proposals.

## Verify usefulness

Check that agents discover the index and select every relevant page from the changed decision, including callers outside the edited directory. Read selected pages whole. Measure actual context load and missed selections; there is no arbitrary token cutoff.

Use cases already studied as development material. Compare guidance against the existing reviewer on new independent cases before claiming improved detection. Isolate trial inputs from future history, fix answers, linked closing PRs, and network access; public cases may still be memorized. Score useful findings, misses, unsupported findings, and blocked valid behavior by independent cause.

Reviewers judging a guidance-changing PR use the accepted base guidance. Assess proposed instructions separately; a change cannot approve itself with its own replacement rules. This is a review procedure, not a new automated merge gate.
