#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './connector.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_FILE);
const CONNECTOR_FILE = join(SCRIPT_DIR, 'connector.mjs');
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

export function renderLaunchAgent({ label, configPath, nodePath, connectorPath, repositoryCwd, stdoutPath, stderrPath }) {
  const shellCommand = 'set -a; . "$1"; set +a; exec "$2" "$3"';
  const args = ['/bin/sh', '-c', shellCommand, 'menoteam-agent', configPath, nodePath, connectorPath];
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
Description=Menoteam Agent Connector
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

export function sanitizedConfig(values, { codexPath }) {
  const config = configFromEnv(values);
  const allowed = {
    MENOTEAM_GATEWAY_URL: config.gatewayUrl,
    MENOTEAM_AGENT_ENDPOINT: config.endpointId,
    MENOTEAM_AGENT_TOKEN: config.token,
    MENOTEAM_AGENT_ROLE: config.role,
    MENOTEAM_AGENT_HARNESS: config.harness,
    MENOTEAM_REPOSITORY_CWD: config.repositoryCwd,
    WORK_MAP_MCP_URL: config.workMapUrl,
    WORK_MAP_MCP_API_KEY: config.workMapKey,
    CODEX_BIN: codexPath,
  };
  const masterKey = values.MENOTEAM_MASTER_MCP_KEY;
  if (config.role === 'master') {
    if (!masterKey || masterKey.length < 32 || /replace|example/iu.test(masterKey)) throw new Error('MENOTEAM_MASTER_MCP_KEY is missing or invalid');
    allowed.MENOTEAM_MASTER_MCP_KEY = masterKey;
  } else if (masterKey) {
    throw new Error('A teammate handoff must not contain MENOTEAM_MASTER_MCP_KEY');
  }
  return { config, contents: `${Object.entries(allowed).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n')}\n` };
}

export async function installAgent(options, runtime = {}) {
  const platformName = runtime.platform ?? platform();
  if (platformName !== 'darwin' && platformName !== 'linux') throw new Error('Automatic background setup currently supports macOS and Linux');
  const handoffPath = resolve(requiredOption(options, 'config'));
  const handoff = parseHandoff(await readFile(handoffPath, 'utf8'));
  handoff.MENOTEAM_REPOSITORY_CWD = resolve(options['repository-cwd'] || handoff.MENOTEAM_REPOSITORY_CWD || process.cwd());
  const codexPath = runtime.codexPath ?? await findExecutable(handoff.CODEX_BIN || 'codex', codexFallbacks());
  const nodePath = runtime.nodePath ?? process.execPath;
  const { config, contents } = sanitizedConfig(handoff, { codexPath });
  const repository = await stat(config.repositoryCwd).catch(() => null);
  if (!repository?.isDirectory()) throw new Error('MENOTEAM_REPOSITORY_CWD must be an existing directory');
  await access(nodePath, constants.X_OK);
  await access(codexPath, constants.X_OK);
  await access(CONNECTOR_FILE, constants.R_OK);

  const paths = agentPaths(config.endpointId, { platformName, home: runtime.home });
  await mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.config), 0o700);
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await atomicWrite(paths.config, contents, 0o600);

  if (!runtime.skipCommands) {
    const connectorEnv = {
      ...process.env,
      WORK_MAP_MCP_API_KEY: config.workMapKey,
      MENOTEAM_MASTER_MCP_KEY: handoff.MENOTEAM_MASTER_MCP_KEY,
    };
    registerWorkMapMcp(codexPath, config.workMapUrl, connectorEnv);
    if (config.role === 'master') registerMasterMcp(codexPath, config.gatewayUrl, connectorEnv);
  }

  if (platformName === 'darwin') {
    const plist = renderLaunchAgent({
      label: paths.label,
      configPath: paths.config,
      nodePath,
      connectorPath: CONNECTOR_FILE,
      repositoryCwd: config.repositoryCwd,
      systemService: paths.systemService,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
    });
    await mkdir(dirname(paths.service), { recursive: true, mode: 0o700 });
    await atomicWrite(paths.service, plist, 0o644);
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
      connectorPath: CONNECTOR_FILE,
      repositoryCwd: config.repositoryCwd,
    }), 0o644);
    if (!runtime.skipCommands) {
      const prefix = paths.systemService ? [] : ['--user'];
      run('systemctl', [...prefix, 'daemon-reload']);
      run('systemctl', [...prefix, 'enable', '--now', paths.unit]);
    }
  }
  return { ...paths, endpointId: config.endpointId, role: config.role, handoffPath };
}

export async function statusAgent(options, runtime = {}) {
  const endpointId = requiredOption(options, 'endpoint');
  validateEndpointId(endpointId);
  const platformName = runtime.platform ?? platform();
  const paths = agentPaths(endpointId, { platformName, home: runtime.home });
  const values = await readInstalledConfig(paths.config, endpointId);
  const role = values.MENOTEAM_AGENT_ROLE || 'teammate';
  let active = false;
  if (!runtime.skipCommands && platformName === 'darwin') {
    active = runQuiet('launchctl', ['print', `gui/${process.getuid()}/${paths.label}`], { allowFailure: true }).status === 0;
  } else if (!runtime.skipCommands && platformName === 'linux') {
    const prefix = paths.systemService ? [] : ['--user'];
    active = runQuiet('systemctl', [...prefix, 'is-active', '--quiet', paths.unit], { allowFailure: true }).status === 0;
  }
  return { endpointId, role, active, config: paths.config, service: paths.service };
}

export async function uninstallAgent(options, runtime = {}) {
  const endpointId = requiredOption(options, 'endpoint');
  validateEndpointId(endpointId);
  const platformName = runtime.platform ?? platform();
  const paths = agentPaths(endpointId, { platformName, home: runtime.home });
  const values = await readInstalledConfig(paths.config, endpointId);
  const role = values.MENOTEAM_AGENT_ROLE || 'teammate';
  const codexPath = values.CODEX_BIN;
  if (!runtime.skipCommands && platformName === 'darwin') {
    runQuiet('launchctl', ['bootout', `gui/${process.getuid()}`, paths.service], { allowFailure: true });
  } else if (!runtime.skipCommands && platformName === 'linux') {
    const prefix = paths.systemService ? [] : ['--user'];
    runQuiet('systemctl', [...prefix, 'disable', '--now', paths.unit], { allowFailure: true });
  }
  await Promise.all([paths.service, paths.config, paths.state, paths.lock, paths.stdout, paths.stderr].map((path) => unlink(path).catch(() => undefined)));
  if (!runtime.skipCommands && platformName === 'linux') {
    const prefix = paths.systemService ? [] : ['--user'];
    runQuiet('systemctl', [...prefix, 'daemon-reload'], { allowFailure: true });
  }
  if (role === 'master' && codexPath && !runtime.skipCommands) runQuiet(codexPath, ['mcp', 'remove', 'agent-gateway'], { allowFailure: true });
  return { endpointId, role };
}

export function agentPaths(endpointId, { platformName = platform(), home = homedir(), uid = process.getuid?.() } = {}) {
  validateEndpointId(endpointId);
  const stateDir = join(home, '.local', 'state', 'menoteam-agent');
  const systemService = platformName === 'linux' && uid === 0;
  const label = `ai.menoteam.agent.${endpointId}`;
  const unit = `menoteam-agent-${endpointId}.service`;
  return {
    label,
    unit,
    systemService,
    config: join(home, '.config', 'menoteam-agent', `${endpointId}.env`),
    stateDir,
    state: join(stateDir, `${endpointId}.json`),
    lock: join(stateDir, `${endpointId}.json.lock`),
    stdout: join(stateDir, `${endpointId}.out.log`),
    stderr: join(stateDir, `${endpointId}.err.log`),
    service: platformName === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', `${label}.plist`)
      : systemService ? join('/etc/systemd/system', unit) : join(home, '.config', 'systemd', 'user', unit),
  };
}

function registerMasterMcp(codexPath, gatewayUrl, env) {
  runQuiet(codexPath, ['mcp', 'remove', 'agent-gateway'], { allowFailure: true, env });
  run(codexPath, ['mcp', 'add', 'agent-gateway', '--url', `${gatewayUrl}/mcp`, '--bearer-token-env-var', 'MENOTEAM_MASTER_MCP_KEY'], { env });
}

function registerWorkMapMcp(codexPath, workMapUrl, env) {
  runQuiet(codexPath, ['mcp', 'remove', 'work-map'], { allowFailure: true, env });
  run(codexPath, ['mcp', 'add', 'work-map', '--url', workMapUrl, '--bearer-token-env-var', 'WORK_MAP_MCP_API_KEY'], { env });
}

async function findExecutable(name, fallbacks = []) {
  const candidates = name.includes('/') ? [name] : [
    ...String(process.env.PATH || '').split(delimiter).filter(Boolean).map((directory) => join(directory, name)),
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch { /* try next candidate */ }
  }
  throw new Error(`${name} executable was not found`);
}

function codexFallbacks() {
  return platform() === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources/codex'] : [];
}

async function atomicWrite(path, contents, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
  await chmod(path, mode);
}

async function readInstalledConfig(path, endpointId) {
  try {
    return parseHandoff(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`No local Menoteam Connector is installed for ${endpointId}`);
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
    '  node setup.mjs install --config /secure/path/agent.env [--repository-cwd /path/to/repo]',
    '  node setup.mjs status --endpoint alice-codex',
    '  node setup.mjs uninstall --endpoint alice-codex',
  ].join('\n');
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'install') {
    const result = await installAgent(options);
    process.stdout.write(`Menoteam ${result.role} installed: ${result.endpointId}\nBackground Connector started. Delete the one-time handoff file after confirming status.\n`);
    return;
  }
  if (command === 'status') {
    const result = await statusAgent(options);
    process.stdout.write(`${result.endpointId}\t${result.role}\t${result.active ? 'service-running' : 'service-stopped'}\n`);
    return;
  }
  if (command === 'uninstall') {
    const result = await uninstallAgent(options);
    process.stdout.write(`Removed local Menoteam ${result.role} runtime: ${result.endpointId}\nThe Codex plugin itself was kept installed.\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Menoteam setup failed'}\n`);
    process.exitCode = 1;
  });
}
