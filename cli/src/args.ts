/** The command line: `apim-policy test [paths…] [options]`, `--help` and `--version`. */

export interface TestArgs {
  command: 'test';
  /** Folders to look for tests/ folders in, or test files; the working folder when none. */
  paths: string[];
  /** Where to write JUnit XML. */
  junit?: string;
  /** Only tests whose name contains this. */
  filter?: string;
  /** A folder to write each test's full run (steps, trace, calls) to, as JSON. */
  trace?: string;
  /** The runner to use instead of the bundled one: its .dll, or an executable. */
  runner?: string;
  /** Where the runner keeps compiled expressions between runs. */
  cache?: string;
  /** Seconds one test may take. */
  timeout: number;
  /** Azure DevOps logging commands: on under Azure Pipelines (TF_BUILD), unless set. */
  azureDevOps?: boolean;
}

export type Args = TestArgs | { command: 'help' } | { command: 'version' };

export class UsageError extends Error {}

export const USAGE = `Usage: apim-policy test [paths...] [options]

Runs the policy tests (YAML files in tests/ folders of an APIOps extract) offline.

Options:
  --junit <file>      Write JUnit XML there, for PublishTestResults
  --filter <text>     Only run tests whose name contains this
  --trace <dir>       Write each test's run (steps, trace, calls) there as JSON
  --runner <path>     Use this policy runner instead of the bundled one (a .dll or an executable)
  --cache <dir>       Keep compiled expressions there between runs
  --timeout <s>       Seconds one test may take (default 60)
  --azure-devops      Report failures as Azure DevOps issues (on under Azure Pipelines)
  --no-azure-devops   Don't
  -h, --help          Show this
  -v, --version       Show the version

Exit codes: 0 every test passed, 1 a test failed, 2 a test couldn't run or nothing was found.
Reference: https://github.com/charliethomson/apim-extension/blob/main/docs/testing.md`;

export function parseArgs(argv: readonly string[]): Args {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) return { command: 'help' };
  if (argv[0] === '-v' || argv[0] === '--version') return { command: 'version' };
  const [command, ...rest] = argv;
  if (command !== 'test') throw new UsageError(`Unknown command '${command}'. The command is test: apim-policy test [paths...]`);
  const out: TestArgs = { command: 'test', paths: [], timeout: 60 };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${arg} needs a value.`);
      return v;
    };
    switch (arg) {
      case '--junit':
        out.junit = value();
        break;
      case '--filter':
        out.filter = value();
        break;
      case '--trace':
        out.trace = value();
        break;
      case '--runner':
        out.runner = value();
        break;
      case '--cache':
        out.cache = value();
        break;
      case '--timeout': {
        const v = value();
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout is a number of seconds, not '${v}'.`);
        out.timeout = n;
        break;
      }
      case '--azure-devops':
        out.azureDevOps = true;
        break;
      case '--no-azure-devops':
        out.azureDevOps = false;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}. See apim-policy --help.`);
        out.paths.push(arg);
    }
  }
  return out;
}
