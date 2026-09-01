# ADR 0002: Admin-approved device pairing

Status: accepted

## Context

The original teammate setup required an operator to create a secret handoff
file, restart Gateway, transfer the file, and ask the teammate to run an
installer. That path proved the security boundaries but exposed deployment
details to every user and made open-source adoption unnecessarily difficult.

Pairing must preserve explicit repository consent, one endpoint per linked
Codex session, outbound-only connectivity, central Slack ownership, one-hop
routing, immediate revocation, and the rule that teammate enrollment cannot
create a Master.

## Decision

Gateway provides an optional ten-minute device pairing flow and a small
same-origin admin page at `/agents`.

1. A teammate explicitly confirms a repository and Gateway URL.
2. The device generates separate Connector, Work Map proxy, and device
   authorization secrets locally.
3. Gateway receives and persists only SHA-256 digests plus sanitized pairing
   metadata.
4. The device shows a display-only user code. An administrator compares and
   approves that code in `/agents`.
5. Approval atomically persists one dynamic endpoint. The waiting device
   receives only the endpoint ID and proxy URL; it already owns the raw tokens.
6. The local installer stores the credentials in the existing protected
   `0600` config, registers Work Map MCP, and starts the outbound Connector.

Static Master and legacy endpoints remain environment-configured. The pairing
state file stores only dynamic teammate endpoints and pairing metadata, so an
old persisted value cannot silently override a rotated static endpoint.

The Work Map proxy accepts only the paired endpoint's distinct proxy token and
uses the shared upstream Work Map key server-side. This supplies immediate
per-device revocation without changing the Work Map V1 domain or database.

## Consequences

- Teammate onboarding becomes one Codex instruction plus one admin approval;
  no secret file, token copy, SSH access, or Gateway restart is required.
- Gateway restart preserves approved paired endpoints and pending decisions.
- Raw teammate credentials are absent from Gateway state, API responses, and
  admin UI.
- Gateway now holds the Work Map upstream key when pairing is enabled, which
  increases its compromise blast radius. Deployments that require strict
  separation should keep pairing disabled until Work Map gains native
  per-agent authorization.
- Presence and in-flight jobs remain intentionally memory-only. Pairing does
  not create a durable remote execution queue or attach to the foreground
  Codex chat.
- Keychain integration, Windows services, SSO, and multi-replica coordination
  remain out of scope until a demonstrated need justifies their complexity.
