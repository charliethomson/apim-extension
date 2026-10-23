import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '@apim-policy/document';
import { PolicyIndex, within } from '../src/policyIndex';
import { fragmentXml, MemoryHost, MemoryInstance, policyXml } from './memory';

const SIGN = 'file:///ws/policyFragments/sign/policy.xml';
const ECHO = 'file:///ws/apis/echo/policy.xml';
const EDIT_SIGN = 'apim-edit://inst/inst/fragments/sign.fragment.xml';

const workspace = () =>
  new MemoryHost({
    [SIGN]: fragmentXml(['sig-header'], ['sig-key']),
    [ECHO]: policyXml('<set-variable name="sig-key" value="k" /><include-fragment fragment-id="sign" /><set-header name="x" exists-action="override"><value>{{shared}}</value></set-header>'),
    'file:///ws/apis/other/policy.xml': policyXml('<include-fragment fragment-id="rate" />'),
    'file:///ws/node_modules/pkg/policy.xml': fragmentXml(['hidden']),
    'file:///ws/project.xml': '<project />',
    'file:///ws/namedValues/apim-key/namedValueInformation.json': '{}',
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('the workspace scan', () => {
  it('waits for the first question, then reads policies and skips the rest', async () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    expect(host.reads).toBe(0);
    expect(await index.fragmentIds()).toEqual(['sign']);
    // node_modules is never read; project.xml is read and turned away.
    expect(host.reads).toBe(4);
  });

  it('skips a file it cannot read', async () => {
    const host = workspace();
    host.files.set('file:///ws/policyFragments/broken/policy.xml', null);
    expect(await new PolicyIndex(host).fragmentIds()).toEqual(['sign']);
  });

  it('takes open documents from their live text', async () => {
    const host = workspace();
    host.edit(SIGN, fragmentXml(['renamed']));
    const index = new PolicyIndex(host);
    expect((await index.fragment('sign'))?.summary.header?.outputs.map((o) => o.name)).toEqual(['renamed']);
  });
});

describe('keeping up with files and documents', () => {
  it('ignores file events until the scan has run, then indexes them', async () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    const RATE = 'file:///ws/policyFragments/rate/policy.xml';
    host.files.set(RATE, fragmentXml(['remaining']));
    index.fileCreated(RATE);
    expect(host.reads).toBe(0);
    await index.fragmentIds();
    expect(await index.fragmentIds()).toEqual(['rate', 'sign']);
    host.files.set('file:///ws/policyFragments/late/policy.xml', fragmentXml([]));
    index.fileCreated('file:///ws/policyFragments/late/policy.xml');
    await vi.waitFor(async () => expect(await index.fragmentIds()).toContain('late'));
  });

  it('leaves an open file to the editor, and forgets a deleted one', async () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    await index.fragmentIds();
    const doc = host.edit(SIGN, fragmentXml(['live']));
    index.documentChanged(SIGN, doc);
    host.files.set(SIGN, fragmentXml(['on-disk']));
    index.fileChanged(SIGN);
    expect((await index.fragment('sign'))?.summary.header?.outputs.map((o) => o.name)).toEqual(['live']);
    index.fileDeleted(SIGN);
    expect(await index.fragmentIds()).toEqual([]);
  });

  it('drops a file that stops being a policy', async () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    await index.fragmentIds();
    host.files.set(SIGN, '<project />');
    index.fileChanged(SIGN);
    await vi.waitFor(async () => expect(await index.fragmentIds()).toEqual([]));
  });

  it('indexes only workspace files and editable instance copies', async () => {
    const index = new PolicyIndex(new MemoryHost());
    index.documentChanged('untitled:Untitled-1', parse(fragmentXml([])));
    index.documentChanged('apim-instance://inst/inst/fragments/ro.fragment.xml', parse(fragmentXml([])));
    expect(await index.fragmentIds()).toEqual([]);
  });

  it('tells listeners once per burst of changes', async () => {
    vi.useFakeTimers();
    const index = new PolicyIndex(new MemoryHost());
    const heard = vi.fn();
    const subscription = index.onDidChange(heard);
    for (const id of ['a', 'b', 'c']) index.documentChanged(`file:///ws/policyFragments/${id}/policy.xml`, parse(fragmentXml([])));
    await vi.advanceTimersByTimeAsync(300);
    expect(heard).toHaveBeenCalledTimes(1);
    subscription.dispose();
    index.documentChanged('file:///ws/policyFragments/d/policy.xml', parse(fragmentXml([])));
    await vi.advanceTimersByTimeAsync(300);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('passes on what the instance says has changed', async () => {
    vi.useFakeTimers();
    const index = new PolicyIndex(new MemoryHost());
    const instance = new MemoryInstance();
    index.attach(instance);
    const heard = vi.fn();
    index.onDidChange(heard);
    instance.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(heard).toHaveBeenCalledTimes(1);
    index.dispose();
    instance.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('which copy of a fragment', () => {
  const setup = () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    index.attach(new MemoryInstance({ sign: fragmentXml(['from-instance']), 'only-remote': fragmentXml([]) }));
    return { host, index };
  };

  it("prefers the workspace's file, then the instance's copy", async () => {
    const { index } = setup();
    expect(await index.fragmentFiles('sign', ECHO)).toEqual([SIGN]);
    expect(await index.fragmentFiles('only-remote', ECHO)).toEqual(['apim-instance://inst/inst/fragments/only-remote.fragment.xml']);
    expect(await index.fragmentFiles('missing')).toEqual([]);
  });

  it("from an instance policy, prefers an open editable copy, then the instance's, then the workspace's", async () => {
    const { host, index } = setup();
    const from = 'apim-instance://inst/inst/apis/echo.policy.xml';
    expect(await index.fragmentFiles('sign', from)).toEqual(['apim-instance://inst/inst/fragments/sign.fragment.xml']);
    index.documentChanged(EDIT_SIGN, host.edit(EDIT_SIGN, fragmentXml(['edited'])));
    expect(await index.fragmentFiles('sign', from)).toEqual([EDIT_SIGN]);
    // The editable copy is that fragment by its path, so a workspace caller sees it only without a file.
    expect(await index.fragmentFiles('sign', ECHO)).toEqual([SIGN]);
    index.documentClosed(EDIT_SIGN);
    expect(await index.fragmentFiles('sign', from)).toEqual(['apim-instance://inst/inst/fragments/sign.fragment.xml']);
  });

  it('falls back to the workspace when the instance has no copy', async () => {
    const index = new PolicyIndex(workspace());
    expect(await index.fragmentFiles('sign', 'apim-instance://inst/inst/apis/echo.policy.xml')).toEqual([SIGN]);
  });

  it('lists ids from both, without waiting long for the instance when asked not to', async () => {
    const { index } = setup();
    expect(await index.fragmentIds()).toEqual(['only-remote', 'sign']);
    class Unreachable extends MemoryInstance {
      override fragments() {
        return new Promise<never>(() => {});
      }
    }
    const slow = new PolicyIndex(workspace());
    slow.attach(new Unreachable());
    expect(await slow.fragmentIds({ remoteWithin: 10 })).toEqual(['sign']);
  });

  it('finds callers and fragments among workspace files only', async () => {
    const { host, index } = setup();
    index.documentChanged(EDIT_SIGN, host.edit(EDIT_SIGN, fragmentXml([])));
    expect((await index.callers(['sign'])).map((c) => c.uri)).toEqual([ECHO]);
    expect((await index.localFragments()).map((f) => [f.uri, f.ids])).toEqual([[SIGN, ['sign']]]);
  });
});

describe('named values and backends', () => {
  it("lists the instance's with what it knows, then names only the workspace uses", async () => {
    const index = new PolicyIndex(workspace());
    index.attach(
      new MemoryInstance({}, [
        { id: 'nv1', displayName: 'Shared', value: 'v', secret: false },
        { id: 'nv2', displayName: 'secret-one', secret: true },
        { id: 'nv3', displayName: 'vaulted', secret: true, keyVault: 'https://kv/secrets/s' },
      ]),
    );
    expect((await index.namedValues()).map((s) => [s.name, s.detail])).toEqual([
      ['apim-key', undefined],
      ['secret-one', 'secret'],
      ['Shared', 'v'],
      ['vaulted', 'Key Vault secret'],
    ]);
    expect((await index.namedValue('SHARED'))?.id).toBe('nv1');
  });

  it('has only the workspace names without an instance', async () => {
    const index = new PolicyIndex(workspace());
    expect((await index.namedValues()).map((s) => s.name)).toEqual(['apim-key', 'shared']);
    expect(await index.namedValue('shared')).toBeUndefined();
    expect(await index.backends()).toEqual([]);
  });

  it("offers the instance's backends", async () => {
    const index = new PolicyIndex(new MemoryHost());
    index.attach(new MemoryInstance({}, [], [{ id: 'orders', url: 'https://orders', description: 'Orders API' }]));
    expect(await index.backends()).toEqual([{ name: 'orders', detail: 'https://orders', documentation: 'Orders API' }]);
  });
});

describe('variables a policy can read', () => {
  it('includes what its fragments set, pointing at the fragment', async () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    const vars = await index.variables(ECHO, parse(host.files.get(ECHO)!));
    const sig = vars.find((v) => v.name === 'sig-header');
    expect(sig?.uri).toBe(SIGN);
    expect(vars.find((v) => v.name === 'sig-key')?.uri).toBe(ECHO);
  });

  it("includes fragments only the instance has, and what the broader scopes set", async () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    const OTHER = 'file:///ws/apis/other/policy.xml';
    index.attach(
      new MemoryInstance({ rate: fragmentXml(['remaining']) }, [], [], [{ scope: { kind: 'global' }, xml: policyXml('<set-variable name="tenant" value="t" />') }], (u) => (u === OTHER ? { kind: 'api', api: 'other' } : undefined)),
    );
    const vars = await index.variables(OTHER, parse(host.files.get(OTHER)!));
    expect(vars.find((v) => v.name === 'remaining')?.uri).toBe('apim-instance://inst/inst/fragments/rate.fragment.xml');
    const tenant = vars.find((v) => v.name === 'tenant');
    expect([tenant?.origin, tenant?.uri]).toEqual(['set by global', 'apim-instance://inst/inst/global.policy.xml']);
  });

  it("counts what an outer policy's includes set from the workspace's copy of the fragment", async () => {
    const host = workspace();
    const index = new PolicyIndex(host);
    index.attach(
      new MemoryInstance({ sign: fragmentXml(['instance-only']) }, [], [], [{ scope: { kind: 'global' }, xml: policyXml('<include-fragment fragment-id="sign" />') }], () => ({ kind: 'api', api: 'echo' })),
    );
    // Placed once per section it's set in; only the name matters here.
    expect(new Set((await index.outerVariables(ECHO, parse(host.files.get(ECHO)!))).map((o) => o.name))).toEqual(new Set(['sig-header']));
    expect(await new PolicyIndex(host).outerVariables(ECHO, parse(host.files.get(ECHO)!))).toEqual([]);
  });
});

describe('APIOps extracts', () => {
  it('knows a folder that holds apis/ or policyFragments/', async () => {
    const index = new PolicyIndex(workspace());
    await index.fragmentIds();
    expect(index.isExtractRoot('/ws')).toBe(true);
    expect(index.isExtractRoot('/elsewhere')).toBe(false);
  });
});

describe('within', () => {
  it('settles on the fallback when the promise is slow, and on its value when not', async () => {
    expect(await within(new Promise(() => {}), 'late', 5)).toBe('late');
    expect(await within(Promise.resolve('now'), 'late', 1000)).toBe('now');
  });
});
