import { describe, expect, it } from 'vitest';
import { decodeSemanticTokens, parseHoverSymbol } from '../../src/csharp/semanticLint';

describe('decodeSemanticTokens', () => {
  it('decodes relative positions', () => {
    const legend = ['namespace', 'class', 'method'];
    const data = [2, 4, 6, 1, 0, 0, 7, 8, 2, 0, 1, 2, 3, 0, 0];
    expect(decodeSemanticTokens(data, legend)).toEqual([
      { line: 2, character: 4, length: 6, type: 'class' },
      { line: 2, character: 11, length: 8, type: 'method' },
      { line: 3, character: 2, length: 3, type: 'namespace' },
    ]);
  });
});

describe('parseHoverSymbol', () => {
  it.each([
    ['```csharp\nclass System.IO.File\n```', { kind: 'type', fullName: 'System.IO.File' }],
    ['```csharp\nstatic class System.Environment\n```', { kind: 'type', fullName: 'System.Environment' }],
    ['```csharp\nstruct System.DateTime\n```', { kind: 'type', fullName: 'System.DateTime' }],
    ['```csharp\nenum System.UriKind\n```', { kind: 'type', fullName: 'System.UriKind' }],
    ['```csharp\ninterface System.IComparable\n```', { kind: 'type', fullName: 'System.IComparable' }],
    ['```csharp\ndelegate TResult System.Func<in T, out TResult>(T arg)\n```', { kind: 'type', fullName: 'System.Func' }],
    ['```csharp\nlong DateTime.ToBinary()\n```', { kind: 'member', typeName: 'DateTime', member: 'ToBinary' }],
    ['```csharp\nDateTime DateTime.Now { get; }\n```', { kind: 'member', typeName: 'DateTime', member: 'Now' }],
    ['```csharp\nDateTimeKind.Local = 2\n```', { kind: 'member', typeName: 'DateTimeKind', member: 'Local' }],
    ['```csharp\n(extension) string IReadOnlyDictionary<string, string[]>.GetValueOrDefault(string name)\n```', { kind: 'member', typeName: 'IReadOnlyDictionary', member: 'GetValueOrDefault' }],
    ['```csharp\nbool Regex.IsMatch(string input)\n```', { kind: 'member', typeName: 'Regex', member: 'IsMatch' }],
  ])('%s', (md, expected) => {
    expect(parseHoverSymbol(md)).toEqual(expected);
  });

  it('returns undefined for locals and keywords', () => {
    expect(parseHoverSymbol('```csharp\n(local variable) string x\n```')).toBeUndefined();
  });
});
