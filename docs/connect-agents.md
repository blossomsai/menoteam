# Connect existing agents to Work Map

This is the smallest V1 connection path for teams that already use an agent
harness and a native Slack or Discord channel. It is intentionally not a
runner, bridge, channel bot, or control plane.

```text
Slack/Discord <-> native harness gateway <-> existing agent
                                           \
                                            HTTPS Streamable HTTP
                                             \
                                      Work Map MCP service
```

The Work Map service owns only the shared Work Map. The native harness owns
Discord credentials, channel delivery, sessions, and agent execution. Each
trusted agent receives the same instance-level MCP bearer capability in V1;
this is a soft trusted-team boundary, not actor-level authorization.

## Current local inventory

Checked on 2026-08-28 in this checkout. The probe recorded executable presence,
version/help output, and config-directory presence only. It did not print
credential values, token files, message history, or private configuration.

| Harness | Local result | Relevant upstream capability | What remains operator-owned |
| --- | --- | --- | --- |
| Hermes Agent | v0.20.6 installed; Work Map remote MCP discovers all six tools; local Codex MCP and the Master Skill are enabled | Native Discord gateway and remote HTTP MCP client; MCP tools are discovered and exposed to platform toolsets | Add `DISCORD_BOT_TOKEN`, bind the selected channel to the Skill's frontmatter name `master` with the strict channel policy, add guild/channel/user allowlists, then prove one explicit mention/reply |
| pi agent | `pi` not found; `~/.pi` absent | Use the generic path when the installed Pi release exposes MCP, Skills, and a native channel gateway | Install/configure Pi and repeat the same MCP read plus native channel mention/reply proof |
| OpenClaw | `openclaw` not found; `~/.openclaw` absent | Native Discord gateway; MCP client registry for Streamable HTTP; local `SKILL.md` install | Install OpenClaw, configure Discord bot/pairing/allowlists, install the Skill, and inject the Work Map key |
| Codex CLI | Present at `/Applications/ChatGPT.app/Contents/Resources/codex`; `work-map` is registered as Streamable HTTP and a direct authenticated `list` completed | `codex mcp` supports remote Streamable HTTP and bearer-token env vars; `/mcp` shows connections | Inject `WORK_MAP_MCP_API_KEY` into each Codex process and install the appropriate Skill; Codex has no Discord gateway in this local capability set |
| Discord | New `Menoteam Master` application exists (`1542758028955095120`); bot token, server install, and native reply are still pending | Discord Developer Portal + Gateway are the native integration surface | Create/configure the bot under this new application, enable the required intent, install it with least privilege, set the token and allowlists, then run the native mention/reply proof |

These results are a local 2026-08-28 smoke test, not a portable credential
bundle. No token value is documented here. A different host must repeat MCP
discovery and native Discord delivery proof.

Copyable, credential-free config examples live in
[`examples/mcp/`](../examples/mcp/). They are templates, not proof that a
service or Discord route exists: `codex-work-map.toml`,
`hermes-work-map.yaml`, `hermes-discord-work-map.yaml`, and
`openclaw-work-map.json5`. A Master does not need a teammate record; use the
separate [`master-onboarding.env.example`](../examples/master-onboarding.env.example)
for its MCP preflight.

The preflight accepts `hermes`, `openclaw`, `codex`, `pi`, or `other`. The last
two use a generic path: the harness must natively load a `SKILL.md`, connect to
the Streamable HTTP MCP endpoint, and (for a channel workflow) receive and
reply to an explicit mention. The preflight can verify shared MCP access but
does not pretend to verify an unknown harness's private config or credentials.

## Master onboarding

Master is a harness role, not a teammate or human owner. It therefore needs no
`WORK_MAP_TEAMMATE_REF` or `WORK_MAP_AGENT_ADDRESS`. Copy the credential-free
template, fill the endpoint and harness-owned route fields, inject the MCP key
through the harness secret mechanism, and run:

```bash
cp examples/master-onboarding.env.example /tmp/menoteam-master.env
set -a
. /tmp/menoteam-master.env
set +a
export WORK_MAP_MCP_API_KEY='read-this-from-your-secret-manager'
pnpm onboarding:check
```

For `WORK_MAP_CHANNEL=none`, this proves that Master can read the shared Work
Map through authenticated MCP. For `discord` or `slack`, it additionally checks
the explicit `@Master` activation rule where possible, while the selected
native harness remains responsible for channel credentials, allowlists, and
the real mention/reply proof. Install `skills/master/SKILL.md` in that
harness's trusted Skill location before starting its channel gateway.

## Copy/paste teammate preflight

The repository includes one credential-safe preflight. It does not install a
harness, write a teammate, send a Discord message, or claim that a Discord
route works. It checks local values without printing them, the selected native
harness/config, the remote `/healthz`, authenticated MCP initialize and
`tools/list`, and a read-only `read` of the supplied teammate record. For
Hermes/Discord it also checks the selected `DISCORD_CHANNEL_ID` is
explicitly allowlisted and bound to the `master` Skill in
`discord.channel_skill_bindings`, with both mention gates, disabled history
backfill, inline delivery, disabled reactions, and multi-agent bot mention
guards enabled.

On the teammate host:

```bash
cp examples/agent-onboarding.env.example /tmp/menoteam-agent.env
```

Edit only the non-secret route fields in that temporary file, then load it and
inject the real Work Map key through the host's secret manager. For a shell
session, the shape is:

```bash
set -a
. /tmp/menoteam-agent.env
set +a
export WORK_MAP_MCP_API_KEY='read-this-from-your-secret-manager'
pnpm onboarding:check
```

Replace all template placeholders before running. The literal key above is
only a secret-manager reminder, not a usable credential. The script exits non-zero
when a required local, harness, MCP, or teammate-route prerequisite is absent;
`--no-network` is available only for local template checks. Use
`pnpm onboarding:check -- --self-test` to verify the script itself.

For a Discord agent, the native harness must already have its bot secret and
least-privilege guild/channel/user allowlists. Keep `WORK_MAP_MASTER_MENTION`
exactly `@Master`; activation is explicit, never passive channel monitoring.
The final acceptance proof remains one real `@Master` mention and one default-
agent mention answered by the native gateway in the original Discord thread.
The preflight deliberately reports that proof as operator-owned instead of
accepting a self-attested flag.

## Required service setup

An operator must first deploy the same Apache-2.0 Work Map artifact with
PostgreSQL, TLS, migrations, and a public or privately reachable endpoint such
as:

```text
https://team.example.com/mcp
```

Set `MCP_API_KEY` on the service and keep the value in a secret manager or
process environment. The service must expose the six V1 MCP tools: `list`,
`search`, `read`, `create_work`, `update_work`, and `update_teammate`.

On each trusted agent host, provide the same key under an environment variable
such as `WORK_MAP_MCP_API_KEY`; do not commit it in a config file or paste it
into a prompt. Validate with a read-only `list` or `search` before attempting a
write. A successful HTTP response alone is not proof that the native Discord
route can receive and reply to a mention; test both surfaces separately.

There are two independent proofs:

1. **Work Map is reachable:** the deployed `/healthz` is healthy, the remote
   MCP handshake succeeds, and an authenticated agent can `list`/`search` and
   `read` shared context. Source files or a local process are not deployment
   proof.
2. **Discord is native and reachable:** the selected Hermes/OpenClaw gateway
   receives an explicit mention and replies in the same Discord thread. MCP
   reachability does not imply this, and a successful Discord bot login does
   not prove that Work Map MCP is configured.

For a Codex-only/local workflow, proof 1 is sufficient; Codex has no proven
native Discord wake path in this setup. For a Discord workflow, both proofs are
required. Work Map cannot fill the missing Discord proof with a runner, bridge,
or bot.

## Harness setup

### Codex

Codex is the most direct local path in this environment:

```bash
export WORK_MAP_MCP_API_KEY='set-this-outside-the-repo'
codex mcp add work-map \
  --url https://team.example.com/mcp \
  --bearer-token-env-var WORK_MAP_MCP_API_KEY
codex mcp list
```

The placeholder above is not a real credential. Use the host's secret
injection mechanism instead. The same Codex MCP configuration is shared by the
Codex CLI, desktop app, and IDE extension on that host. Install `skills/master`
only on the Master agent and `skills/team-agent` on each default team agent in
the Codex skill search path, then restart/reload the client as required by the
host.

Codex is an agent client, not a Discord gateway. A separate Hermes or OpenClaw
agent must own the Discord-native Master/default-agent address if humans are to
reach that agent from Discord.

### Hermes Agent

Hermes supports a remote HTTP MCP server in `~/.hermes/config.yaml`. Keep the
key in Hermes' environment (or its supported `.env` secret path), and use
runtime substitution rather than a literal value:

```yaml
mcp_servers:
  work_map:
    url: "https://team.example.com/mcp"
    headers:
      Authorization: "Bearer ${WORK_MAP_MCP_API_KEY}"
```

After starting or reloading Hermes, run `hermes mcp test work_map` (or the
equivalent current release command) and make a read-only Work Map call. Install
the reviewed Skill as a real file inside Hermes' trusted skill root:

```bash
install -d "$HOME/.hermes/skills/master"
install -m 0644 skills/master/SKILL.md "$HOME/.hermes/skills/master/SKILL.md"
hermes skills list
```

For a default teammate agent, use `skills/team-agent/SKILL.md` and the
`$HOME/.hermes/skills/team-agent/` destination instead. Do not symlink either
Skill to a path outside the trusted root: Hermes resolves the real path and may
refuse to preload it. Re-copy the reviewed file when upgrading Menoteam.

For Discord, configure Hermes' native gateway and require explicit mentions in
server channels. Threads should reply in the same thread. At gateway start,
merge the exact [Hermes Discord binding template](../examples/mcp/hermes-discord-work-map.yaml), replace its selected channel ID, and keep
`require_mention: true`, `thread_require_mention: true`, and
`history_backfill: false`. The last setting prevents unmentioned channel
history from being pulled into a triggered agent context. Bind `master`, the
name declared in this repository's Skill frontmatter; a symlink or directory
named `work-map-master` does not change that registered name. Do not rely on
skill auto-selection or a slash command. Register the resulting default-agent
Discord address in the teammate record; Master is not a teammate owner and
does not need that record.

Keep the bot's environment policy aligned with the template. `allow_bots` is a
native environment setting in this Hermes Discord release, so place it in
Hermes' supported `.env`/secret path rather than in `config.yaml`:

```dotenv
DISCORD_ALLOW_BOTS=mentions
```

The template's `bots_require_inline_mention: true` closes the reply-ping loop:
another bot must literally include the Master bot's inline mention to wake it.
Keep `allowed_channels` limited to the selected channel ID, `auto_thread: false`,
and `reactions: false`; these avoid accidental channel fan-out, extra thread
creation, and lifecycle-message noise. The preflight rejects environment
overrides that weaken these settings.

### OpenClaw

OpenClaw has two distinct MCP paths. For a Work Map agent run, configure it as
an outbound Streamable HTTP server; `openclaw mcp serve` is instead the path
that exposes OpenClaw's already-routed channel conversations to another MCP
client.

The canonical server shape is:

```json5
{
  mcp: {
    servers: {
      workMap: {
        url: "https://team.example.com/mcp",
        transport: "streamable-http",
        headers: {
          Authorization: "Bearer ${WORK_MAP_MCP_API_KEY}",
        },
      },
    },
  },
}
```

Keep `WORK_MAP_MCP_API_KEY` in the gateway process environment or
`~/.openclaw/.env`, run `openclaw mcp doctor workMap --probe`, and confirm the
tool list before using writes. If OpenClaw is daemon-managed, verify that the
daemon receives the environment after installation/restart; otherwise an
interpolation may remain unresolved. Never replace the placeholder with a
committed bearer token.

Install the local Skill with OpenClaw's native path, for example:

```bash
openclaw skills install /absolute/path/to/menoteam/skills/master --global
```

Use the equivalent `team-agent` path for default agents and narrow visibility
with the OpenClaw per-agent skill allowlist when needed. Configure Discord
through the native OpenClaw gateway, pairing and guild/channel allowlists, and
keep `requireMention: true` for Work Map's explicit activation rule.

### pi agent

Use `WORK_MAP_HARNESS=pi` with the generic preflight path. Pi must provide its
own native MCP client and channel gateway; Menoteam deliberately provides no
compatibility adapter or fallback bridge. If the installed Pi release cannot
satisfy both boundaries, use Hermes, OpenClaw, or another harness that can.

### Any other MCP/Skill harness

Use `WORK_MAP_HARNESS=other` when the harness is not one of the named paths.
Install `skills/master/SKILL.md` (or `skills/team-agent/SKILL.md`) through its
trusted native Skill mechanism, configure the credential-free MCP shape from
[`examples/mcp/`](../examples/mcp/), and inject the real key through the
harness's secret store. If it owns a native Slack or Discord gateway, keep
explicit `@Master` activation and prove the reply in the originating thread.
The generic preflight reports native channel setup as operator-owned; it does
not make an unsupported harness appear supported.

## Native Discord setup

Discord setup cannot be completed automatically from this repository. For each
native harness, an operator must:

1. Create a Discord application and bot in the Developer Portal.
2. Invite it to a private test server with only the permissions it needs:
   view channels, read history, send messages, and thread replies where used.
3. Configure Gateway intents required by the selected harness. Hermes v0.20.6
   requests Discord's privileged Message Content Intent even with explicit
   mentions, so enable it for that native gateway. Server Members intent is not
   required by this binding when numeric allowlists are used. Explicit bot
   mentions remain the narrowest V1 trigger.
4. Configure the harness's user/guild/channel allowlists and test one explicit
   `@Master` mention and one default-agent mention in the original channel. For
   Hermes, use the strict policy in the binding template and keep
   `DISCORD_ALLOW_BOTS=mentions` with `bots_require_inline_mention: true`.
5. For a default team agent, record only its platform-specific agent address
   (not a bot token) in the appropriate teammate record through the Work Map
   MCP tool. Master is not a teammate owner and does not need a teammate
   record.

The Work Map service never stores Discord tokens, posts Discord messages, reads
channel history, or awakens an agent. Native harnesses emit replies and
mentions; the Skills decide when those mentions are appropriate.

## What this path does not automate

- Work Map deployment, PostgreSQL, DNS/TLS, backups, or `MCP_API_KEY` issuance.
- Hermes, pi, OpenClaw, or Discord installation.
- Discord Developer Portal application creation, bot tokens, OAuth invite,
  Gateway intents, pairing, allowlists, or channel permissions.
- Model-provider login or repository/document permissions.
- Per-agent authorization: V1 intentionally uses one trusted-team MCP key.
- Agent awakening, scheduling, execution, supervision, completion tracking, or
  transcript ingestion.

If any of those prerequisites is missing, report it as a setup blocker instead
of claiming that the Work Map connection is complete.

## Primary references

- [Work Map V1 spec](work-map-v1-spec.md) and [canonical domain language](../CONTEXT.md)
- [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)
- [Hermes Discord](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/discord.md)
- [Hermes Skills CLI](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)
- [Pi](https://pi.dev/)
- [OpenClaw MCP](https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md)
- [OpenClaw Skills](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md)
- [OpenClaw Discord](https://github.com/openclaw/openclaw/blob/main/docs/channels/discord.md)
- [Codex MCP](https://developers.openai.com/codex/extend/mcp)
- [Discord bots](https://docs.discord.com/developers/bots/overview), [Gateway](https://docs.discord.com/developers/events/gateway), and [OAuth2/permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
