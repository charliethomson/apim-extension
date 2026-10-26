//! `engine.ci`: the C# engine's .NET checks, apart from `extension.ci` so a change that doesn't
//! touch the engine doesn't install an SDK.

use kiln::prelude::*;
use kiln::recipes::git::Drift;

use super::{IMAGE, KILN};

/// The .NET SDK the stubs build and the generators run on. Pinned exactly because a different
/// reference pack can change the generated assets, and the drift check would then fail on nothing.
const DOTNET_SDK: &str = "10.0.103";

/// The engine package: its stubs, generated assets, generators and the stubs check.
const ENGINE: &str = "packages/csharp-engine";

/// `engine.ci`: the stubs compile at C# 7.3, and the generated type model and BCL index are what
/// the generators produce.
pub fn ci() -> Pipeline {
    Pipeline::new("engine.ci")
        .describe("stubs compile at C# 7.3 · generated assets")
        .on(Push::to("main").paths(["packages/csharp-engine/**", ".kiln/src/pipelines/engine.rs"].into_iter().chain(KILN)))
        .on(Manual)
        .serialize(Always::cancel())
        .job("dotnet", |j| {
            j.on(Linux).image(IMAGE).cache(dotnet_cache()).run(|ctx| {
                let dotnet = install_dotnet(ctx)?;
                let engine = ctx.workspace().join(ENGINE);
                ctx.step("stubs compile at C# 7.3", |ctx| ctx.run(&dotnet, ["build", "stubs-check"]).in_dir(&engine).call().map(drop))?;
                Drift::check()
                    .named("generated assets")
                    .paths([format!("{ENGINE}/assets")])
                    .generator(format!(
                        "cd {ENGINE} && dotnet run tools/gen-bcl-types.cs && dotnet run tools/gen-csharp-model.cs (SDK {DOTNET_SDK})"
                    ))
                    .regenerate(ctx, |ctx| {
                        ctx.run(&dotnet, ["run", "tools/gen-bcl-types.cs"]).in_dir(&engine).call()?;
                        ctx.run(&dotnet, ["run", "tools/gen-csharp-model.cs"]).in_dir(&engine).call().map(drop)
                    })
            })
        })
}

pub(super) fn dotnet_cache() -> Cache {
    Cache::named("dotnet-sdk").max_gb(2)
}

/// The pinned SDK, installed into the job's cache unless it's already there. Returns the
/// `dotnet` binary. `runner.ci` builds on the same one.
pub(super) fn install_dotnet(ctx: &Ctx) -> Result<String> {
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
