import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../src/args';

describe('the command line', () => {
  it('reads test and its options', () => {
    expect(parseArgs(['test'])).toEqual({ command: 'test', paths: [], timeout: 60 });
    expect(
      parseArgs(['test', 'apis/a', '--junit', 'j.xml', '--filter', 'x', '--trace', 't', '--runner', 'r.dll', '--cache', 'c', '--timeout', '5', '--azure-devops', 'apis/b']),
    ).toEqual({ command: 'test', paths: ['apis/a', 'apis/b'], junit: 'j.xml', filter: 'x', trace: 't', runner: 'r.dll', cache: 'c', timeout: 5, azureDevOps: true });
    expect(parseArgs(['test', '--no-azure-devops'])).toMatchObject({ azureDevOps: false });
  });

  it('knows help and version', () => {
    expect(parseArgs([])).toEqual({ command: 'help' });
    expect(parseArgs(['test', '--help'])).toEqual({ command: 'help' });
    expect(parseArgs(['-v'])).toEqual({ command: 'version' });
    expect(parseArgs(['--version'])).toEqual({ command: 'version' });
  });

  it('turns away what it does not know', () => {
    expect(() => parseArgs(['run'])).toThrow(UsageError);
    expect(() => parseArgs(['test', '--nope'])).toThrow('Unknown option --nope');
    expect(() => parseArgs(['test', '--junit'])).toThrow('--junit needs a value');
    expect(() => parseArgs(['test', '--junit', '--filter', 'x'])).toThrow('--junit needs a value');
    expect(() => parseArgs(['test', '--timeout', 'soon'])).toThrow("--timeout is a number of seconds, not 'soon'");
    expect(() => parseArgs(['test', '--timeout', '0'])).toThrow('--timeout');
  });
});
