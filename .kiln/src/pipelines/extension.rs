//! `extension.ci`, the gate, `extension.prerelease`, the Marketplace pre-release from `main`, and
//! `extension.release`, the Marketplace release.

use kiln::prelude::*;
use kiln::recipes::node::Npm;
use libci::version::Version;

use super::{IMAGE, apt, ensure_node};
use crate::VscePat;

/// What VS Code's Electron links against, plus a virtual display for it to draw on.
const ELECTRON_LIBS: &[&str] = &[
    "xvfb",
    "xauth",
    "libnss3",
    "libatk1.0-0",
    "libatk-bridge2.0-0",
    "libgtk-3-0",
    "libgbm1",
    "libasound2",
    "libxkbfile1",
    "libsecret-1-0",
    "libxss1",
    "libdrm2",
    "libxshmfence1",
];

/// Everything the extension and its packages are built and tested from.
const SOURCES: &[&str] = &[
    "packages/**",
    "extension/**",
    "bench/**",
    "scripts/ci/**",
    "package.json",
    "package-lock.json",
    "eslint.config.mjs",
    "tsconfig.base.json",
    "tsconfig.json",
    "vitest.config.mts",
    "vitest.shared.mts",
    ".kiln/src/pipelines/extension.rs",
    ".kiln/src/pipelines/mod.rs",
    ".kiln/src/main.rs",
    ".kiln/Cargo.toml",
    ".kiln/Cargo.lock",
];

/// `extension.ci`: typecheck, lint, every package's unit tests with its coverage floor, packaging
/// and the integration suite in VS Code. The C# engine's .NET checks are `engine.ci`.
pub fn ci() -> Pipeline {
    Pipeline::new("extension.ci")
        .describe("typecheck · lint · unit tests · package · integration")
        .on(Push::to("main").paths(SOURCES.iter().copied()))
        .on(Manual)
        .serialize(Always::cancel())
        // One job for everything node: the fleet has two Linux agents, and a separate
        // integration job would queue three deep behind them for a second `npm ci`.
        .job("node", |j| {
            j.on(Linux).image(IMAGE).cache(Npm::modules()).env("CI", "true").run(|ctx| {
                apt(ctx, ELECTRON_LIBS)?;
                ensure_node(ctx)?;
                Npm::ci(ctx).call()?;
                for script in ["typecheck", "lint", "test:coverage"] {
                    Npm::run(ctx, script).call()?;
                }
                package(ctx, &Version::derive(ctx)?.release_version(), Channel::Release)?;
                // A plain Xvfb in the background rather than xvfb-run, which hangs when it ends up
                // as the container's PID 1.
                ctx.run("sh", ["-c", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &"]).call()?;
                ctx.run("npm", ["run", "test:integration"]).env("DISPLAY", ":99").call().map(drop)
            })
        })
}

/// `extension.prerelease`: tests, packages and publishes every push to `main` that touches the
/// extension as a Marketplace pre-release, at the same `MAJOR.MINOR.<count>` a release from that
/// commit would get. Users who switch to the pre-release channel get each one; everyone else stays
/// on the last `v*` release.
///
/// A commit that carries a `v*` tag is skipped: `extension.release` publishes it as a release, and
/// the Marketplace holds one version number once, whichever channel takes it first.
pub fn prerelease() -> Pipeline {
    Pipeline::new("extension.prerelease")
        .describe("test, package and publish main as a Marketplace pre-release")
        .on(Push::to("main").paths(SOURCES.iter().copied()))
        // No `Manual`: a manual run starts every workflow that has one, `extension.release`
        // included, and both would publish the same version.
        //
        // Cancelled when superseded: the next push publishes a higher version anyway.
        .serialize(Always::cancel())
        .job("publish", |j| {
            j.on(Linux)
                .image(IMAGE)
                .cache(Npm::modules())
                .env("CI", "true")
                .needs_secrets(secrets!(VscePat))
                .run(|ctx| publish(ctx, Channel::PreRelease))
        })
}

/// `extension.release`: tests, packages and publishes to the Visual Studio Marketplace, on a
/// `v*` tag (the tag sets `MAJOR.MINOR`) and by hand. Fails red without the `vsce_pat` secret
/// rather than going green without publishing.
pub fn release() -> Pipeline {
    Pipeline::new("extension.release")
        .describe("test, package and publish the .vsix to the Visual Studio Marketplace")
        .on(Tag::matching(["v*"]))
        .on(Manual)
        // A cancelled publish can leave the Marketplace and the tag disagreeing.
        .serialize(Never::cancel())
        .job("publish", |j| {
            j.on(Linux)
                .image(IMAGE)
                .cache(Npm::modules())
                .env("CI", "true")
                .needs_secrets(secrets!(VscePat))
                .run(|ctx| publish(ctx, Channel::Release))
        })
}

/// Which Marketplace channel a publish lands on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Channel {
    Release,
    PreRelease,
}

/// Test, package and publish on `channel`. Fails red without the `vsce_pat` secret rather than
/// going green without publishing.
fn publish(ctx: &Ctx, channel: Channel) -> Result<()> {
    let v = Version::derive(ctx)?;
    let version = v.release_version();
    if channel == Channel::PreRelease {
        // `Version::derive` fetched the tags, so a tag pushed with this commit is here.
        let tags = ctx.run("git", ["tag", "--points-at", "HEAD", "--list", "v*"]).capture()?;
        if !tags.trim().is_empty() {
            ctx.info(format!("HEAD is tagged {}; extension.release publishes it", tags.trim()));
            return Ok(());
        }
    }
    let token = ctx.secret(VscePat);
    let token = token.require()?;
    ensure_node(ctx)?;
    Npm::ci(ctx).call()?;
    Npm::run(ctx, "typecheck").call()?;
    Npm::run(ctx, "test").call()?;
    if channel == Channel::Release {
        refuse_taken_by_prerelease(ctx, &version)?;
    }
    let vsix = package(ctx, &version, channel)?;
    ctx.step("publish", |ctx| {
        // vsce reads the token from VSCE_PAT; it never goes on the command line. Re-running for a
        // version that's already published is a no-op.
        let mut cmd = ctx.run("npx", ["vsce", "publish", "--skip-duplicate", "--packagePath"]).arg(&vsix);
        if channel == Channel::PreRelease {
            cmd = cmd.arg("--pre-release");
        }
        cmd.env("VSCE_PAT", token).call().map(drop)
    })
}

/// A release run by hand on a commit `main` already published as a pre-release would collide on
/// the version, and `--skip-duplicate` would turn that into a green run that published nothing.
fn refuse_taken_by_prerelease(ctx: &Ctx, version: &str) -> Result<()> {
    const QUERY: &str = "const v=JSON.parse(require('fs').readFileSync(0)).versions.find(v=>v.version===process.argv[1]);\
                         console.log(v&&(v.properties||[]).some(p=>p.key==='Microsoft.VisualStudio.Code.PreRelease')?'pre-release':'')";
    let shown = ctx
        .run("sh", ["-c", "npx vsce show thmsn-dev.apim-policy --json | node -e \"$0\" \"$1\"", QUERY, version])
        .capture()?;
    if shown.trim() == "pre-release" {
        return Err(ctx.err(format!(
            "{version} is already on the Marketplace as a pre-release, so it can't be released. Tag a \
             new commit with v<MAJOR>.<MINOR> and release that"
        )));
    }
    Ok(())
}

/// `npm run package` with the version derived once and handed to `scripts/ci/version.sh`, which
/// honours it. Returns the `.vsix` path.
fn package(ctx: &Ctx, version: &str, channel: Channel) -> Result<String> {
    ctx.info(format!("packaging apim-policy {version}"));
    let mut cmd = ctx.run("npm", ["run", "package", "-w", "extension"]).env("RELEASE_VERSION", version);
    if channel == Channel::PreRelease {
        // Appended to `vsce package`: the flag goes in the .vsix manifest, and `vsce publish
        // --pre-release` refuses a package without it.
        cmd = cmd.args(["--", "--pre-release"]);
    }
    cmd.call()?;
    // vsce writes it beside the extension's own package.json.
    Ok(format!("extension/apim-policy-{version}.vsix"))
}
