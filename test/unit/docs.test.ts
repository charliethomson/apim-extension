import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/scanner';
import { fragmentMarkdown, GENERATED_MARKER, policyMarkdown } from '../../src/policy/docs';

const fixture = (p: string) => readFileSync(join(__dirname, '..', 'fixtures', p), 'utf8');

describe('fragment docs', () => {
  const md = fragmentMarkdown('random-user', parse(fixture('apiops/policyFragments/random-user/policy.xml')), {
    callers: [{ label: 'apiops/apis/random-users/policy.xml', href: '../../apis/random-users/policy.xml' }],
  });

  it('starts with the marker that lets it be rewritten, then the summary, escaped', () => {
    expect(md.startsWith(`${GENERATED_MARKER}\n\n# random-user\n\nFetches people`)).toBe(true);
    expect(md).toContain('before \\<include-fragment fragment-id="random-user" /\\>');
  });

  it('tables inputs and outputs, with what is required and the defaults as code', () => {
    expect(md).toContain('| `ru-arg-base-url` | `string` | no, default `https://randomuser.me/api/` | An https URL on randomuser.me. |');
    expect(md).toContain('| `ru-ret-users` | `User[]` | The projected users. |');
    expect(md).toContain('| `ru-arg-filter` | `UserFilter` | no |');
    expect(md).toContain('### UserFilter\n\nRules the users must pass.\n\n| Key | Type | Required | Description |');
    expect(md).toContain('| `match` | `string` | no | "all" (the default) or "any" of the rules. |');
    expect(md).toContain('| `rules` | `UserRule[]` | **yes** |  |');
  });

  it("lists internals once, a pattern with what it covers, and who uses it", () => {
    expect(md).toContain('- `ru-int-errors` `JArray`: Problems found while validating');
    expect(md).toMatch(/- `ru-int-\*`: Working state[^\n]*\(`ru-int-started-at`/);
    expect(md.match(/`ru-int-errors`/g)).toHaveLength(1);
    expect(md).toContain('- [apiops/apis/random-users/policy.xml](../../apis/random-users/policy.xml)');
  });

  it('documents a fragment without a header from what it reads and sets, with inferred shapes', () => {
    const bare = fragmentMarkdown('f', parse('<fragment><set-variable name="out" value="@((string)context.Variables[&quot;in&quot;])" /></fragment>'), { shapeText: () => undefined });
    expect(bare).toContain('_This fragment has no header');
    expect(bare).toContain('| `in` |  | **yes** |  |');
    expect(bare).toContain('<set-variable name="in" value="" />\n<include-fragment fragment-id="f" />');
    const shaped = fragmentMarkdown('s', parse(fixture('apiops/policyFragments/shaped/policy.xml')), { shapeText: (n) => (n === 'sh-result' ? '{ count: int }' : undefined) });
    expect(shaped).toContain('| `sh-result` | `{ count: int }` |');
  });
});

describe('policy docs', () => {
  it('lists the steps per section, the variables, and what it depends on, with links', () => {
    const md = policyMarkdown('The API random-users policy', parse(fixture('apiops/apis/random-users/policy.xml')), { scope: 'API random-users', fragmentHref: (id) => `../${id}.md` });
    expect(md).toContain('Scope: API random-users.');
    expect(md).toContain('[`include random-user`](../random-user.md)');
    expect(md).toContain('- Named values: `{{random-user-cache-seconds}}`');
    expect(md).toMatch(/- Reads without setting: `ru-ret-cache-hit`/);
  });

  it('notes backends and URLs it calls', () => {
    const md = policyMarkdown('p', parse('<policies><inbound><set-backend-service backend-id="b1" /><send-request mode="new" response-variable-name="r"><set-url>https://example.com/x</set-url></send-request></inbound></policies>'));
    expect(md).toContain('- Backends: `b1`');
    expect(md).toContain('- Calls: `https://example.com/x`');
  });
});
