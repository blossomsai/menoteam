import * as React from 'react';
import { Button } from '../../../../../src/local/web/src/components/ui/button';
import { Input } from '../../../../../src/local/web/src/components/ui/input';

export type AgentProfile = {
  id: string;
  name: string;
  model: string;
  skills: string[];
  plugins: string[];
  access: string[];
  subagentProfileIds: string[];
};

export const initialAgentProfiles: AgentProfile[] = [
  { id: 'builder', name: 'Builder', model: 'GPT 6 Luna', skills: ['Code', 'Ponytail'], plugins: ['GitHub'], access: ['读取项目', '修改项目', '运行命令'], subagentProfileIds: ['reviewer'] },
  { id: 'reviewer', name: 'Reviewer', model: 'GPT 6.1 Sol', skills: ['Code review', 'Ponytail'], plugins: ['GitHub'], access: ['读取项目'], subagentProfileIds: [] },
  { id: 'researcher', name: 'Researcher', model: 'GPT 6 Luna', skills: ['Research', 'Browser QA'], plugins: ['Browser'], access: ['读取项目'], subagentProfileIds: [] },
];

const choices = {
  skills: ['Code', 'Code review', 'Browser QA', 'Research', 'Ponytail'],
  plugins: ['GitHub', 'Browser', 'Slack'],
  access: ['读取项目', '修改项目', '运行命令'] as const,
};
const accessLabels: Record<(typeof choices.access)[number], string> = { '读取项目': 'Read project', '修改项目': 'Modify project', '运行命令': 'Run commands' };
const accessOptions = choices.access.map((value) => ({ value, label: accessLabels[value] }));
const blank = (): AgentProfile => ({ id: '', name: '', model: 'GPT 6 Luna', skills: [], plugins: [], access: [], subagentProfileIds: [] });

function Checks({ title, options, selected, onChange, note }: { title: string; options: (string | { value: string; label: string })[]; selected: string[]; onChange: (value: string[]) => void; note?: string }) {
  return <fieldset className="agent-profile-fieldset min-w-0 m-0 p-0 border-0 [&_legend]:mb-1.75 [&_legend]:text-[#484a51] [&_legend]:text-[13px] [&_legend]:font-semibold"><legend>{title}{note && <span className="agent-profile-note ml-2.25 text-[#686b73] text-[12px] font-normal max-[600px]:block max-[600px]:mt-0.75 max-[600px]:mr-0 max-[600px]:mb-0 max-[600px]:ml-0">{note}</span>}</legend><div className="agent-profile-options flex flex-wrap gap-[6px_18px] max-[600px]:gap-[4px_12px]">{options.map((item) => { const value = typeof item === 'string' ? item : item.value; const label = typeof item === 'string' ? item : item.label; return <label className="agent-profile-check inline-flex items-center gap-2 min-h-10 text-[#41434a] text-[14px] cursor-pointer [&_input]:w-4 [&_input]:h-4 max-[800px]:min-h-11 max-[800px]:[&_input]:w-4.5 max-[800px]:[&_input]:h-4.5" key={value}><input type="checkbox" checked={selected.includes(value)} onChange={(event) => onChange(event.target.checked ? [...selected, value] : selected.filter((entry) => entry !== value))}/><span>{label}</span></label>; })}</div></fieldset>;
}

export function AgentProfilesSettings({ profiles, onSave }: { profiles: AgentProfile[]; onSave: (profile: AgentProfile) => void }) {
  const [editing, setEditing] = React.useState<AgentProfile | null>(null);
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const addButton = React.useRef<HTMLButtonElement>(null);
  const start = (profile?: AgentProfile) => { setEditing(profile ? { ...profile, skills: [...profile.skills], plugins: [...profile.plugins], access: [...profile.access], subagentProfileIds: [...profile.subagentProfileIds] } : blank()); setError(''); };
  const update = (patch: Partial<AgentProfile>) => setEditing((current) => current ? { ...current, ...patch } : current);
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const name = editing?.name.trim();
    if (!editing || !name) { setError('Enter a profile name.'); return; }
    if (profiles.some((profile) => profile.id !== editing.id && profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) { setError('A profile with this name already exists.'); return; }
    onSave({ ...editing, id: editing.id || `profile-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, name });
    setEditing(null); setError(''); setSaved(true); requestAnimationFrame(() => addButton.current?.focus());
  };
  const cancel = () => { setEditing(null); setError(''); requestAnimationFrame(() => addButton.current?.focus()); };
  return <section className="agent-profiles w-full text-foreground" aria-label="Agent profiles">
    {editing ? <form className="agent-profile-editor [&_h2]:m-0 [&_h2]:text-[#34353b] [&_h2]:text-[17px] [&_h2]:font-semibold grid gap-4.5 m-0 p-0" onSubmit={save}>
      <div className="agent-profile-editor-head flex items-center justify-between gap-3.5 mb-0.25"><h2>{editing.name.trim() || 'New profile'}</h2><Button type="button" variant="ghost" className="agent-profile-action min-h-10 border-[#e2e2e5] rounded-[6px] max-[800px]:min-h-11" onClick={cancel}>Cancel</Button></div>
      <label className="agent-profile-label grid gap-1.5 text-[#484a51] text-[13px] font-semibold [&_input]:w-full [&_input]:min-h-10 [&_input]:border [&_input]:border-[#dedee3] [&_input]:rounded-[6px] [&_input]:pt-1.75 [&_input]:pr-2.5 [&_input]:pb-1.75 [&_input]:pl-2.5 [&_input]:bg-[#fff] [&_input]:text-[#25262a] [&_input]:text-[14px] [&_select]:w-full [&_select]:min-h-10 [&_select]:border [&_select]:border-[#dedee3] [&_select]:rounded-[6px] [&_select]:pt-1.75 [&_select]:pr-2.5 [&_select]:pb-1.75 [&_select]:pl-2.5 [&_select]:bg-[#fff] [&_select]:text-[#25262a] [&_select]:text-[14px] [&_input[aria-invalid='true']]:border-[#b95651] max-[800px]:[&_input]:min-h-11 max-[800px]:[&_select]:min-h-11">Name<Input autoFocus value={editing.name} onChange={(event) => update({ name: event.target.value })} placeholder="e.g. Builder" aria-invalid={Boolean(error)} /></label>
      <label className="agent-profile-label grid gap-1.5 text-[#484a51] text-[13px] font-semibold [&_input]:w-full [&_input]:min-h-10 [&_input]:border [&_input]:border-[#dedee3] [&_input]:rounded-[6px] [&_input]:pt-1.75 [&_input]:pr-2.5 [&_input]:pb-1.75 [&_input]:pl-2.5 [&_input]:bg-[#fff] [&_input]:text-[#25262a] [&_input]:text-[14px] [&_select]:w-full [&_select]:min-h-10 [&_select]:border [&_select]:border-[#dedee3] [&_select]:rounded-[6px] [&_select]:pt-1.75 [&_select]:pr-2.5 [&_select]:pb-1.75 [&_select]:pl-2.5 [&_select]:bg-[#fff] [&_select]:text-[#25262a] [&_select]:text-[14px] [&_input[aria-invalid='true']]:border-[#b95651] max-[800px]:[&_input]:min-h-11 max-[800px]:[&_select]:min-h-11">Model<select value={editing.model} onChange={(event) => update({ model: event.target.value })}><option>GPT 6 Luna</option><option>GPT 6.1 Sol</option></select></label>
      <Checks title="Skills" options={choices.skills} selected={editing.skills} onChange={(skills) => update({ skills })}/>
      <Checks title="Plugins" options={choices.plugins} selected={editing.plugins} onChange={(plugins) => update({ plugins })}/>
      <Checks title="Access" note="Subject to project rules" options={accessOptions} selected={editing.access} onChange={(access) => update({ access })}/>
      <details className="agent-profile-subagents border-t border-t-[#e8e8eb] pt-3 [&_summary]:min-h-10 [&_summary]:pt-2 [&_summary]:pr-0 [&_summary]:pb-2 [&_summary]:pl-0 [&_summary]:text-[#484a51] [&_summary]:text-[13px] [&_summary]:font-semibold [&_summary]:cursor-pointer"><summary>Allowed subagent profiles</summary><Checks title="Available profiles" options={profiles.filter((profile) => profile.id !== editing.id).map((profile) => ({ value: profile.id, label: profile.name }))} selected={editing.subagentProfileIds} onChange={(subagentProfileIds) => update({ subagentProfileIds })}/></details>
      {error && <p className="agent-profile-error mt-[-5px] mr-0 mb-0 ml-0 text-[#a43f3a] text-[13px]" role="alert">{error}</p>}
      <div className="agent-profile-footer flex justify-end border-t border-t-[#e8e8eb] pt-3.25"><Button type="submit" variant="outline" className="agent-profile-action min-h-10 border-[#e2e2e5] rounded-[6px] max-[800px]:min-h-11">Save profile</Button></div>
    </form> : <>
      <header className="agent-profiles-header flex items-center justify-between gap-3.5 mb-3.5 [&_h2]:m-0 [&_h2]:text-[#34353b] [&_h2]:text-[17px] [&_h2]:font-semibold max-[600px]:items-start"><h2>Agent profiles</h2><Button ref={addButton} type="button" variant="outline" className="agent-profile-action min-h-10 border-[#e2e2e5] rounded-[6px] max-[800px]:min-h-11" onClick={() => { setSaved(false); start(); }}>New profile</Button></header>
      {saved && <span className="agent-profile-saved block mt-2 text-[#454d40] text-[13px]" role="status" aria-live="polite">Saved</span>}
      <div className="agent-profile-list border-t border-t-[#e8e8eb]">{profiles.map((profile) => <button type="button" className="agent-profile-row grid grid-cols-[minmax(145px,_1fr)_minmax(0,_1.5fr)_20px] items-center gap-4 w-full min-h-15.5 pt-2.25 pr-2.5 pb-2.25 pl-2.5 border-0 border-b border-b-[#e8e8eb] bg-transparent text-left [&:hover]:bg-[#f7f7f9] [&.is-editing]:bg-[#f7f7f9] max-[800px]:min-h-16 max-[600px]:grid-cols-[minmax(0,_1fr)] max-[600px]:gap-[2px_10px] max-[600px]:pt-2.5 max-[600px]:pr-1.5 max-[600px]:pb-2.5 max-[600px]:pl-1.5" key={profile.id} onClick={() => { setSaved(false); start(profile); }} aria-label={`Edit ${profile.name}`}><span className="agent-profile-row-main grid gap-0.5 min-w-0 [&_strong]:text-[14px] [&_strong]:font-semibold [&_>_span]:text-[#686b73] [&_>_span]:text-[13px] max-[600px]:col-[1]"><strong>{profile.name}</strong><span>{profile.model}</span></span><span className="agent-profile-preview text-[#686b73] text-[13px] overflow-hidden text-ellipsis whitespace-nowrap max-[600px]:col-[1] max-[600px]:whitespace-normal">{[...profile.skills, ...profile.plugins].slice(0, 3).join(' · ') || 'No capabilities configured'}</span></button>)}{profiles.length === 0 && <p className="agent-profile-empty m-0 pt-4 pr-2.5 pb-4 pl-2.5 text-[#686b73] text-[14px]">No profiles yet.</p>}</div>
    </>}
  </section>;
}
