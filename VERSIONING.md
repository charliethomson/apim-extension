# Versioning

The version is derived from git and never stored: `MAJOR.MINOR.<total commit count>`.
`MAJOR.MINOR` comes from the latest `v[0-9]*` tag (`0.0` if there is none), and the
commit count makes it monotonic. Full doctrine: [`standards/docs/versioning.md`](standards/docs/versioning.md).

- `package.json` `version` is a placeholder (`0.0.1`). Don't bump it.
- [`scripts/ci/version.sh`](scripts/ci/version.sh) prints the version. It honours
  `RELEASE_VERSION` if CI already computed it.
- `npm run package` passes that version to vsce, so the `.vsix` and the installed extension
  report it.
- Bump `MAJOR.MINOR` by tagging: `git tag v0.2.0 && git push --tags`.
