// @vitest-environment happy-dom
import { act, createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Checkbox } from '../src/local/web/src/components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from '../src/local/web/src/components/ui/native-select';

let host: HTMLDivElement;
let root: Root;

async function render(element: ReactNode) {
  await act(async () => root.render(element));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('shared form primitives in a mounted DOM', () => {
  it('keeps NativeSelect a labeled, keyboard-focusable native select with form value, disabled state, and change events', async () => {
    const changed = vi.fn();
    function Form() {
      const [value, setValue] = useState('ready');
      return createElement('form', null,
        createElement('label', { htmlFor: 'status' }, 'Status'),
        createElement(NativeSelect, { id: 'status', name: 'status', required: true, value, wrapperClassName: 'max-w-48', className: 'px-2', onChange: event => { changed(event.target.value); setValue(event.target.value); } },
          createElement(NativeSelectOption, { value: 'ready' }, 'Ready'),
          createElement(NativeSelectOption, { value: 'paused' }, 'Paused'),
        ),
        createElement(NativeSelect, { id: 'locked', disabled: true, value: 'locked', className: 'px-3', onChange: () => undefined },
          createElement(NativeSelectOption, { value: 'locked' }, 'Locked'),
        ),
      );
    }

    await render(createElement(Form));
    const select = host.querySelector<HTMLSelectElement>('#status')!;
    expect(select.tagName).toBe('SELECT');
    expect(select.labels?.[0]?.textContent).toBe('Status');
    expect(select.tabIndex).toBeGreaterThanOrEqual(0);
    expect(select.classList.contains('px-2')).toBe(true);
    expect(select.classList.contains('pr-9')).toBe(true);
    expect(select.classList.contains('max-w-48')).toBe(false);
    expect(select.parentElement?.classList.contains('max-w-48')).toBe(true);
    expect(select.parentElement?.querySelector('[data-slot="native-select-icon"]')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('#locked')?.classList.contains('pr-9')).toBe(true);
    expect(new FormData(host.querySelector('form')!).get('status')).toBe('ready');
    expect(host.querySelector<HTMLSelectElement>('#locked')?.disabled).toBe(true);
    await act(async () => { select.value = 'paused'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(changed).toHaveBeenCalledWith('paused');
    expect(new FormData(host.querySelector('form')!).get('status')).toBe('paused');
  });

  it('keeps multiple NativeSelect a native multi-value control without a single-select indicator', async () => {
    const changed = vi.fn();
    function Form() {
      const [values, setValues] = useState(['read', 'write']);
      return createElement('form', null,
        createElement('label', { htmlFor: 'skills' }, 'Reusable skills'),
        createElement(NativeSelect, { id: 'skills', name: 'skills', multiple: true, value: values, onChange: event => {
          const selected = Array.from(event.target.selectedOptions, option => option.value);
          changed(selected);
          setValues(selected);
        } },
          createElement(NativeSelectOption, { value: 'read' }, 'Read'),
          createElement(NativeSelectOption, { value: 'write' }, 'Write'),
        ),
      );
    }

    await render(createElement(Form));
    const select = host.querySelector<HTMLSelectElement>('#skills')!;
    expect(select.multiple).toBe(true);
    expect(select.labels?.[0]?.textContent).toBe('Reusable skills');
    expect(Array.from(select.selectedOptions, option => option.value)).toEqual(['read', 'write']);
    expect(select.name).toBe('skills');
    expect(select.classList.contains('pr-9')).toBe(false);
    expect(select.parentElement?.querySelector('[data-slot="native-select-icon"]')).toBeNull();

    await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
    expect(changed).toHaveBeenCalledWith(['read', 'write']);
    expect(Array.from(select.selectedOptions, option => option.value)).toEqual(['read', 'write']);
  });

  it('maps Radix true, false, and indeterminate states to checkbox accessibility and form values', async () => {
    const changed = vi.fn();
    function Form() {
      const [checked, setChecked] = useState(true);
      return createElement('form', null,
        createElement('label', null, createElement(Checkbox, { name: 'permission', value: 'allow', checked, onCheckedChange: next => { changed(next); setChecked(next === true); }, 'aria-label': 'Allow execution' }), 'Allow execution'),
        createElement(Checkbox, { checked: 'indeterminate', onCheckedChange: changed, 'aria-label': 'Partially selected' }),
        createElement(Checkbox, { checked: true, disabled: true, onCheckedChange: changed, 'aria-label': 'Locked' }),
      );
    }
    await render(createElement(Form));
    const [permission, mixed, locked] = [...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')];
    const form = host.querySelector('form')!;
    expect(permission?.getAttribute('aria-checked')).toBe('true');
    expect(new FormData(form).get('permission')).toBe('allow');
    expect(mixed?.getAttribute('aria-checked')).toBe('mixed');
    expect(new FormData(form).has('permission')).toBe(true);
    expect(locked?.disabled).toBe(true);
    await act(async () => host.querySelector('label')?.click());
    expect(changed).toHaveBeenCalledWith(false);
    expect(new FormData(form).has('permission')).toBe(false);
  });
});
