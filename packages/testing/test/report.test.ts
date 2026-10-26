import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { azureDevOpsLines, displayPath, junitReport, summary, textReport } from '../src/report';
import type { TestResult } from '../src/run';

const cwd = join('/', 'repo');
const at = (p: string) => join(cwd, p);
const results: TestResult[] = [
  { file: at('apis/a/tests/t.yaml'), name: 'passes', line: 3, status: 'passed', messages: [], durationMs: 12.4 },
  { file: at('apis/a/tests/t.yaml'), name: 'fails <badly>', line: 7, status: 'failed', messages: [{ message: 'Expected status 200, got 500.', file: at('apis/a/tests/t.yaml'), line: 9 }], durationMs: 3 },
  { file: at('apis/b/tests/u.yaml'), name: 'breaks', line: 1, status: 'error', messages: [{ message: 'CS1061: 100% wrong;\nreally]', file: at('apis/b/policy.xml'), line: 4, col: 2 }], durationMs: 1000 },
];

describe('reports', () => {
  it('shows paths relative to where the tests ran', () => {
    expect(displayPath(at('apis/a/policy.xml'), cwd)).toBe('apis/a/policy.xml');
    expect(displayPath(join('/', 'elsewhere', 'x.yaml'), cwd)).toBe(join('/', 'elsewhere', 'x.yaml').split('\\').join('/'));
  });

  it('writes a line per test, its messages, and the totals', () => {
    expect(textReport(results, cwd).split('\n')).toEqual([
      'ok   apis/a/tests/t.yaml > passes (12 ms)',
      'FAIL apis/a/tests/t.yaml > fails <badly> (3 ms)',
      '       apis/a/tests/t.yaml:9 Expected status 200, got 500.',
      'ERR  apis/b/tests/u.yaml > breaks (1000 ms)',
      '       apis/b/policy.xml:4:2 CS1061: 100% wrong;',
      'really]',
      '',
      "3 tests: 1 passed, 1 failed, 1 couldn't run",
    ]);
    expect(summary([results[0]])).toBe('1 test: 1 passed');
  });

  it('writes JUnit with a suite per file', () => {
    const xml = junitReport(results, cwd);
    expect(xml).toContain('<testsuites name="APIM policy tests" tests="3" failures="1" errors="1" time="1.015">');
    expect(xml).toContain('<testsuite name="apis/a/tests/t.yaml" tests="2" failures="1" errors="0" time="0.015">');
    expect(xml).toContain('<testcase name="passes" classname="apis/a/tests/t.yaml" file="apis/a/tests/t.yaml" line="3" time="0.012" />');
    expect(xml).toContain('<testcase name="fails &lt;badly&gt;"');
    expect(xml).toContain('<failure message="Expected status 200, got 500.">apis/a/tests/t.yaml:9 Expected status 200, got 500.</failure>');
    expect(xml).toContain('<error message="CS1061: 100% wrong;\nreally]">apis/b/policy.xml:4 CS1061');
    expect(xml.endsWith('</testsuites>\n')).toBe(true);
  });

  it('writes an Azure DevOps issue per message, escaped', () => {
    expect(azureDevOpsLines(results, cwd)).toEqual([
      '##vso[task.logissue type=error;sourcepath=apis/a/tests/t.yaml;linenumber=9;]fails <badly>: Expected status 200, got 500.',
      '##vso[task.logissue type=error;sourcepath=apis/b/policy.xml;linenumber=4;columnnumber=2;]breaks: CS1061: 100%AZP25 wrong;%0Areally]',
    ]);
  });
});
