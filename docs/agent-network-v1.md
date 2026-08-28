# Menoteam Agent Network quickstart

The default network uses one Slack app, one central Gateway, one always-on
Hermes Master, and opt-in Codex Connectors on colleague computers.

```text
                                          always-on Master computer
Slack @Master -> one Slack app -> Gateway -> Hermes Connector -> Hermes Master
                                      |             |              |
                                      |             |              +-> existing memory, tools, skills
                                      |             +-----------------> Work Map + Agent Gateway MCP
                                      |
                                      +-> Alice Connector -> Alice's linked Codex task
                                      +-> Bob Connector   -> Bob's linked Codex task
                                      +-> labeled replies return to the same Slack thread
```

`MASTER` and `Alice · Codex` are speaker labels inside messages, not separate
Slack apps. Only the central Gateway receives Slack credentials. Every local
Connector makes outbound HTTPS requests, opens no inbound port, and receives a
different revocable endpoint token.

## Boundaries

| Role | Runs where | Receives |
| --- | --- | --- |
| Operator | Always-on Menoteam server | Slack credentials and endpoint registry |
| Master | Separate always-on computer | Hermes profile, Master endpoint token, Master MCP key, Work Map key |
| Teammate | Each colleague's Codex computer | That colleague's endpoint token and Work Map key |

Do not run Master on a laptop that frequently sleeps. Installing the Codex
plugin does not make a computer Master; the role comes from its one-time
handoff file.

## 1. Operator: deploy Gateway beside Work Map

Work Map and Gateway belong to the same Menoteam project, but remain separate
services: Work Map stores durable shared context; Gateway owns Slack delivery
and short-lived online presence.

Create `.env.gateway` from
[`examples/agent-gateway.env.example`](../examples/agent-gateway.env.example).
Configure one Slack app with:

- Event Subscription URL: `https://agents.example.com/slack/events`
- Bot event: `app_mention`
- Bot scopes: `app_mentions:read`, `chat:write`
- explicit Slack user and channel ID allowlists in `.env.gateway`

Keep the Slack bot token and signing secret only on this server. Expose Gateway
through the existing HTTPS reverse proxy; its Compose port is loopback-only.

## 2. Operator: create the Hermes Master handoff

Run from a reviewed Menoteam checkout on the server. `--work-map-env` points to
the existing Work Map secret file; its MCP key is copied into the one-time
handoff but never printed.

```bash
./scripts/gateway-admin-docker.sh add \
  --env /absolute/path/to/menoteam/.env.gateway \
  --id master-hermes \
  --label MASTER \
  --role master \
  --harness hermes \
  --gateway-url https://agents.example.com \
  --work-map-url https://team.example.com/mcp \
  --work-map-env /absolute/path/to/menoteam/.env \
  --output /absolute/path/to/menoteam/handoffs/master-hermes.env
```

This creates three separate capabilities:

- the Gateway stores only the SHA-256 digest of the endpoint token;
- the handoff contains the raw endpoint token and Master-only routing key;
- the handoff also contains the Work Map key shared by trusted team agents.

Apply the registry:

```bash
docker compose -p menoteam --env-file .env.gateway \
  -f docker-compose.gateway.yml up -d --build gateway
```

Transfer `master-hermes.env` through an approved secret channel. Delete both
transfer copies after Master setup succeeds.

## 3. Master computer: install Hermes Master once

Use a separate always-on macOS or Linux computer. First install and configure
Hermes with the model provider and local tools you actually want this Master to
inherit. Do **not** configure Hermes' native Slack integration: Menoteam Gateway
is the only Slack owner.

Clone Menoteam and the repository Master should work from, then run:

```bash
/absolute/path/to/menoteam/connectors/hermes/setup.sh install \
  --config /secure/path/master-hermes.env \
  --repository-cwd /absolute/path/to/team-repository
```

The installer:

- installs the trusted `menoteam-master` Hermes Skill;
- configures Work Map MCP and the Master-only Agent Gateway MCP;
- explicitly disables Hermes native Slack;
- generates a local-only Hermes API key and binds its API to `127.0.0.1`;
- creates one background service that supervises Hermes Gateway/API and the
  Menoteam Connector;
- uses one persistent named Hermes conversation for all Slack Master turns.

The local API key never reaches central Gateway. The Hermes process keeps its
own profile, memory, tools, skills, provider configuration, and repository
context. It is not a copy of another computer's Hermes state.

Check the full local boundary:

```bash
/absolute/path/to/menoteam/connectors/hermes/setup.sh status \
  --endpoint master-hermes
```

Expected: `service-running` and `api-ready`.

If another service already owns this Hermes Gateway/API, install with
`--manage-hermes-gateway false`; that operator-managed process must expose the
same loopback API URL and key. The default managed mode is simpler.

## 4. Operator: create one handoff per Codex teammate

```bash
./scripts/gateway-admin-docker.sh add \
  --env /absolute/path/to/menoteam/.env.gateway \
  --id alice-codex \
  --label "Alice · Codex" \
  --role teammate \
  --harness codex \
  --gateway-url https://agents.example.com \
  --work-map-url https://team.example.com/mcp \
  --work-map-env /absolute/path/to/menoteam/.env \
  --output /absolute/path/to/menoteam/handoffs/alice-codex.env
```

Restart Gateway, then send only `alice-codex.env` to Alice.

## 5. Teammate: install the Codex Connector

Alice installs the same plugin from a reviewed checkout:

```bash
codex plugin marketplace add /absolute/path/to/menoteam
codex plugin add menoteam-agent@blossomsai
```

In a new Codex task, Alice can say:

```text
Use the Menoteam Agent skill to install this computer from
/secure/path/alice-codex.env. Link it to the current repository.
```

Equivalent manual command:

```bash
/absolute/path/to/menoteam/plugins/menoteam-agent/scripts/setup.sh install \
  --config /secure/path/alice-codex.env \
  --repository-cwd /absolute/path/to/repository
```

The setup registers Work Map MCP and creates a background LaunchAgent or
systemd service. A teammate handoff is rejected if it contains the Master MCP
key. Delete the handoff after status succeeds.

This Connector resumes one dedicated linked Codex task. It uses that host's
Codex account, configuration, MCP registrations, skills, repository
instructions, and permitted environment, but it does **not** attach to the
currently visible Desktop chat or inherit unsaved UI state.

Repeat with a unique endpoint ID and token for each colleague. There is still
only one Slack app.

## 6. Use it in Slack

1. An allowlisted person mentions the one Slack bot in an allowlisted channel.
2. Gateway wakes `master-hermes`.
3. Hermes Master reads Work Map and answers directly when possible.
4. If one precise fact is missing, Master selects one online teammate endpoint
   and routes one request using the exact current Slack thread metadata.
5. Gateway posts `MASTER` and teammate-labeled replies into that same thread.

V1 deliberately allows only one routing hop. It does not create an autonomous
agent group chat, expose private transcripts, or give Master arbitrary remote
control of colleague computers.

## Operations

List endpoints without exposing token hashes:

```bash
./scripts/gateway-admin-docker.sh list --env /absolute/path/to/menoteam/.env.gateway
```

Rotate an endpoint after a lost handoff or computer move:

```bash
./scripts/gateway-admin-docker.sh rotate \
  --env /absolute/path/to/menoteam/.env.gateway \
  --id alice-codex \
  --gateway-url https://agents.example.com \
  --work-map-url https://team.example.com/mcp \
  --work-map-env /absolute/path/to/menoteam/.env \
  --output /absolute/path/to/menoteam/handoffs/alice-codex-new.env
```

Restart Gateway immediately after rotation. Rotating Master also rotates the
Master MCP key.

Revoke a teammate and restart Gateway:

```bash
./scripts/gateway-admin-docker.sh revoke \
  --env /absolute/path/to/menoteam/.env.gateway \
  --id alice-codex
```

Remove a local teammate Connector:

```bash
/absolute/path/to/menoteam/plugins/menoteam-agent/scripts/setup.sh uninstall \
  --endpoint alice-codex
```

Remove a local Hermes Master Connector without deleting Hermes memory or its
reusable Skill:

```bash
/absolute/path/to/menoteam/connectors/hermes/setup.sh uninstall \
  --endpoint master-hermes
```

The active Master cannot be revoked until a replacement Master is added.

## Current truth, not future promises

- Hermes Master and Codex teammate adapters are implemented.
- Claude teammate routing is **not implemented yet**. The Gateway protocol is
  small enough to add it later, but registering fake Claude endpoints would be
  misleading.
- Gateway presence and in-flight jobs are memory-only. A sleeping or offline
  computer is unavailable; there is no hidden durable execution queue.
- The central server stores no agent transcript. Hermes and Codex retain their
  own local session state.

## Acceptance proof

Verify each boundary separately:

1. Gateway `/healthz` reports `menoteam-agent-gateway` over HTTPS.
2. Slack accepts the signed Event Subscriptions URL.
3. Master status shows `service-running` and `api-ready`.
4. Master lists itself and one teammate as online.
5. One allowlisted mention receives a `MASTER` reply in the same thread.
6. Master routes one harmless read-only question and the teammate's labeled
   reply returns to that thread.
7. A wrong token, duplicate connector, non-allowlisted user/channel,
   cross-endpoint reply, offline endpoint, and second routing hop fail safely.
