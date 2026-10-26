//! `cli.prerelease` and `cli.release`: the `apim-policy` CLI on public npm as
//! `@charliethomson/apim-cli`, so an Azure DevOps hosted agent (which has node and .NET 10)
//! runs it with `npx`. Every push to `main` that touches it goes out under the `next` dist-tag; a
//! `v*` tag puts that version under `latest`.

use kiln::prelude::*;
use kiln::recipes::node::Npm;
use libci::version::Version;

use super::engine::{dotnet_cache, install_dotnet};
use super::{IMAGE, ensure_node};
use crate::NpmToken;

/// The package name on npm.
const PACKAGE: &str = "@charliethomson/apim-cli";

/// Everything the packed CLI is built from: its own source, the packages it bundles, and the
/// runner shipped inside it.
const SOURCES: &[&str] = &[
    "cli/**",
    "packages/**",
    "runner/**",
    "package.json",
    "package-lock.json",
    "scripts/ci/version.sh",
    ".kiln/src/pipelines/cli.rs",
    ".kiln/src/pipelines/engine.rs",
    ".kiln/src/pipelines/mod.rs",
    ".kiln/src/main.rs",
    ".kiln/Cargo.toml",
    ".kiln/Cargo.lock",
];

/// `cli.prerelease`: packs, checks and publishes every push to `main` that touches the CLI under
/// the `next` dist-tag, at the `MAJOR.MINOR.<count>` a release from that commit would get. A
/// commit that carries a `v*` tag is left to `cli.release`.
pub fn prerelease() -> Pipeline {
    Pipeline::new("cli.prerelease")
        .describe("pack, check and publish main to npm under next")
        .on(Push::to("main").paths(SOURCES.iter().copied()))
        // No `Manual`: a manual run starts every workflow that has one, `cli.release` included.
        //
        // Cancelled when superseded: the next push publishes a higher version anyway.
        .serialize(Always::cancel())
        .job("publish", |j| {
            j.on(Linux)
                .image(IMAGE)
                .cache(dotnet_cache())
                .cache(Npm::modules())
                .env("CI", "true")
                .needs_secrets(secrets!(NpmToken))
                .run(|ctx| publish(ctx, DistTag::Next))
        })
}

/// `cli.release`: packs, checks and publishes under `latest`, on a `v*` tag and by hand. A version
/// `cli.prerelease` already published only gets the `latest` tag moved to it. Fails red without the
/// `npm_token` secret rather than going green without publishing.
pub fn release() -> Pipeline {
    Pipeline::new("cli.release")
        .describe("pack, check and publish the CLI to npm under latest")
        .on(Tag::matching(["v*"]))
        .on(Manual)
        // A cancelled publish can leave npm and the tag disagreeing.
        .serialize(Never::cancel())
        .job("publish", |j| {
            j.on(Linux)
                .image(IMAGE)
                .cache(dotnet_cache())
                .cache(Npm::modules())
                .env("CI", "true")
                .needs_secrets(secrets!(NpmToken))
                .run(|ctx| publish(ctx, DistTag::Latest))
        })
}

/// Which npm dist-tag a publish lands under.
#[derive(Clone, Copy, PartialEq, Eq)]
enum DistTag {
    Latest,
    Next,
}

impl DistTag {
    fn name(self) -> &'static str {
        match self {
            DistTag::Latest => "latest",
            DistTag::Next => "next",
        }
    }
}

fn publish(ctx: &Ctx, tag: DistTag) -> Result<()> {
    let version = Version::derive(ctx)?.release_version();
    if tag == DistTag::Next {
        // `Version::derive` fetched the tags, so a tag pushed with this commit is here.
        let tags = ctx.run("git", ["tag", "--points-at", "HEAD", "--list", "v*"]).capture()?;
        if !tags.trim().is_empty() {
            ctx.info(format!("HEAD is tagged {}; cli.release publishes it", tags.trim()));
            return Ok(());
        }
    }
    let token = ctx.secret(NpmToken);
    let token = token.require()?;

    let dotnet = install_dotnet(ctx)?;
    let sdk = dotnet.trim_end_matches("/dotnet").to_string();
    let path = format!("{sdk}:{}", std::env::var("PATH").unwrap_or_default());
    ensure_node(ctx)?;
    Npm::ci(ctx).call()?;
    ctx.step("pack", |ctx| {
        ctx.run("npm", ["run", "package", "-w", PACKAGE])
            .env("RELEASE_VERSION", version.as_str())
            .env("DOTNET_ROOT", sdk.as_str())
            .env("PATH", path.as_str())
            .call()
            .map(drop)
    })?;
    ctx.step("the packed CLI over the fixtures", |ctx| {
        ctx.run(
            "node",
            ["cli/dist/apim-policy.js", "test", "packages/fixtures/files/apiops", "packages/testing/test/extract"],
        )
        .env("DOTNET_ROOT", sdk.as_str())
        .env("PATH", path.as_str())
        .call()
        .map(drop)
    })?;

    // npm reads the token from the environment through this file; it's never written down.
    let npmrc = ctx.workspace().join(".kiln-npmrc");
    ctx.run("sh", ["-c", "printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\\n' > \"$0\"", npmrc.as_str()])
        .call()?;
    let npm = |args: &[&str]| {
        ctx.run("npm", args.iter().copied()).env("NPM_TOKEN", token).env("NPM_CONFIG_USERCONFIG", npmrc.as_str())
    };
    let spec = format!("{PACKAGE}@{version}");
    let published = ctx.run("sh", ["-c", "npm view \"$0\" version 2>/dev/null || true", spec.as_str()]).capture()?;
    if published.trim() == version {
        if tag == DistTag::Next {
            ctx.info(format!("{spec} is already on npm"));
            return Ok(());
        }
        return ctx.step("tag latest", |_| npm(&["dist-tag", "add", spec.as_str(), "latest"]).call().map(drop));
    }
    // `./` so npm reads it as a file: `cli/x.tgz` would be GitHub shorthand for a repository.
    let tarball = format!("./cli/charliethomson-apim-cli-{version}.tgz");
    ctx.step("publish", |_| {
        npm(&["publish", tarball.as_str(), "--access", "public", "--tag", tag.name()]).call().map(drop)
    })
}
