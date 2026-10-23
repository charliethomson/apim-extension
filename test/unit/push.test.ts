import { describe, expect, it } from 'vitest';
import { gatewayErrors, pushFormat, samePolicy } from '../../src/apim/push';
import { parse } from '../../src/parser/scanner';

describe('push helpers', () => {
  it('sends a policy in the format it is written in', () => {
    expect(pushFormat(parse('<policies><inbound><set-variable name="a" value="@(context.Variables[&quot;x&quot;])" /></inbound></policies>'))).toBe('xml');
    expect(pushFormat(parse('<policies><inbound><set-variable name="a" value="@(context.Variables["x"])" /></inbound></policies>'))).toBe('rawxml');
    expect(pushFormat(parse('<policies><inbound><base /></inbound></policies>'))).toBe('rawxml');
  });

  it('compares policies ignoring line endings and trailing space', () => {
    expect(samePolicy('<a>\r\n  <b/>  \r\n</a>\n', '<a>\n  <b/>\n</a>')).toBe(true);
    expect(samePolicy('<a/>', '<b/>')).toBe(false);
    expect(samePolicy(undefined, '<a/>')).toBe(false);
  });

  it("reads the gateway's line and column, and keeps errors without one", () => {
    expect(gatewayErrors(["Error in element 'set-variable' on line 479, column 6: Expression return type 'System.Object' is not allowed", 'Something else'])).toEqual([
      { line: 479, column: 6, message: "Error in element 'set-variable' on line 479, column 6: Expression return type 'System.Object' is not allowed" },
      { line: 0, column: 0, message: 'Something else' },
    ]);
  });
});
