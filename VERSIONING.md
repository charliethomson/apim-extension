# Versioning

The version is derived from git and never stored: `MAJOR.MINOR.<total commit count>`.
`MAJOR.MINOR` comes from the latest `vMAJOR.MINOR` tag, and the commit count makes it
monotonic. Full doctrine: [versioning](https://standards.thmsn.dev/d/versioning).

- `extension/package.json` `version` is a placeholder (`0.0.1`). Don't bump it; the packages'
  `0.0.0` likewise.
- [`scripts/ci/version.sh`](scripts/ci/version.sh) prints `RELEASE_VERSION`, `COMMIT` and
  `DIRTY` for `eval`. It honours a `RELEASE_VERSION` CI already computed, and refuses a shallow
  clone or a missing tag instead of guessing.
- `npm run package` passes that version to vsce and the commit to the bundle, so the `.vsix`
  and the installed extension report the version, and the extension's output channel logs
  both on startup.
- In CI, `extension.release` derives it with libci's `Version::derive` and hands it to
  `npm run package` as `RELEASE_VERSION`.
- Bump `MAJOR.MINOR` by tagging: `git tag v0.2.0 && git push --tags`.
- Pushing a `v*` tag also publishes that build to the Marketplace (`extension.release`, in
  [`.kiln/src/pipelines/extension.rs`](.kiln/src/pipelines/extension.rs)).
