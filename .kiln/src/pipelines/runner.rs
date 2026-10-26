//! `runner.ci`: the policy test runner's .NET build and tests, then the TypeScript test package's
//! suite against the runner it just built, apart from `extension.ci` so a change that doesn't
//! touch either doesn't install an SDK.

use kiln::prelude::*;
use kiln::recipes::node::Npm;

use super::engine::{dotnet_cache, install_dotnet};
use super::{IMAGE, KILN, ensure_node};

/// Where `dotnet test` leaves the runner, which the test package's end-to-end suite runs.
const BUILT_RUNNER: &str = "runner/PolicyRunner/bin/Debug/net10.0/apim-policy-runner.dll";

/// `runner.ci`: the runner builds with warnings as errors and its tests pass, and the test
/// package's suite passes against it (its end-to-end test is skipped wherever no runner is
/// built, `extension.ci` included). It compiles the engine's `ApimContext.cs`, so a change there
/// runs it too.
pub fn ci() -> Pipeline {
    Pipeline::new("runner.ci")
        .describe("policy test runner: build · tests · end to end with @apim-policy/testing")
        .on(Push::to("main").paths(
            [
                "runner/**",
                "packages/testing/**",
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
            j.on(Linux).image(IMAGE).cache(dotnet_cache()).cache(Npm::modules()).env("CI", "true").run(|ctx| {
                let dotnet = install_dotnet(ctx)?;
                let runner = ctx.workspace().join("runner");
                ctx.step("runner tests", |ctx| {
                    ctx.run(&dotnet, ["test", "PolicyRunner.slnx"]).in_dir(&runner).call().map(drop)
                })?;
                ensure_node(ctx)?;
                Npm::ci(ctx).call()?;
                let built = ctx.workspace().join(BUILT_RUNNER);
                // The end-to-end test starts the runner with `dotnet`, so the pinned SDK goes on PATH.
                let sdk = dotnet.trim_end_matches("/dotnet").to_string();
                let path = format!("{sdk}:{}", std::env::var("PATH").unwrap_or_default());
                ctx.step("test package against the runner", |ctx| {
                    ctx.run("npm", ["test", "-w", "@apim-policy/testing"])
                        .env("APIM_POLICY_RUNNER", built.as_str())
                        .env("DOTNET_ROOT", sdk.as_str())
                        .env("PATH", path.as_str())
                        .call()
                        .map(drop)
                })
            })
        })
}
