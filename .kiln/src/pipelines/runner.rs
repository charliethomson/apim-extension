//! `runner.ci`: the policy test runner's .NET build and tests, apart from `extension.ci` so a
//! change that doesn't touch the runner doesn't install an SDK.

use kiln::prelude::*;

use super::engine::{dotnet_cache, install_dotnet};
use super::{IMAGE, KILN};

/// `runner.ci`: the runner builds with warnings as errors and its tests pass. It compiles the
/// engine's `ApimContext.cs`, so a change there runs it too.
pub fn ci() -> Pipeline {
    Pipeline::new("runner.ci")
        .describe("policy test runner: build · tests")
        .on(Push::to("main").paths(
            [
                "runner/**",
                "packages/csharp-engine/assets/ApimContext.cs",
                ".kiln/src/pipelines/runner.rs",
                ".kiln/src/pipelines/engine.rs",
            ]
            .into_iter()
            .chain(KILN),
        ))
        .on(Manual)
        .serialize(Always::cancel())
        .job("dotnet", |j| {
            j.on(Linux).image(IMAGE).cache(dotnet_cache()).run(|ctx| {
                let dotnet = install_dotnet(ctx)?;
                let runner = ctx.workspace().join("runner");
                ctx.step("runner tests", |ctx| {
                    ctx.run(&dotnet, ["test", "PolicyRunner.slnx"]).in_dir(&runner).call().map(drop)
                })
            })
        })
}
