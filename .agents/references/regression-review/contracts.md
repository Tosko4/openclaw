# R1: Contract propagation

Use when a cutover changes the facts or artifacts delivered to an existing consumer.

## Check

Trace an existing supported caller through the changed producer, every adapter, and the final decision. Show that the fact or action the consumer needs still arrives with the same supported meaning. Exercise the actual registered or shipped entry point; importing a helper directly can bypass the broken boundary.

Name the exact fact or artifact the consumer needs, then locate its producer after the cutover. For a route, follow a document request through the server. For a package, load the staged artifact. For a normalizer, follow the transformed value into the next migration or classifier. These are applications of the same producer-to-consumer check, not a mandatory suite for every change.

## Valid counterexample

A field or route may be deliberately retired under an accepted contract. Do not restore it merely because an older caller exists. Establish whether that caller is a supported installed client, shipped artifact, or internal caller that the cutover must migrate.

## Evidence

- [#135839](https://github.com/openclaw/openclaw/pull/135839) moved discovery to `/plugins` while the HTTP server still refused document serving there; [#142798](https://github.com/openclaw/openclaw/pull/142798) repaired the boundary.
- [#134281](https://github.com/openclaw/openclaw/pull/134281) removed transport-owned retries without carrying HTTP status into central classification; [#137146](https://github.com/openclaw/openclaw/pull/137146) restored that fact.
- [#112678](https://github.com/openclaw/openclaw/pull/112678) normalized the agent roster before a migration still reading its old shape; [#134760](https://github.com/openclaw/openclaw/pull/134760) restored the downstream contract.

## Done

Cite the required fact or artifact, the real consumer, and evidence that it remains available with its supported meaning after the cutover; state any proof gap.

[Supporting incidents and limits](evidence.md).
