//! `extension.ci`, the gate, and `extension.release`, the Marketplace publish.

use kiln::prelude::*;
use kiln::recipes::git::Drift;
use kiln::recipes::node::Npm;
use libci::version::Version;

use super::{IMAGE, apt, ensure_node};
use crate::VscePat;

/// The .NET SDK the stubs build and the generators run on. Pinned exactly because a different
/// reference pack can change `data/*.json`, and the drift check would then fail on nothing.
const DOTNET_SDK: &str = "10.0.103";

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

/// Everything the extension, its tests and its generated data are built from.
const SOURCES: &[&str] = &[
    "src/**",
    "test/**",
    "bench/**",
    "data/**",
    "stubs/**",
    "syntaxes/**",
    "snippets/**",
    "images/**",
    "tools/**",
    "scripts/ci/**",
    "package.json",
    "package-lock.json",
    "esbuild.mjs",
    "eslint.config.mjs",
    "tsconfig.json",
    "vitest.config.ts",
    "language-configuration.json",
    ".vscodeignore",
    ".kiln/src/pipelines/extension.rs",
    ".kiln/src/pipelines/mod.rs",
    ".kiln/src/main.rs",
    ".kiln/Cargo.toml",
    ".kiln/Cargo.lock",
];

/// `extension.ci`: typecheck, lint, unit tests with the coverage floor, packaging and the
/// integration suite in VS Code; beside it, the stubs compile check and the generated-data drift
/// check.
pub fn ci() -> Pipeline {
    Pipeline::new("extension.ci")
        .describe("typecheck · lint · unit tests · package · stubs · generated data · integration")
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
                package(ctx)?;
                // A plain Xvfb in the background rather than xvfb-run, which hangs when it ends up
                // as the container's PID 1.
                ctx.run("sh", ["-c", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &"]).call()?;
                ctx.run("npm", ["run", "test:integration"]).env("DISPLAY", ":99").call().map(drop)
            })
        })
        .job("dotnet", |j| {
            j.on(Linux).image(IMAGE).cache(dotnet_cache()).run(|ctx| {
                let dotnet = install_dotnet(ctx)?;
                ctx.step("stubs compile at C# 7.3", |ctx| ctx.run(&dotnet, ["build", "test/stubs"]).call().map(drop))?;
                Drift::check()
                    .named("generated data")
                    .paths(["data"])
                    .generator(format!(
                        "dotnet run tools/gen-bcl-types.cs && dotnet run tools/gen-csharp-model.cs (SDK {DOTNET_SDK})"
                    ))
                    .regenerate(ctx, |ctx| {
                        ctx.run(&dotnet, ["run", "tools/gen-bcl-types.cs"]).call()?;
                        ctx.run(&dotnet, ["run", "tools/gen-csharp-model.cs"]).call().map(drop)
                    })
            })
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
            j.on(Linux).image(IMAGE).cache(Npm::modules()).env("CI", "true").needs_secrets(secrets!(VscePat)).run(
                |ctx| {
                    ensure_node(ctx)?;
                    Npm::ci(ctx).call()?;
                    Npm::run(ctx, "typecheck").call()?;
                    Npm::run(ctx, "test").call()?;
                    let vsix = package(ctx)?;
                    let token = ctx.secret(VscePat);
                    let token = token.require()?;
                    ctx.step("publish", |ctx| {
                        // vsce reads the token from VSCE_PAT; it never goes on the command line.
                        // Re-running for a version that's already published is a no-op.
                        ctx.run("npx", ["vsce", "publish", "--skip-duplicate", "--packagePath"])
                            .arg(&vsix)
                            .env("VSCE_PAT", token)
                            .call()
                            .map(drop)
                    })
                },
            )
        })
}

/// `npm run package` with the version derived once here and handed to `scripts/ci/version.sh`,
/// which honours it. Returns the `.vsix` path.
fn package(ctx: &Ctx) -> Result<String> {
    let v = Version::derive(ctx)?;
    ctx.info(format!("packaging apim-policy {}", v.release_version()));
    ctx.run("npm", ["run", "package"]).env("RELEASE_VERSION", v.release_version()).call()?;
    Ok(format!("apim-policy-{}.vsix", v.release_version()))
}

fn dotnet_cache() -> Cache {
    Cache::named("dotnet-sdk").max_gb(2)
}

/// The pinned SDK, installed into the job's cache unless it's already there. Returns the
/// `dotnet` binary.
fn install_dotnet(ctx: &Ctx) -> Result<String> {
    let root = ctx.cache_dir(dotnet_cache())?.join(DOTNET_SDK);
    let dotnet = root.join("dotnet").to_string();
    if ctx.exists(&dotnet) {
        return Ok(dotnet);
    }
    ctx.step("install .NET SDK", |ctx| {
        // The SDK's runtime needs ICU, which the toolchain image (buildpack-deps) already carries.
        ctx.run("mkdir", ["-p", root.as_str()]).call()?;
        let script = root.join("dotnet-install.sh");
        ctx.run("curl", ["-fsSL", "https://dot.net/v1/dotnet-install.sh", "-o"]).arg(script.as_str()).call()?;
        ctx.run("bash", [script.as_str(), "--version", DOTNET_SDK, "--install-dir", root.as_str(), "--no-path"])
            .call()
            .map(drop)
    })?;
    Ok(dotnet)
}
