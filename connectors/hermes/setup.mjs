#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './connector.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_FILE);
const SOURCE_CONNECTOR = join(SCRIPT_DIR, 'connector.mjs');
const SOURCE_SKILL = resolve(SCRIPT_DIR, '..', '..', 'plugins', 'menoteam-agent', 'skills', 'menoteam-master', 'SKILL.md');
const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;

export function parseHandoff(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) throw new Error(`Duplicate ${match[1]} in handoff file`);
    values[match[1]] = parseEnvValue(match[2].trim());
  }
  return values;
}

export function sanitizedConfig(values, { hermesPath }) {
  const config = configFromEnv(values);
  const apiUrl = new URL(config.hermesApiUrl);
  const allowed = {
    MENOTEAM_GATEWAY_URL: config.gatewayUrl,
    MENOTEAM_AGENT_ENDPOINT: config.endpointId,
    MENOTEAM_AGENT_TOKEN: config.token,
    MENOTEAM_AGENT_ROLE: config.role,
    MENOTEAM_AGENT_HARNESS: config.harness,
    MENOTEAM_MASTER_MCP_KEY: config.masterKey,
    MENOTEAM_REPOSITORY_CWD: config.repositoryCwd,
    WORK_MAP_MCP_URL: config.workMapUrl,
    WORK_MAP_MCP_API_KEY: config.workMapKey,
    HERMES_BIN: hermesPath,
    MENOTEAM_HERMES_API_URL: config.hermesApiUrl,
    MENOTEAM_HERMES_CONVERSATION: config.conversation,
    MENOTEAM_MANAGE_HERMES_GATEWAY: String(config.manageHermesGateway),
    API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: apiUrl.hostname.replace(/^\[(.*)\]$/u, '$1'),
    API_SERVER_PORT: apiUrl.port || '80',
    API_SERVER_KEY: config.hermesApiKey,
  };
  if (config.profile) allowed.MENOTEAM_HERMES_PROFILE = config.profile;
  return { config, contents: `${Object.entries(allowed).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n')}\n` };
}

export function renderLaunchAgent({ label, configPath, nodePath, connectorPath, repositoryCwd, stdoutPath, stderrPath }) {
  const args = ['/bin/sh', '-c', 'set -a; . "$1"; set +a; exec "$2" "$3"', 'menoteam-hermes', configPath, nodePath, connectorPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>${args.map((value) => `\n    <string>${xmlEscape(value)}</string>`).join('')}\n  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(repositoryCwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit({ configPath, nodePath, connectorPath, repositoryCwd, systemService = false }) {
  return `[Unit]
Description=Menoteam Hermes Master Connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${systemdQuote(configPath)}
WorkingDirectory=${systemdQuote(repositoryCwd)}
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(connectorPath)}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=${systemService ? 'multi-user.target' : 'default.target'}
`;
}

export async function installHermesMaster(options, runtime = {}) {
  const platformName = runtime.platform ?? platform();
  if (platformName !== 'darwin' && platformName !== 'linux') throw new Error('Automatic background setup currently supports macOS and Linux');
  const handoffPath = resolve(requiredOption(options, 'config'));
  const handoff = parseHandoff(await readFile(handoffPath, 'utf8'));
  handoff.MENOTEAM_REPOSITORY_CWD = resolve(options['repository-cwd'] || handoff.MENOTEAM_REPOSITORY_CWD || process.cwd());
  if (options['hermes-profile']) handoff.MENOTEAM_HERMES_PROFILE = options['hermes-profile'];
  const endpointId = handoff.MENOTEAM_AGENT_ENDPOINT;
  validateEndpointId(endpointId);
  const preliminaryPaths = hermesPaths(endpointId, { platformName, home: runtime.home, hermesHome: runtime.hermesHome });
  const existing = await readFile(preliminaryPaths.config, 'utf8').then(parseHandoff).catch((error) => {
    if (error?.code === 'ENOENT') return {};
    throw error;
  });
  handoff.MENOTEAM_HERMES_API_URL = options['hermes-api-url'] || handoff.MENOTEAM_HERMES_API_URL || existing.MENOTEAM_HERMES_API_URL || 'http://127.0.0.1:8642';
  handoff.MENOTEAM_MANAGE_HERMES_GATEWAY = options['manage-hermes-gateway'] || handoff.MENOTEAM_MANAGE_HERMES_GATEWAY || existing.MENOTEAM_MANAGE_HERMES_GATEWAY || 'true';
  handoff.MENOTEAM_HERMES_CONVERSATION = handoff.MENOTEAM_HERMES_CONVERSATION || existing.MENOTEAM_HERMES_CONVERSATION || `menoteam:${endpointId}`;
  handoff.API_SERVER_KEY = existing.API_SERVER_KEY || randomBytes(32).toString('base64url');
  const hermesPath = runtime.hermesPath ?? await findExecutable(handoff.HERMES_BIN || 'hermes');
  const nodePath = runtime.nodePath ?? process.execPath;
  const { config, contents } = sanitizedConfig(handoff, { hermesPath });
  const repository = await stat(config.repositoryCwd).catch(() => null);
  if (!repository?.isDirectory()) throw new Error('MENOTEAM_REPOSITORY_CWD must be an existing directory');
  await Promise.all([
    access(nodePath, constants.X_OK),
    access(hermesPath, constants.X_OK),
    access(SOURCE_CONNECTOR, constants.R_OK),
    access(SOURCE_SKILL, constants.R_OK),
  ]);
  if (!runtime.skipCommands) probeHermesCli(hermesPath, config.profile);

  const hermesHome = runtime.hermesHome ?? dirname(runCapture(hermesPath, [...profileArgs(config.profile), 'config', 'path']).trim());
  if (!hermesHome) throw new Error('Hermes config path could not be resolved');
  const paths = hermesPaths(config.endpointId, { platformName, home: runtime.home, hermesHome });
  await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.config), 0o700);
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.connector), { recursive: true, mode: 0o700 });
  await mkdir(dirname(paths.skill), { recursive: true, mode: 0o700 });
  await atomicWrite(paths.config, contents, 0o600);
  await atomicWrite(paths.connector, await readFile(SOURCE_CONNECTOR), 0o700);
  await atomicWrite(paths.skill, await readFile(SOURCE_SKILL), 0o600);

  if (!runtime.skipCommands) configureHermes(hermesPath, config);

  if (platformName === 'darwin') {
    await mkdir(dirname(paths.service), { recursive: true, mode: 0o700 });
    await atomicWrite(paths.service, renderLaunchAgent({
      label: paths.label,
      configPath: paths.config,
      nodePath,
      connectorPath: paths.connector,
      repositoryCwd: config.repositoryCwd,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
    }), 0o644);
    if (!runtime.skipCommands) {
      const domain = `gui/${process.getuid()}`;
      runQuiet('launchctl', ['bootout', domain, paths.service], { allowFailure: true });
      run('launchctl', ['bootstrap', domain, paths.service]);
      run('launchctl', ['kickstart', '-k', `${domain}/${paths.label}`]);
    }
  } else {
    await mkdir(dirname(paths.service), { recursive: true, mode: paths.systemService ? 0o755 : 0o700 });
    await atomicWrite(paths.service, renderSystemdUnit({
      configPath: paths.config,
      nodePath,
      connectorPath: paths.connector,
      repositoryCwd: config.repositoryCwd,
      systemService: paths.systemService,
    }), 0o644);
    if (!runtime.skipCommands) {
      const prefix = paths.systemService ? [] : ['--user'];
      run('systemctl', [...prefix, 'daemon-reload']);
      run('systemctl', [...prefix, 'enable', '--now', paths.unit]);
    }
  }
  return { ...paths, endpointId: config.endpointId, role: config.role, harness: config.harness, handoffPath };
}

export async function statusHermesMaster(options, runtime = {}) {
  const endpointId = requiredOption(options, 'endpoint');
  validateEndpointId(endpointId);
  const platformName = runtime.platform ?? platform();
  const paths = hermesPaths(endpointId, { platformName, home: runtime.home, hermesHome: runtime.hermesHome });
  const values = await readInstalledConfig(paths.config, endpointId);
  let active = false;
  if (!runtime.skipCommands && platformName === 'darwin') {
    active = runQuiet('launchctl', ['print', `gui/${process.getuid()}/${paths.label}`], { allowFailure: true }).status === 0;
  } else if (!runtime.skipCommands && platformName === 'linux') {
    const prefix = paths.systemService ? [] : ['--user'];
    active = runQuiet('systemctl', [...prefix, 'is-active', '--quiet', paths.unit], { allowFailure: true }).status === 0;
  }
  const apiReady = runtime.skipCommands ? false : await hermesApiReady(values);
  return { endpointId, role: 'master', harness: 'hermes', active, apiReady, config: paths.config, service: paths.service };
}

export async function uninstallHermesMaster(options, runtime = {}) {
  const endpointId = requiredOption(options, 'endpoint');
  validateEndpointId(endpointId);
  const platformName = runtime.platform ?? platform();
  const paths = hermesPaths(endpointId, { platformName, home: runtime.home, hermesHome: runtime.hermesHome });
  await readInstalledConfig(paths.config, endpointId);
  if (!runtime.skipCommands && platformName === 'darwin') {
    runQuiet('launchctl', ['bootout', `gui/${process.getuid()}`, paths.service], { allowFailure: true });
  } else if (!runtime.skipCommands && platformName === 'linux') {
    const prefix = paths.systemService ? [] : ['--user'];
    runQuiet('systemctl', [...prefix, 'disable', '--now', paths.unit], { allowFailure: true });
  }
  await Promise.all([paths.service, paths.config, paths.state, paths.lock, paths.stdout, paths.stderr, paths.connector].map((path) => unlink(path).catch(() => undefined)));
  if (!runtime.skipCommands && platformName === 'linux') {
    const prefix = paths.systemService ? [] : ['--user'];
    runQuiet('systemctl', [...prefix, 'daemon-reload'], { allowFailure: true });
  }
  return { endpointId, role: 'master', harness: 'hermes' };
}

export function hermesPaths(endpointId, { platformName = platform(), home = homedir(), uid = process.getuid?.(), hermesHome = join(home, '.hermes') } = {}) {
  validateEndpointId(endpointId);
  const stateDir = join(home, '.local', 'state', 'menoteam-hermes');
  const systemService = platformName === 'linux' && uid === 0;
  const label = `ai.menoteam.hermes.${endpointId}`;
  const unit = `menoteam-hermes-${endpointId}.service`;
  return {
    label,
    unit,
    systemService,
    config: join(home, '.config', 'menoteam-hermes', `${endpointId}.env`),
    stateDir,
    state: join(stateDir, `${endpointId}.json`),
    lock: join(stateDir, `${endpointId}.json.lock`),
    stdout: join(stateDir, `${endpointId}.out.log`),
    stderr: join(stateDir, `${endpointId}.err.log`),
    connector: join(home, '.local', 'share', 'menoteam-hermes', 'connector.mjs'),
    skill: join(hermesHome, 'skills', 'menoteam-master', 'SKILL.md'),
    service: platformName === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', `${label}.plist`)
      : systemService ? join('/etc/systemd/system', unit) : join(home, '.config', 'systemd', 'user', unit),
  };
}

function configureHermes(hermesPath, config) {
  const prefix = profileArgs(config.profile);
  const env = {
    ...process.env,
    MENOTEAM_MASTER_MCP_KEY: config.masterKey,
    WORK_MAP_MCP_API_KEY: config.workMapKey,
  };
  const settings = [
    ['platforms.slack.enabled', 'false'],
    ['mcp_servers.work_map.url', config.workMapUrl],
    ['mcp_servers.work_map.headers.Authorization', 'Bearer ${WORK_MAP_MCP_API_KEY}'],
    ['mcp_servers.work_map.tools.include', '["list","search","read","create_work","update_work","update_teammate"]'],
    ['mcp_servers.work_map.tools.prompts', 'false'],
    ['mcp_servers.work_map.tools.resources', 'false'],
    ['mcp_servers.agent_gateway.url', `${config.gatewayUrl}/mcp`],
    ['mcp_servers.agent_gateway.headers.Authorization', 'Bearer ${MENOTEAM_MASTER_MCP_KEY}'],
    ['mcp_servers.agent_gateway.tools.include', '["list_agent_endpoints","send_agent_message"]'],
    ['mcp_servers.agent_gateway.tools.prompts', 'false'],
    ['mcp_servers.agent_gateway.tools.resources', 'false'],
  ];
  for (const [key, value] of settings) runQuiet(hermesPath, [...prefix, 'config', 'set', '--force', key, value], { env });
  runQuiet(hermesPath, [...prefix, 'mcp', 'test', 'work_map'], { env });
  runQuiet(hermesPath, [...prefix, 'mcp', 'test', 'agent_gateway'], { env });
}

function probeHermesCli(hermesPath, profile) {
  runQuiet(hermesPath, ['--version']);
  runQuiet(hermesPath, [...profileArgs(profile), 'gateway', '--help']);
}

async function hermesApiReady(values) {
  try {
    const config = configFromEnv(values);
    const response = await fetch(`${config.hermesApiUrl}/v1/capabilities`, {
      headers: { authorization: `Bearer ${config.hermesApiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    return Boolean((await response.json())?.features?.responses_api);
  } catch {
    return false;
  }
}

function profileArgs(profile) {
  return profile ? ['--profile', profile] : [];
}

async function findExecutable(name) {
  const candidates = name.includes('/') ? [name] : String(process.env.PATH || '').split(delimiter).filter(Boolean).map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return resolve(candidate); } catch { /* try next candidate */ }
  }
  throw new Error(`${name} executable was not found`);
}

async function atomicWrite(path, contents, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
  await chmod(path, mode);
}

async function readInstalledConfig(path, endpointId) {
  try { return parseHandoff(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`No local Menoteam Hermes Connector is installed for ${endpointId}`);
    throw error;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: options.env ?? process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed with exit code ${result.status ?? 'unknown'}`);
  return result;
}

function runQuiet(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'ignore', env: options.env ?? process.env });
  if (!options.allowFailure && (result.error || result.status !== 0)) throw result.error || new Error(`${basename(command)} failed`);
  return result;
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw result.error || new Error(`${basename(command)} failed`);
  return result.stdout;
}

function parseEnvValue(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/'\\''/gu, "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error('Invalid double-quoted handoff value'); }
  }
  return value.replace(/\s+#.*$/u, '');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function systemdQuote(value) {
  return `"${String(value).replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function validateEndpointId(id) {
  if (!ENDPOINT_PATTERN.test(String(id ?? ''))) throw new Error('Endpoint ID is invalid');
}

function requiredOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith('--') || args[index + 1] === undefined) throw new Error(`Invalid option: ${flag ?? ''}`);
    options[flag.slice(2)] = args[index + 1];
  }
  return { command, options };
}

function usage() {
  return [
    'Usage:',
    '  node setup.mjs install --config /secure/path/master-hermes.env [--repository-cwd /path/to/repo] [--hermes-profile name] [--hermes-api-url http://127.0.0.1:8642] [--manage-hermes-gateway true|false]',
    '  node setup.mjs status --endpoint master-hermes',
    '  node setup.mjs uninstall --endpoint master-hermes',
  ].join('\n');
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'install') {
    const result = await installHermesMaster(options);
    process.stdout.write(`Menoteam Hermes Master installed: ${result.endpointId}\nBackground Connector started. Delete the one-time handoff file after confirming status.\n`);
    return;
  }
  if (command === 'status') {
    const result = await statusHermesMaster(options);
    process.stdout.write(`${result.endpointId}\tmaster\thermes\t${result.active ? 'service-running' : 'service-stopped'}\t${result.apiReady ? 'api-ready' : 'api-not-ready'}\n`);
    return;
  }
  if (command === 'uninstall') {
    const result = await uninstallHermesMaster(options);
    process.stdout.write(`Removed local Menoteam Hermes Connector: ${result.endpointId}\nHermes itself, its memory, MCP config, and the installed Master skill were kept.\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Menoteam Hermes setup failed'}\n`);
    process.exitCode = 1;
  });
}
