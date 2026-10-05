import { describe, expect, it } from 'vitest';
import { normalizeCodexAccount, parsePrototypeLocation, settingsTabFromUrl, workspaceSettingsHref } from '../docs/prototypes/2026-10-02/team-workbench-v3/src/workbench';

describe('workbench settings routes and saved account values', () => {
  it('opens explicit settings destinations and returns the same tab after reload', () => {
    for (const tab of ['profiles', 'accounts'] as const) {
      const href = workspaceSettingsHref(tab, 'atlas', 'http://localhost/prototype?project=field-notes&view=V01');
      expect(settingsTabFromUrl(new URL(href, 'http://localhost'))).toBe(tab);
    }
  });

  it('redirects retired local environment and runtime links to model providers', () => {
    expect(settingsTabFromUrl('http://localhost/prototype#runtime-config')).toBe('accounts');
    expect(settingsTabFromUrl('http://localhost/prototype?view=V16')).toBe('accounts');
    expect(settingsTabFromUrl('http://localhost/prototype?view=V07&settings=accounts')).toBe('accounts');
    expect(parsePrototypeLocation('http://localhost/prototype#runtime-config').viewId).toBe('V15');
    expect(parsePrototypeLocation('http://localhost/prototype?view=V16').viewId).toBe('V15');
  });

  it('serializes the visible model providers tab when returning to workspace settings', () => {
    const href = workspaceSettingsHref('accounts', 'atlas', 'http://localhost/prototype?project=atlas&view=V03#work-list');
    const url = new URL(href, 'http://localhost');
    expect(url.searchParams.get('view')).toBe('V15');
    expect(parsePrototypeLocation(url).viewId).toBe('V15');
    expect(settingsTabFromUrl(url)).toBe('accounts');
  });

  it('maps old runtime values to a valid sample account without touching other session data', () => {
    expect(normalizeCodexAccount('ChatGPT Team')).toBe('codex-account-a');
    expect(normalizeCodexAccount('Personal Research')).toBe('codex-account-b');
    expect(normalizeCodexAccount('Local Config B')).toBe('codex-account-a');
  });
});
