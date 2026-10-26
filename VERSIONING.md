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
- In CI, `extension.release` and `extension.prerelease` derive it with libci's
  `Version::derive` and hand it to `npm run package` as `RELEASE_VERSION`.
- `npm run package:cli` does the same for the `apim-policy` CLI: the tarball is packed at the
  derived version and `apim-policy --version` reports it with the commit. `cli.prerelease`
  publishes each push to `main` to npm under the `next` dist-tag; a `v*` tag publishes under
  `latest` (`cli.release`), or moves `latest` to that version if `next` already has it.
- Bump `MAJOR.MINOR` by tagging: `git tag v0.2.0 && git push --tags`.
- Pushing a `v*` tag also publishes that build to the Marketplace (`extension.release`, in
  [`.kiln/src/pipelines/extension.rs`](.kiln/src/pipelines/extension.rs)).
- Every push to `main` that touches the extension is published as a Marketplace pre-release
  (`extension.prerelease`) at the version that commit derives. A pre-release and a release can't
  share a version number, so a commit pushed together with its `v*` tag skips the pre-release
  and goes out as the release, and a manual `extension.release` on a commit that already went
  out as a pre-release fails. Tag a new commit to release instead.
