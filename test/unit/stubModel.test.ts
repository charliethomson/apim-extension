import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { membersAfter, parseStubs } from '../../src/csharp/stubModel';

const model = parseStubs(readFileSync(join(__dirname, '..', '..', 'stubs', 'ApimContext.cs'), 'utf8'));

describe('parseStubs', () => {
  it('reads the context interface with documented members', () => {
    const ctx = model.get('IProxyRequestContext')!;
    expect(ctx.kind).toBe('interface');
    expect(ctx.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(['Api', 'Request', 'Response', 'Variables', 'User', 'Elapsed', 'Trace']),
    );
    const req = ctx.members.find((m) => m.name === 'Request')!;
    expect(req).toMatchObject({ kind: 'property', type: 'IRequest', doc: 'The incoming request.' });
    expect(ctx.members.find((m) => m.name === 'Trace')).toMatchObject({ kind: 'method', type: 'void', params: 'string message' });
  });

  it('reads classes, enums and generic methods', () => {
    expect(model.get('Jwt')?.members.map((m) => m.name)).toContain('Claims');
    expect(model.get('BackendType')?.members.map((m) => m.name)).toEqual(['Single', 'Pool']);
    expect(model.get('IMessageBody')?.members.find((m) => m.name === 'As')).toMatchObject({ kind: 'method', params: 'bool preserveContent = false' });
    expect(model.get('IRequest')?.members.find((m) => m.name === 'Headers')?.type).toBe('IReadOnlyDictionary<string, string[]>');
  });

  it('turns see/paramref tags into plain text', () => {
    expect(model.get('IProxyRequestContext')?.members.find((m) => m.name === 'Elapsed')?.doc).toBe('Time elapsed since Timestamp.');
  });

  it('skips private constructors', () => {
    expect(model.get('Jwt')?.members.some((m) => m.name === 'Jwt')).toBe(false);
  });
});

describe('membersAfter', () => {
  it('resolves member chains from context', () => {
    expect(membersAfter(model, 'context.')?.type.name).toBe('IProxyRequestContext');
    expect(membersAfter(model, 'x + context.Request.Url.Ho')).toMatchObject({ type: { name: 'IUrl' }, typed: 'Ho' });
    expect(membersAfter(model, 'context.User?.')?.type.name).toBe('IUser');
    expect(membersAfter(model, 'context.Deployment.Gateway.')?.type.name).toBe('IGateway');
  });

  it('gives up outside the stubs', () => {
    expect(membersAfter(model, 'context.Request.Headers.')).toBeUndefined();
    expect(membersAfter(model, 'foo.')).toBeUndefined();
    expect(membersAfter(model, 'context.Nope.')).toBeUndefined();
  });
});
