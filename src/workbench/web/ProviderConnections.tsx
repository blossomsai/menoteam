import { useState, type FormEvent } from 'react';
import { Badge } from '../../local/web/src/components/ui/badge';
import { Button } from '../../local/web/src/components/ui/button';
import { Input } from '../../local/web/src/components/ui/input';
import { Label } from '../../local/web/src/components/ui/label';
import type { RuntimeProvider, Setting } from '../types';
import { workbenchApi, type ProviderConnection } from './api';

type ConnectorOption = RuntimeProvider & { projectIds?: string[]; runKinds?: string[]; codexAppServer?: boolean; localWorktrees?: boolean };

export function ProviderConnections({ settings, runtimes, connections, canManage, refresh, setError }: {
  settings: Setting[];
  runtimes: RuntimeProvider[];
  connections?: ProviderConnection[];
  canManage: boolean;
  refresh: () => Promise<void>;
  setError: (value: string) => void;
}) {
  const providers = settings.filter(setting => setting.kind === 'provider' && !setting.projectId);
  const linkedIds = new Set(providers.map(setting => String(setting.data.connectorId ?? '')));
  const availableConnectors = (runtimes as ConnectorOption[]).filter(runtime => runtime.available && runtime.codexAppServer === true && runtime.localWorktrees === true && runtime.models.length > 0 && !linkedIds.has(runtime.connectorId));
  const [connectorId, setConnectorId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const connector = availableConnectors.find(item => item.connectorId === connectorId);
    if (!connector || !name.trim()) return;
    setBusy(true); setError('');
    try {
      await workbenchApi.saveSetting({ kind: 'provider', name: name.trim(), data: { provider: 'openai', method: 'codex-host', connectorId: connector.connectorId, default: providers.length === 0, enabled: true } });
      setName(''); setConnectorId(''); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add provider connection.'); }
    finally { setBusy(false); }
  };

  const update = async (setting: Setting, changes: { name?: string; data?: Record<string, unknown> }): Promise<boolean> => {
    setError('');
    try { await workbenchApi.updateSetting(setting.id, { ...changes, expectedUpdatedAt: setting.updatedAt }); await refresh(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update provider connection.'); return false; }
  };

  const getStatus = (setting: Setting) => {
    const connection = connections?.find(item => item.id === setting.id);
    if (connection) return connection.status;
    const runtime = (runtimes as ConnectorOption[]).find(item => item.connectorId === setting.data.connectorId);
    if (!runtime) return 'unbound';
    return runtime.available && runtime.codexAppServer === true && runtime.localWorktrees === true && runtime.models.length > 0 ? 'available' : runtime.available ? 'capability_unavailable' : 'offline';
  };
  const getModels = (setting: Setting) => connections?.find(item => item.id === setting.id)?.models ?? runtimes.find(runtime => runtime.connectorId === setting.data.connectorId)?.models ?? [];

  return <section className="mb-7" aria-labelledby="provider-connections-heading">
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 id="provider-connections-heading" className="font-semibold">Provider connections</h2><p className="mt-1 text-sm text-muted-foreground">Connections use an enrolled Codex host and its reported model capabilities.</p></div></header>
    {providers.length ? <div className="divide-y rounded-lg border">{providers.map(setting => {
      const status = getStatus(setting);
      const enabled = setting.data.enabled !== false;
      const isDefault = setting.data.default === true;
      const models = getModels(setting);
      const runtime = runtimes.find(item => item.connectorId === setting.data.connectorId);
      const connection = connections?.find(item => item.id === setting.id);
      const statusLabel = status === 'disabled' || !enabled ? 'Disabled' : status === 'unbound' ? 'Unbound' : status === 'disconnected' ? 'Disconnected' : status === 'capability_unavailable' ? 'Capability unavailable' : status === 'available' && runtime?.available ? 'Available' : 'Offline';
      return <ProviderConnectionRow key={setting.id} setting={setting} statusLabel={statusLabel} reason={connection?.reason ?? (runtime?.available && runtime.localWorktrees === false ? 'Local Worktree capability unavailable' : undefined)} models={models} isDefault={isDefault} enabled={enabled} canManage={canManage} connectorReachable={Boolean(runtime?.available)} update={update} />;
    })}</div> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No provider connections yet. Add one from an enrolled, available Codex host.</p>}
    {canManage && <form className="mt-4 grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,1fr)_auto] sm:items-end" onSubmit={add}>
      <div className="grid gap-2"><Label htmlFor="provider-connection-name">Connection name</Label><Input id="provider-connection-name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Team Codex host" /></div>
      <div className="grid gap-2"><Label htmlFor="provider-connector">Enrolled Connector</Label><select id="provider-connector" required className="h-9 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={connectorId} onChange={event => setConnectorId(event.target.value)}><option value="">Choose an available Codex host</option>{availableConnectors.map(connector => <option key={connector.connectorId} value={connector.connectorId}>{connector.connectorId.slice(0, 12)} · {connector.models.length ? connector.models.join(', ') : 'No models reported'}</option>)}</select></div>
      <Button disabled={busy || !name.trim() || !connectorId || !availableConnectors.some(item => item.connectorId === connectorId)}>{busy ? 'Adding…' : 'Add connection'}</Button>
      {!availableConnectors.length && <p className="text-sm text-muted-foreground sm:col-span-3">No unlinked Codex host is currently available. Enroll and authorize a Connector separately before adding it here.</p>}
    </form>}
  </section>;
}

function ProviderConnectionRow({ setting, statusLabel, reason, models, isDefault, enabled, canManage, connectorReachable, update }: {
  setting: Setting; statusLabel: string; reason?: string; models: string[]; isDefault: boolean; enabled: boolean; canManage: boolean; connectorReachable: boolean;
  update: (setting: Setting, changes: { name?: string; data?: Record<string, unknown> }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(setting.name);
  const [busy, setBusy] = useState(false);
  const available = enabled && connectorReachable && statusLabel === 'Available';
  const saveChange = async (changes: { name?: string; data?: Record<string, unknown> }) => {
    setBusy(true);
    try { await update(setting, changes); }
    finally { setBusy(false); }
  };
  return <article className="flex flex-wrap items-start justify-between gap-4 p-4" aria-label={`${setting.name} provider connection`}>
    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{setting.name}</h3>{isDefault && <Badge variant="secondary">Default</Badge>}<Badge variant={available ? 'secondary' : 'outline'}>{statusLabel}</Badge></div><p className="mt-1 text-sm text-muted-foreground">OpenAI · Codex host · {String(setting.data.connectorId ?? 'Connector unavailable')}</p><p className="mt-2 text-xs text-muted-foreground">{models.length ? `Reported models: ${models.join(' · ')}` : 'No model capabilities reported'}</p>{reason && <p className="mt-1 text-xs text-destructive">{reason}</p>}</div>
    {canManage && <div className="flex flex-wrap items-center gap-2">{editing ? <><Label className="sr-only" htmlFor={`provider-name-${setting.id}`}>Connection name</Label><Input id={`provider-name-${setting.id}`} className="h-8 w-48" value={name} onChange={event => setName(event.target.value)} /><Button size="sm" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); try { if (await update(setting, { name: name.trim() })) setEditing(false); } finally { setBusy(false); } }}>{busy ? 'Saving…' : 'Save name'}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setName(setting.name); setEditing(false); }}>Cancel</Button></> : <><Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>Rename</Button>{!isDefault && enabled && <Button variant="outline" size="sm" disabled={busy || !available} onClick={() => void saveChange({ data: { default: true } })}>Make default</Button>}<Button variant="outline" size="sm" disabled={busy} onClick={() => void saveChange({ data: { enabled: !enabled } })}>{enabled ? 'Disable' : 'Enable'}</Button></>}</div>}
  </article>;
}
