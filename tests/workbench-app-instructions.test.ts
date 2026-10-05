// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/workbench/web/App';
import { ApiError, workbenchApi, type Snapshot } from '../src/workbench/web/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const member = { id: 'owner', email: 'owner@example.test', name: 'Owner', role: 'owner' as const };
function snapshot(instructions: string, name = 'Project'): Snapshot {
  return { member, projects: [{ id: 'project', name, instructions, repositoryUrl: '', deliveryAuthorization: '', createdAt: '2026-10-06' }], works: [], messages: [], runs: [], artifacts: [], settings: [], runtimeProviders: [] };
}
let root: Root;
let host: HTMLDivElement;
let responses: Array<Promise<Snapshot>>;
let snapshotSpy: ReturnType<typeof vi.spyOn<typeof workbenchApi, 'snapshot'>>;
async function flush(action: () => void = () => undefined) { await act(async () => { action(); }); }
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}: ${host.textContent}`);
  return found;
}
async function click(text: string) { await flush(() => button(text).click()); }
async function type(value: string, selector = 'textarea') {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await flush(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function draft() { return host.querySelector('textarea')?.value; }
async function poll() { await flush(() => vi.advanceTimersByTime(2_000)); }
async function mount() { await flush(() => root.render(createElement(App))); }
async function logout() {
  const control = host.querySelector<HTMLButtonElement>('aside > button')!;
  await flush(() => control.click());
}
async function login() {
  await type(member.email, '#login-email');
  await type('password', '#login-password');
  await flush(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
  responses = [Promise.resolve(snapshot('A'))];
  snapshotSpy = vi.spyOn(workbenchApi, 'snapshot').mockImplementation(() => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected snapshot request');
    return response;
  });
  vi.spyOn(workbenchApi, 'me').mockResolvedValue(member);
  vi.spyOn(workbenchApi, 'login').mockResolvedValue({ authenticated: true });
  vi.spyOn(workbenchApi, 'logout').mockResolvedValue();
  vi.spyOn(workbenchApi, 'projectMessages').mockResolvedValue({ messages: [], nextBefore: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await flush(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('mounted App Instructions and session races', () => {
  it.each(['Use latest version', 'Keep editing my draft', 'Cancel'])('preserves typing after save and ignores a late stale poll before %s', async resolution => {
    const oldPoll = deferred<Snapshot>(); const refresh = deferred<Snapshot>(); const save = deferred<Snapshot['projects'][number]>();
    const update = vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    await mount(); await click('Edit'); await type('B');
    responses.push(oldPoll.promise); await poll();
    await click('Save'); expect(update).toHaveBeenCalledWith('project', { instructions: 'B', expectedInstructions: 'A' });
    await type('C'); expect(draft()).toBe('C');
    responses.push(refresh.promise); await flush(() => save.resolve(snapshot('B').projects[0]!));
    await flush(() => refresh.resolve(snapshot('B')));
    expect(draft()).toBe('C'); expect(button('Save').disabled).toBe(false);
    await flush(() => oldPoll.resolve(snapshot('A')));
    expect(draft()).toBe('C'); expect(host.textContent).not.toContain('Instructions changed elsewhere.');
    // Another confirmed remote update exposes all three real resolution controls.
    responses.push(Promise.resolve(snapshot('D'))); await poll();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('D');
    await click(resolution);
    if (resolution === 'Cancel') {
      expect(draft()).toBeUndefined(); await click('Edit'); expect(draft()).toBe('D');
    } else if (resolution === 'Use latest version') {
      expect(draft()).toBe('D'); expect(button('Save').disabled).toBe(true);
    } else {
      expect(draft()).toBe('C'); expect(button('Save').disabled).toBe(false);
      vi.mocked(workbenchApi.updateProject).mockResolvedValue(snapshot('C').projects[0]!);
      responses.push(Promise.resolve(snapshot('C'))); await click('Save');
      expect(update).toHaveBeenLastCalledWith('project', { instructions: 'C', expectedInstructions: 'D' });
      expect(draft()).toBeUndefined();
    }
  });

  it('accepts a pending save refresh after a newer poll fails', async () => {
    const refresh = deferred<Snapshot>(); const failedPoll = deferred<Snapshot>(); const save = deferred<Snapshot['projects'][number]>();
    vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    await mount(); await click('Edit'); await type('B'); await click('Save'); await type('C');
    responses.push(refresh.promise); await flush(() => save.resolve(snapshot('B').projects[0]!));
    responses.push(failedPoll.promise); await poll(); await flush(() => failedPoll.reject(new Error('poll unavailable')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('poll unavailable');
    await flush(() => refresh.resolve(snapshot('B')));
    expect(draft()).toBe('C'); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('Instructions changed elsewhere.');
    await click('Cancel'); await click('Edit'); expect(draft()).toBe('B');
  });

  it('gates a queued poll and save refresh during logout, and isolates login from old responses', async () => {
    const oldPoll = deferred<Snapshot>(); const save = deferred<Snapshot['projects'][number]>(); const exiting = deferred<void>(); const entering = deferred<{ authenticated: true }>();
    vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); await click('Edit'); await type('B'); responses.push(oldPoll.promise); await poll(); await click('Save');
    await logout(); expect(host.textContent).toContain('Loading Menoteam');
    await poll(); await flush(() => save.resolve(snapshot('B').projects[0]!));
    expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await flush(() => exiting.resolve()); expect(host.textContent).toContain('Sign in to Menoteam');
    await login(); await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await flush(() => oldPoll.resolve(snapshot('OLD', 'Old session')));
    expect(host.textContent).toContain('Loading Menoteam'); expect(host.textContent).not.toContain('Old session');
    responses.push(Promise.resolve(snapshot('NEW', 'New session'))); await flush(() => entering.resolve({ authenticated: true }));
    expect(host.textContent).toContain('New session'); await click('Edit'); expect(draft()).toBe('NEW');
  });

  it('blocks an already queued ready timer callback synchronously at logout', async () => {
    const timers = vi.spyOn(window, 'setInterval'); const exiting = deferred<void>();
    vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount();
    const queuedTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    const logoutControl = host.querySelector<HTMLButtonElement>('aside > button')!;
    await flush(() => { logoutControl.click(); queuedTick(); });
    expect(snapshotSpy).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Loading Menoteam');
    await flush(queuedTick); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    await flush(() => exiting.resolve()); await flush(queuedTick);
    expect(snapshotSpy).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Sign in to Menoteam');
    const entering = deferred<{ authenticated: true }>(); vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await login(); await flush(queuedTick); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    responses.push(Promise.resolve(snapshot('NEW'))); await flush(() => entering.resolve({ authenticated: true }));
    await flush(queuedTick); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await click('Edit'); expect(draft()).toBe('NEW');
  });

  it('does not restore Instructions when an old response arrives while logout is pending', async () => {
    const oldPoll = deferred<Snapshot>(); const exiting = deferred<void>();
    vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount(); responses.push(oldPoll.promise); await poll(); await logout();
    await flush(() => oldPoll.resolve(snapshot('OLD', 'Old session')));
    expect(host.textContent).toContain('Loading Menoteam'); expect(host.querySelector('aside')).toBeNull();
    await flush(() => exiting.resolve()); expect(host.textContent).toContain('Sign in to Menoteam');
  });

  it('does not launch an old save refresh after a new login has enabled requests', async () => {
    const save = deferred<Snapshot['projects'][number]>(); vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(save.promise);
    await mount(); await click('Edit'); await type('B'); await click('Save'); await logout();
    responses.push(Promise.resolve(snapshot('NEW'))); await login(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await flush(() => save.resolve(snapshot('B').projects[0]!)); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await click('Edit'); expect(draft()).toBe('NEW');
  });

  it('ignores a prelogout response arriving after the new login snapshot', async () => {
    const oldPoll = deferred<Snapshot>(); await mount(); responses.push(oldPoll.promise); await poll(); await logout();
    responses.push(Promise.resolve(snapshot('NEW'))); await login(); await click('Edit');
    await flush(() => oldPoll.resolve(snapshot('OLD'))); expect(draft()).toBe('NEW'); expect(host.textContent).not.toContain('Instructions changed elsewhere.');
  });

  it('expires the request generation on a 401 so a pending save refresh cannot restore the shell', async () => {
    const refresh = deferred<Snapshot>(); const unauthorized = deferred<Snapshot>();
    vi.spyOn(workbenchApi, 'updateProject').mockResolvedValue(snapshot('B').projects[0]!);
    await mount(); await click('Edit'); await type('B'); responses.push(refresh.promise); await click('Save');
    responses.push(unauthorized.promise); await poll(); await flush(() => unauthorized.reject(new ApiError('Session expired', 401)));
    expect(host.textContent).toContain('Sign in to Menoteam');
    await flush(() => refresh.resolve(snapshot('B'))); await poll();
    expect(host.textContent).toContain('Sign in to Menoteam'); expect(snapshotSpy).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('resumes polling after an authenticated invite account switch (snapshot retry: %s)', async retrySnapshot => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const timers = vi.spyOn(window, 'setInterval');
    const oldPoll = deferred<Snapshot>(); const entering = deferred<{ authenticated: true }>(); const newSnapshot = deferred<Snapshot>();
    const invited = { ...member, id: 'invited-owner', email: 'invited@example.test', name: 'Invited owner' };
    const invitedSnapshot = (instructions: string): Snapshot => ({ ...snapshot(instructions, 'Invited project'), member: invited });
    const accept = vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: invited.email });
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); expect(host.textContent).toContain('Join Menoteam');
    const oldTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    responses.push(oldPoll.promise); await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    await type(invited.name, '#invite-name'); await type('new-account-password', '#invite-password');
    await click('Accept invitation');
    expect(accept).toHaveBeenCalledWith({ token: 'valid-invite', name: invited.name, password: 'new-account-password' });
    expect(workbenchApi.login).toHaveBeenCalledWith(invited.email, 'new-account-password');
    await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    responses.push(newSnapshot.promise); await flush(() => entering.resolve({ authenticated: true }));
    expect(window.location.search).toBe(''); expect(snapshotSpy).toHaveBeenCalledTimes(3);
    // Open Instructions while B's first snapshot is in flight, as a direct project route.
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
    if (retrySnapshot) {
      await flush(() => newSnapshot.reject(new Error('snapshot network unavailable')));
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('snapshot network unavailable');
      responses.push(Promise.resolve(invitedSnapshot('B'))); await poll();
    } else {
      await flush(() => newSnapshot.resolve(invitedSnapshot('B')));
    }
    const acceptedRequests = retrySnapshot ? 4 : 3;
    expect(host.textContent).toContain('Invited owner'); await click('Edit'); await type('My unsaved B draft');
    await flush(oldTick); expect(snapshotSpy).toHaveBeenCalledTimes(acceptedRequests);
    await flush(() => oldPoll.resolve(snapshot('Late A', 'Old account project')));
    await flush(oldTick); expect(snapshotSpy).toHaveBeenCalledTimes(acceptedRequests);
    expect(host.textContent).not.toContain('Old account project'); expect(draft()).toBe('My unsaved B draft');
    expect(host.querySelector('[role="status"]')).toBeNull();
    responses.push(Promise.resolve(invitedSnapshot('Remote B revision'))); await poll();
    expect(snapshotSpy).toHaveBeenCalledTimes(acceptedRequests + 1);
    expect(draft()).toBe('My unsaved B draft');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Remote B revision');
    expect(host.textContent).toContain('Invited owner');
  });

  it.each(['poll', 'Retry'])('hides the prior account before recovering an invited account snapshot through %s', async recovery => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const accountA = { ...member, id: 'account-a', name: 'Private Account A' };
    const accountB = { ...member, id: 'account-b', name: 'Account B', email: 'account-b@example.test' };
    const privateA = { ...snapshot('Private A instructions', 'Private A project'), member: accountA };
    const publicB = { ...snapshot('B instructions', 'Account B project'), member: accountB };
    responses = [Promise.resolve(privateA)]; vi.mocked(workbenchApi.me).mockResolvedValue(accountA);
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: accountB.email });
    const timers = vi.spyOn(window, 'setInterval'); const oldPoll = deferred<Snapshot>();
    const entering = deferred<{ authenticated: true }>(); const firstB = deferred<Snapshot>(); const recoveredB = deferred<Snapshot>();
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); const oldTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    responses.push(oldPoll.promise); await poll();
    await type(accountB.name, '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    responses.push(firstB.promise); await flush(() => entering.resolve({ authenticated: true }));
    expect(workbenchApi.login).toHaveBeenCalledWith(accountB.email, 'new-account-password');
    const expectPrivateAAbsent = () => {
      expect(host.textContent).not.toContain(accountA.name); expect(host.textContent).not.toContain('Private A project');
      expect(host.textContent).not.toContain('Private A instructions'); expect(host.querySelector('aside')).toBeNull();
    };
    expectPrivateAAbsent(); expect(window.location.search).toBe('');
    await flush(() => firstB.reject(new Error('B snapshot unavailable')));
    expectPrivateAAbsent(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('B snapshot unavailable');
    expect(button('Retry').disabled).toBe(false);
    await flush(() => oldPoll.resolve(privateA)); await flush(oldTick);
    expect(snapshotSpy).toHaveBeenCalledTimes(3); expectPrivateAAbsent();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('B snapshot unavailable');
    const repeatedFailure = deferred<Snapshot>(); responses.push(repeatedFailure.promise); await click('Retry');
    await flush(() => repeatedFailure.reject(new Error('B snapshot still unavailable')));
    expectPrivateAAbsent(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('B snapshot still unavailable');
    responses.push(recoveredB.promise);
    if (recovery === 'poll') await poll(); else await click('Retry');
    expect(snapshotSpy).toHaveBeenCalledTimes(5); expectPrivateAAbsent();
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
    await flush(() => recoveredB.resolve(publicB));
    expect(host.textContent).toContain(accountB.name); expect(host.textContent).toContain('Account B project');
    expect(host.textContent).not.toContain('Private A'); expect(host.querySelector('[role="alert"]')).toBeNull();
    await click('Edit'); expect(draft()).toBe('B instructions');
  });

  it('accepts a new-account poll while the first invited snapshot is still pending', async () => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'account-b@example.test' });
    const firstB = deferred<Snapshot>(); await mount();
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password');
    responses.push(firstB.promise); await click('Accept invitation');
    const accountB = { ...member, id: 'account-b', name: 'Account B' };
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project');
    responses.push(Promise.resolve({ ...snapshot('Newer B'), member: accountB })); await poll();
    expect(host.textContent).toContain('Account B'); await click('Edit'); expect(draft()).toBe('Newer B');
    await flush(() => firstB.resolve({ ...snapshot('Older B'), member: accountB }));
    expect(draft()).toBe('Newer B'); expect(host.querySelector('[role="status"]')).toBeNull();
    await click('Cancel'); await click('Edit'); expect(draft()).toBe('Newer B');
  });

  it('keeps polling gated when login for an accepted invite fails', async () => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const timers = vi.spyOn(window, 'setInterval'); const entering = deferred<{ authenticated: true }>(); const oldPoll = deferred<Snapshot>();
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'invited@example.test' });
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); const oldTick = timers.mock.calls.find(call => call[1] === 2_000)![0] as () => void;
    responses.push(oldPoll.promise); await poll();
    await type('Invited owner', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    await flush(() => entering.reject(new Error('login network unavailable')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('login network unavailable');
    await flush(oldTick); await poll(); await flush(() => oldPoll.resolve(snapshot('Late A')));
    expect(snapshotSpy).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('Sign in to Menoteam');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('login network unavailable');
  });

  it('permits Retry after successful login when its snapshot refresh fails', async () => {
    vi.mocked(workbenchApi.me).mockRejectedValue(new ApiError('Anonymous', 401));
    const failedRefresh = deferred<Snapshot>();
    await mount(); responses = [failedRefresh.promise]; await login();
    await flush(() => failedRefresh.reject(new Error('snapshot unavailable')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('snapshot unavailable');
    responses.push(Promise.resolve(snapshot('NEW'))); await click('Retry'); await click('Edit'); expect(draft()).toBe('NEW');
  });

  it.each(['success', '401', 'network'])('invalidates at pending invite acceptance before a late old poll %s', async outcome => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const accepting = deferred<{ accepted: true; email: string }>(); const oldPoll = deferred<Snapshot>();
    vi.spyOn(workbenchApi, 'acceptInvite').mockReturnValue(accepting.promise);
    await mount(); responses.push(oldPoll.promise); await poll();
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    // Navigate away from the invite overlay to inspect the actual underlying App state.
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project'); await mount();
    expect(host.textContent).toContain('Loading Menoteam'); expect(host.querySelector('aside')).toBeNull();
    await flush(() => outcome === 'success' ? oldPoll.resolve(snapshot('Private A', 'Private A project')) : oldPoll.reject(outcome === '401' ? new ApiError('Old A expired', 401) : new Error('Old A network error')));
    await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('Private A'); expect(host.textContent).not.toContain('Old A');
    expect(host.textContent).toContain('Loading Menoteam');
    responses.push(Promise.resolve({ ...snapshot('B instructions', 'B project'), member: { ...member, id: 'b', name: 'Account B' } }));
    await flush(() => accepting.resolve({ accepted: true, email: 'b@example.test' }));
    expect(host.textContent).toContain('Account B');
    window.history.replaceState(null, '', '/workbench/?view=instructions&project=project'); await mount();
    await click('Edit'); expect(draft()).toBe('B instructions');
  });

  it.each(['accept', 'login', 'logout'].flatMap(stage => ['401', 'network'].map(outcome => ({ stage, outcome }))))('clears pending $stage and permits recovery after $outcome failure', async ({ stage, outcome }) => {
    const failure = outcome === '401' ? new ApiError(`${stage} failed`, 401) : new Error(`${stage} failed`);
    if (stage !== 'logout') window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const accepting = deferred<{ accepted: true; email: string }>(); const entering = deferred<{ authenticated: true }>(); const exiting = deferred<void>();
    const accept = vi.spyOn(workbenchApi, 'acceptInvite').mockReturnValue(stage === 'accept' ? accepting.promise : Promise.resolve({ accepted: true, email: 'b@example.test' }));
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise); vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount();
    if (stage === 'logout') await logout(); else { await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation'); }
    if (stage !== 'accept') expect(host.textContent).toContain('Loading Menoteam');
    expect(host.querySelector('aside')).toBeNull(); await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    await flush(() => stage === 'accept' ? accepting.reject(failure) : stage === 'login' ? entering.reject(failure) : exiting.reject(failure));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(`${stage} failed`); expect(host.querySelector('aside')).toBeNull();
    await poll(); expect(snapshotSpy).toHaveBeenCalledTimes(1);
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } }));
    vi.mocked(workbenchApi.login).mockResolvedValue({ authenticated: true });
    if (stage === 'accept') { accept.mockResolvedValue({ accepted: true, email: 'b@example.test' }); await click('Accept invitation'); }
    else { expect(host.textContent).toContain('Sign in to Menoteam'); await login(); }
    expect(accept).toHaveBeenCalledTimes(stage === 'accept' ? 2 : stage === 'login' ? 1 : 0);
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['me', 'snapshot'].flatMap(stage => ['pending', 'ready'].flatMap(timing => ['success', '401', 'network'].map(outcome => ({ stage, timing, outcome })))))('ignores delayed initial $stage $outcome during new session $timing', async ({ stage, timing, outcome }) => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const initialMe = deferred<typeof member>(); const initialSnapshot = deferred<Snapshot>(); const accepting = deferred<{ accepted: true; email: string }>();
    if (stage === 'me') { vi.mocked(workbenchApi.me).mockReturnValue(initialMe.promise); responses = []; } else responses = [initialSnapshot.promise];
    vi.spyOn(workbenchApi, 'acceptInvite').mockReturnValue(accepting.promise);
    await mount(); await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
    const newAccount = { ...snapshot('B instructions', 'B project'), member: { ...member, id: 'b', name: 'Account B' } };
    if (timing === 'ready') { responses.push(Promise.resolve(newAccount)); await flush(() => accepting.resolve({ accepted: true, email: 'b@example.test' })); }
    await flush(() => {
      if (outcome !== 'success') (stage === 'me' ? initialMe : initialSnapshot).reject(outcome === '401' ? new ApiError('Old initial expired', 401) : new Error('Old initial unavailable'));
      else if (stage === 'me') initialMe.resolve(member); else initialSnapshot.resolve(snapshot('Private A', 'Private A project'));
    });
    expect(snapshotSpy).toHaveBeenCalledTimes((stage === 'snapshot' ? 1 : 0) + (timing === 'ready' ? 1 : 0));
    expect(host.textContent).not.toContain('Old initial'); expect(host.textContent).not.toContain('Private A');
    if (timing === 'pending') { responses.push(Promise.resolve(newAccount)); await flush(() => accepting.resolve({ accepted: true, email: 'b@example.test' })); }
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['401', 'network'])('recovers initial me failure %s through actual Try again', async outcome => {
    vi.mocked(workbenchApi.me).mockRejectedValueOnce(new Error('me unavailable'));
    await mount(); expect(host.textContent).toContain('me unavailable');
    const retryMe = deferred<typeof member>(); vi.mocked(workbenchApi.me).mockReturnValueOnce(retryMe.promise);
    await click('Try again'); expect(host.textContent).toContain('Loading Menoteam');
    await flush(() => retryMe.reject(outcome === '401' ? new ApiError('Session expired', 401) : new Error('me still unavailable')));
    if (outcome === '401') { expect(host.textContent).toContain('Sign in to Menoteam'); await login(); }
    else { expect(host.textContent).toContain('me still unavailable'); vi.mocked(workbenchApi.me).mockResolvedValue(member); await click('Try again'); }
    await click('Edit'); expect(draft()).toBe('A');
  });

  it('recovers repeated initial snapshot errors without another identity check', async () => {
    responses = [Promise.reject(new Error('initial snapshot unavailable'))]; await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('initial snapshot unavailable');
    responses.push(Promise.reject(new Error('snapshot retry unavailable'))); await click('Retry');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('snapshot retry unavailable');
    responses.push(Promise.resolve(snapshot('Recovered'))); await poll();
    expect(workbenchApi.me).toHaveBeenCalledTimes(1); await click('Edit'); expect(draft()).toBe('Recovered');
  });

  it('preserves a dirty Instructions draft across recoverable same-session snapshot errors', async () => {
    await mount(); await click('Edit'); await type('My dirty draft');
    responses.push(Promise.reject(new Error('poll unavailable'))); await poll();
    expect(draft()).toBe('My dirty draft'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('poll unavailable');
    responses.push(Promise.reject(new Error('retry unavailable'))); await click('Retry'); expect(draft()).toBe('My dirty draft');
    responses.push(Promise.resolve(snapshot('Remote revision'))); await poll();
    expect(draft()).toBe('My dirty draft'); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Remote revision');
  });


  it.each(['accept', 'login', 'logout'].flatMap(stage => ['success', '401', 'network'].map(outcome => ({ stage, outcome }))))('ignores stale $stage $outcome completion after a newer invitation session', async ({ stage, outcome }) => {
    const oldAccept = deferred<{ accepted: true; email: string }>(); const oldLogin = deferred<{ authenticated: true }>(); const oldLogout = deferred<void>();
    const accept = vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'b@example.test' });
    if (stage === 'accept') accept.mockReturnValueOnce(oldAccept.promise);
    if (stage === 'login') vi.mocked(workbenchApi.login).mockReturnValueOnce(oldLogin.promise);
    if (stage === 'logout') vi.mocked(workbenchApi.logout).mockReturnValueOnce(oldLogout.promise);
    if (stage !== 'logout') window.history.replaceState(null, '', '/workbench/?invite=old-invite');
    await mount();
    if (stage === 'logout') await logout(); else { await type('Old invited account', '#invite-name'); await type('old-account-password', '#invite-password'); await click('Accept invitation'); }
    window.history.replaceState(null, '', '/workbench/?invite=new-invite'); await mount();
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password');
    responses.push(Promise.resolve({ ...snapshot('B instructions', 'B project'), member: { ...member, id: 'b', name: 'Account B' } }));
    await click('Accept invitation'); expect(host.textContent).toContain('Account B');
    const logins = vi.mocked(workbenchApi.login).mock.calls.length;
    await flush(() => {
      if (outcome !== 'success') (stage === 'accept' ? oldAccept : stage === 'login' ? oldLogin : oldLogout).reject(outcome === '401' ? new ApiError('Old operation expired', 401) : new Error('Old operation unavailable'));
      else if (stage === 'accept') oldAccept.resolve({ accepted: true, email: 'old@example.test' });
      else if (stage === 'login') oldLogin.resolve({ authenticated: true }); else oldLogout.resolve();
    });
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(snapshotSpy).toHaveBeenCalledTimes(2); expect(workbenchApi.login).toHaveBeenCalledTimes(logins);
  });

  it.each(['login pending', 'logout pending', 'new session'].flatMap(phase => ['success', '401', 'network'].map(outcome => ({ phase, outcome }))))('ignores old snapshot $outcome during $phase', async ({ phase, outcome }) => {
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite');
    const oldPoll = deferred<Snapshot>(); const entering = deferred<{ authenticated: true }>(); const exiting = deferred<void>();
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'b@example.test' });
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise); vi.mocked(workbenchApi.logout).mockReturnValue(exiting.promise);
    await mount(); responses.push(oldPoll.promise); await poll();
    if (phase === 'logout pending') {
      window.history.replaceState(null, '', '/workbench/?view=instructions&project=project'); await mount(); await logout();
    } else {
      await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password'); await click('Accept invitation');
      if (phase === 'new session') { responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await flush(() => entering.resolve({ authenticated: true })); }
    }
    await flush(() => outcome === 'success' ? oldPoll.resolve(snapshot('Private A', 'Private A project')) : oldPoll.reject(outcome === '401' ? new ApiError('Old session expired', 401) : new Error('Old session unavailable')));
    expect(host.textContent).not.toContain('Private A'); expect(host.textContent).not.toContain('Old session');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain(phase === 'new session' ? 'Account B' : 'Loading Menoteam');
  });

  it.each(['401', 'network'])('isolates a pending Retry %s catch from a replacement session', async outcome => {
    responses = [Promise.reject(new Error('initial snapshot unavailable'))]; await mount();
    const retry = deferred<Snapshot>(); responses.push(retry.promise); await click('Retry');
    window.history.replaceState(null, '', '/workbench/?invite=valid-invite'); await mount();
    vi.spyOn(workbenchApi, 'acceptInvite').mockResolvedValue({ accepted: true, email: 'b@example.test' });
    await type('Account B', '#invite-name'); await type('new-account-password', '#invite-password');
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await click('Accept invitation');
    await flush(() => retry.reject(outcome === '401' ? new ApiError('Old retry expired', 401) : new Error('Old retry unavailable')));
    expect(host.textContent).toContain('Account B'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });


  it.each(['login', 'snapshot'].flatMap(stage => ['401', 'network'].map(outcome => ({ stage, outcome }))))('recovers ordinary sign-in $stage $outcome failures without prior workspace data', async ({ stage, outcome }) => {
    vi.mocked(workbenchApi.me).mockRejectedValue(new ApiError('Anonymous', 401)); responses = [];
    const entering = deferred<{ authenticated: true }>(); const firstSnapshot = deferred<Snapshot>();
    vi.mocked(workbenchApi.login).mockReturnValue(entering.promise);
    await mount(); await login(); expect(host.textContent).toContain('Loading Menoteam'); expect(host.querySelector('aside')).toBeNull();
    const failure = outcome === '401' ? new ApiError('New account expired', 401) : new Error('New account unavailable');
    if (stage === 'login') await flush(() => entering.reject(failure));
    else { responses.push(firstSnapshot.promise); await flush(() => entering.resolve({ authenticated: true })); await flush(() => firstSnapshot.reject(failure)); }
    expect(host.querySelector('aside')).toBeNull();
    responses.push(Promise.resolve(snapshot('Recovered'))); vi.mocked(workbenchApi.login).mockResolvedValue({ authenticated: true });
    if (stage === 'snapshot' && outcome === 'network') await click('Retry'); else { expect(host.textContent).toContain('Sign in to Menoteam'); await login(); }
    await click('Edit'); expect(draft()).toBe('Recovered'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['success', '401', 'network'])('does not surface a detached Instructions save %s after a replacement session', async outcome => {
    const oldSave = deferred<Snapshot['projects'][number]>(); vi.spyOn(workbenchApi, 'updateProject').mockReturnValue(oldSave.promise);
    await mount(); await click('Edit'); await type('Private dirty A'); await click('Save'); await logout();
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await login();
    await click('Edit'); await type('B dirty draft');
    await flush(() => outcome === 'success' ? oldSave.resolve(snapshot('Private saved A').projects[0]!) : oldSave.reject(outcome === '401' ? new ApiError('Old save expired', 401) : new Error('Old save unavailable')));
    expect(snapshotSpy).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('Account B');
    expect(draft()).toBe('B dirty draft'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('resets the editor when a confirmed snapshot changes member identity', async () => {
    await mount(); await click('Edit'); await type('Private dirty A');
    responses.push(Promise.resolve({ ...snapshot('B instructions'), member: { ...member, id: 'b', name: 'Account B' } })); await poll();
    expect(host.textContent).toContain('Account B'); expect(draft()).toBeUndefined();
    await click('Edit'); expect(draft()).toBe('B instructions'); expect(host.querySelector('[role="status"]')).toBeNull();
  });

});
