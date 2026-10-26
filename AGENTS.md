Standards: archetype=cli-tool product=apim-policy — rules via the `standards` MCP (https://standards.thmsn.dev). Repo-specific overrides below.

# AGENTS

- **Archetype:** cli-tool, see the `archetypes/cli-tool` doc via the `standards` MCP.
- **Identifier:** `dev.thmsn.apim-policy`
- Treat the standards as binding defaults. Repo-specific overrides are noted below;
  everything else defers to the standards.
- **[`README.md`](README.md) is the front door.** Change behaviour it describes — a command,
  the layout, what's generated, what's still a stub — and update it in the same commit. Ran
  a command from it that didn't work? Fix it before reporting back.
  ([readmes](https://standards.thmsn.dev/d/readmes))

## Shortcuts — read before you go digging

[`SHORTCUTS.md`](SHORTCUTS.md) holds the answers to the operational questions that get
asked repeatedly here: which host is prod, what version is live, where the logs are.

- **Before** any environment recon — anything about the *running system* rather than the
  source — check it. The answer is often already one command.
- **After** any environment recon that cost more than a couple of commands, append what you
  learned, in the same turn. Record the **route** (endpoint, command, mechanism), never the
  **reading** ("prod is on 1.4.212" is stale by tomorrow).
- If a shortcut is wrong, fix it while you have the answer.

Convention: [shortcuts](https://standards.thmsn.dev/d/shortcuts).

## Repo-specific overrides

This repo is a VS Code extension, which none of the archetypes describe. `cli-tool` is the
closest fit (one artifact, distributed and installed), so read it for distribution and
versioning and ignore the Rust-specific parts.

- **Language:** TypeScript bundled with esbuild, not Rust. The Rust conventions,
  `libbuildinfo`, `product_name!`, tarpaulin and the Docker/Komodo templates don't apply, except
  that the `.kiln/` crate follows the Rust conventions.
- **Layout:** `runner/` is the one .NET project outside the engine: the policy test runner
  (`docs/policy-testing-plan.md`). It compiles the engine's `ApimContext.cs` with `APIM_RUNNER`
  defined, which swaps the stub's throw-null helper classes for its own working ones, so a
  change to the stubs' interfaces has to build there too.
- **Layout:** an npm workspace shaped like a Rust product workspace. Libraries in `packages/*`
  (`@charliethomson/apim-<name>`, private, `0.0.0`, exporting `src/index.ts` with no build step) play the
  crates' part, and `extension/` is the one deliverable. Dependencies point one way (README's
  Layout table), only `extension/` imports `vscode`, and `npm run lint` enforces both plus
  declared-only, exports-only imports between packages. A new package declares its workspace
  deps in its `package.json` and gets a row in the README table.
- **Artifact:** a `.vsix` built with `@vscode/vsce` from `extension/`, not a registry `kind = cli`
  binary. `extension/package.json` `version` stays a placeholder (`0.0.1`). `npm run package` derives
  `MAJOR.MINOR.<count>` with `scripts/ci/version.sh` and passes it to vsce, so the installed
  extension reports the real version.
- **Package names:** every workspace package is `@charliethomson/apim-<name>` (`apim-core`,
  `apim-testing`, `apim-cli`, `apim-bench`). The extension alone stays `apim-policy`, since vsce
  makes the Marketplace id from it.
- **Second artifact:** `cli/` (`@charliethomson/apim-cli`, command `apim-policy`, id
  `dev.thmsn.apim-policy.cli`) packs an npm tarball with `npm run package:cli`: the esbuild bundle
  plus a portable Release publish of `runner/`, at the derived version (`cli/pack.mjs`;
  `cli/package.json` keeps `0.0.1`).
- **Publishing the CLI:** to public npm, not the registry the cli-tool archetype names. Its users
  run it on Azure DevOps hosted agents, which have node and .NET 10, so `npx` needs no install
  step and no reach into the homelab. `cli.prerelease` publishes each push to `main` that touches
  it under the `next` dist-tag; `cli.release` publishes `v*` tags (or moves `latest` to a version
  `next` already has).
- **Identifier:** the VS Code extension id is `thmsn-dev.apim-policy` (marketplace form
  `publisher.name`). `dev.thmsn.apim-policy` is used anywhere a reverse-domain id fits.
- **Testing:** unit tests run on vitest, per package. Every package under `packages/` has the 80%
  coverage floor (`vitest.shared.mts`), met by its own tests, so a contract is tested in the
  package that owns it. The VS Code glue in `extension/src/` is wiring, and it's covered by
  `@vscode/test-electron` integration tests instead.
- **CI is kiln.** The pipelines are Rust in [`.kiln/`](.kiln/src/main.rs) (kiln, plus libci's
  `version`, `audit` and `secrets`); `.woodpecker/*.yml` is generated from it and never edited by
  hand. After changing a pipeline, regenerate both projections and commit them with the change:
  `cargo run --manifest-path .kiln/Cargo.toml -- emit woodpecker` and
  `cargo run --manifest-path .kiln/Cargo.toml -- describe > .kiln/lock.json`.
  `cargo run --manifest-path .kiln/Cargo.toml -- check` validates them, and the `repo.checks`
  pipeline fails when `.woodpecker/` or the lockfile is stale. `emit` never deletes: a pipeline
  dropped from `main.rs` needs its `.yml` deleted by hand.
  - `extension.ci`: typecheck, lint, every package's unit tests with coverage, packaging and the
    integration suite in one job. `engine.ci`: on `packages/csharp-engine` changes, the stubs
    build and the generated-assets drift check (.NET SDK 10.0.103, cached). `policy-tests.ci`: on
    `runner/`, `cli/`, `packages/testing`, the fixtures or `ApimContext.cs` changes, the runner's
    build and xunit tests on the same SDK, `@charliethomson/apim-testing`'s suite against that runner (its
    end-to-end tests skip wherever no runner is built), the CLI's typecheck, lint and tests, and
    the packed CLI over the fixtures. `extension.ci` doesn't watch `cli/`, so a CLI-only change
    doesn't publish an extension pre-release. `audit.ci`: libci's `AuditGate` over `npm audit`, with `audit-exceptions.json`.
    `repo.checks`: `.woodpecker/` and the lockfile match a fresh emit, and `.kiln/` passes
    `cargo fmt --check` and clippy pedantic (`[lints]` in `.kiln/Cargo.toml`) with `-D warnings`.
    `extension.release`: publishes to the Visual Studio Marketplace on `v*` tags or by hand.
    `cli.prerelease` and `cli.release`: the CLI to npm under `next` and `latest`, packed and run
    over the fixtures first.
    `extension.prerelease`: publishes each push to `main` that touches the extension as a
    Marketplace pre-release, skipping a commit that carries a `v*` tag.
  - **Push-only.** `.kiln/` depends on the private kiln and libci, so jobs fetch them with the
    `ssh_key` checkout key, and kiln refuses pull-request triggers on such a repo. Changes are
    gated when they land on `main`.
  - **Woodpecker setup, by hand:** the `ssh_key` secret (a read-only deploy key for kiln and
    libci), `vsce_pat` (an Azure DevOps token with Marketplace (Manage) scope for the
    `thmsn-dev` publisher) and `npm_token` (an npm granular access token with read and write on
    `@charliethomson/apim-cli`; the first publish needs one scoped to all of `@charliethomson`,
    since the package doesn't exist yet); the repo's **trusted** (volumes) flag, without which Woodpecker
    refuses every generated workflow (they mount the npm and .NET caches); a cron named
    `audit.ci` for the weekly audit; and "cancel previous pipelines" on for push only, so a
    manual or tag release is never cancelled. Jobs download node, VS Code and NuGet packages,
    so agents need internet access.
- **Design:** see [`PLAN.md`](PLAN.md).
