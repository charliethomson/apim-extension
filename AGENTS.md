# AGENTS

This repo follows the shared engineering standards vendored at [`standards/`](standards/)
(a git submodule). **Read [`standards/AGENTS.md`](standards/AGENTS.md) first** — it is the
entrypoint and indexes every rule.

- **Archetype:** cli-tool — see `standards/docs/archetypes/cli-tool.md`.
- **Identifier:** `dev.thmsn.apim-policy`
- Treat the standards as binding defaults. Repo-specific overrides (if any) are noted
  below; everything else defers to `standards/`.
- **[`README.md`](README.md) is the front door.** Change behaviour it describes — a command,
  the layout, what's generated, what's still a stub — and update it in the same commit. Ran
  a command from it that didn't work? Fix it before reporting back.
  ([`standards/docs/readmes.md`](standards/docs/readmes.md))

## Shortcuts — read before you go digging

[`SHORTCUTS.md`](SHORTCUTS.md) holds the answers to the operational questions that get
asked repeatedly here: which host is prod, what version is live, where the logs are.

- **Before** any environment recon — anything about the *running system* rather than the
  source — check it. The answer is often already one command.
- **After** any environment recon that cost more than a couple of commands, append what you
  learned, in the same turn. Record the **route** (endpoint, command, mechanism), never the
  **reading** ("prod is on 1.4.212" is stale by tomorrow).
- If a shortcut is wrong, fix it while you have the answer.

Convention: [`standards/docs/shortcuts.md`](standards/docs/shortcuts.md).

## Repo-specific overrides

This repo is a VS Code extension, which none of the archetypes describe. `cli-tool` is the
closest fit (one artifact, distributed and installed), so read it for distribution and
versioning and ignore the Rust-specific parts.

- **Language:** TypeScript bundled with esbuild, not Rust. The Rust conventions,
  `libbuildinfo`, `product_name!`, tarpaulin and the Docker/Komodo templates don't apply.
- **Artifact:** a `.vsix` built with `@vscode/vsce`, not a registry `kind = cli` binary.
  `package.json` `version` stays a placeholder (`0.0.1`). `npm run package` derives
  `MAJOR.MINOR.<count>` with `scripts/ci/version.sh` and passes it to vsce, so the installed
  extension reports the real version.
- **Identifier:** the VS Code extension id is `thmsn.apim-policy` (marketplace form
  `publisher.name`). `dev.thmsn.apim-policy` is used anywhere a reverse-domain id fits.
- **Testing:** unit tests run on vitest. The coverage floor of 80% applies to `src/parser/`,
  `src/sourceMap.ts`, `src/policy/` and the pure modules in `src/csharp/` (see
  `vitest.config.ts`), which is the logic surface.
  The VS Code glue in `src/extension.ts` and `src/features/` is wiring, and it's covered by
  `@vscode/test-electron` integration tests instead.
- **CI:** [`.woodpecker/extension.ci.yml`](.woodpecker/extension.ci.yml), on the Linux
  Docker agents. It needs no secrets or host volumes, so the repo doesn't have to be marked
  trusted. The `weekly-audit` cron has to be created in the Woodpecker UI before the scheduled
  audit runs. The integration step downloads VS Code, the C# extension and the .NET 10 SDK each
  run, so agents need internet access.
- **Design:** see [`PLAN.md`](PLAN.md).

## Keeping standards current

```sh
git submodule update --remote standards
```
