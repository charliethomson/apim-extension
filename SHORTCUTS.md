# Shortcuts

How to answer the questions that get asked about **apim-policy** over and over — prod URLs,
what's live, where the logs are. One command each, so nobody re-derives them from the
workflows and compose files every session.

**If you are an agent:**

- **Read this before any environment recon.** Question about the running system (prod,
  deploys, versions, logs, metrics, health)? The answer may already be below.
- **Write to it after any environment recon.** If answering took more than a couple of
  commands and the answer is durable, append an entry — in the same turn, before you
  report back.
- **Record the route, not the reading.** The endpoint, command, or mechanism — never
  "prod is on 1.4.212" or "deployed at 14:32". Those are stale within the hour.
- **Fix what's broken.** Ran a shortcut and it failed or the output changed? Correct the
  entry now; you're the one context that knows the new answer. Bump `_Verified:_` when a
  shortcut works.
- **No secrets.** Reference an env var or Komodo Variable; never paste the value.

Keep it under ~15 entries. Full convention: [shortcuts](https://standards.thmsn.dev/d/shortcuts).

---

## What version is live on the Marketplace?

```sh
npx --no-install vsce show thmsn-dev.apim-policy --json | node -p 'const v=JSON.parse(require("fs").readFileSync(0)).versions[0]; v.version + " " + v.lastUpdated'
```

`versions[0]` is the newest of either channel. Add `&& !v.properties.some(p => p.key ===
"Microsoft.VisualStudio.Code.PreRelease")` to a `.find` instead to get the newest release.
Every push to `main` touching the extension publishes a pre-release (`extension.prerelease`);
a `v*` tag or a manual run of `extension.release` publishes a release.

_Verified: 2026-10-23_

## What version would CI build or publish from here?

```sh
eval "$(scripts/ci/version.sh)"; echo "$RELEASE_VERSION $COMMIT dirty=$DIRTY"
```

The same rule the release pipeline applies (libci's `Version::derive`), so this is the version a
publish from this commit gets. It needs full history and tags, and refuses a shallow clone.

_Verified: 2026-10-23_

## Did CI pass on a commit?

```sh
gh api repos/charliethomson/apim-extension/commits/<sha>/statuses --jq 'reduce .[] as $s ({}; .[$s.context] //= $s) | .[] | [.context,.state,.target_url] | @tsv'
```

Woodpecker (ci.thmsn.dev) reports each pipeline as a `ci/woodpecker/push/<pipeline>` status on
the commit, newest first, with a link to the run; the query keeps the newest per pipeline. CI runs on push only, so a local commit has none.

_Verified: 2026-10-23_

## Why did a Woodpecker pipeline error with no steps?

```sh
C="$HOME/Library/Application Support/woodpecker/contexts.json"; S=$(jq -r .contexts.default.server_url "$C"); T=$(jq -r .contexts.default.token "$C"); curl -fsS -H "Authorization: Bearer $T" "$S/api/repos/21/pipelines/<number>" | jq '{status, errors, workflows: [.workflows[]? | {name, state}]}'
```

`woodpecker-cli pipeline ls charliethomson/apim-extension` lists runs, and `pipeline ps` lists
steps. A run in `error` with no steps was refused before it started, and the CLI doesn't show
why: the reason is in the API's `errors` field (repo id 21). One refused workflow refuses the
whole push, gates included. A secret's allowed events are under `woodpecker-cli repo secret ls`.

_Verified: 2026-10-26_

## Which build is a running VS Code using?

The first line of the **APIM Policy** output channel (View → Output) once a policy is open:
`apim-policy <version> (<commit>[, dirty])`. A dev build (Run Extension) reports the
`extension/package.json` placeholder `0.0.1`; a packaged build reports the derived version.

_Verified: 2026-10-23_

<!--
Format — one heading per question, phrased the way it actually gets asked:

## Is it up to date in prod?

```sh
curl -s https://<host>/api/build | jq -r '.version, .commit'
```

Compare against local: `git rev-list --count HEAD` (version is the commit count). Deploys
are Watchtower-polled every ~5m, so "pushed" ≠ "live".

_Verified: YYYY-MM-DD_

Worth answering early, if this repo has them:
  - Which host is prod? staging?
  - What version/commit is live right now?
  - What turns a push into a running container, and how long does it take?
  - Where are the logs? (the actual query, not "Grafana")
  - Where are the metrics/dashboards?
  - Where do images/artifacts get published?
  - How do I run this locally against real data?
-->
