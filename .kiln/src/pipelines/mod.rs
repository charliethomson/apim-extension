//! One module per pipeline, plus what they share.

pub mod audit;
pub mod engine;
pub mod extension;
pub mod repo;

use kiln::prelude::*;

/// Every job's image: the fleet's Rust pin (`libci::templates::TOOLCHAIN_IMAGE`). Every kiln step
/// builds `.kiln/` with cargo before the job body runs, so the image must carry cargo; node,
/// .NET and the VS Code test libraries are installed in the body.
pub const IMAGE: &str = "rust:1-bookworm";

/// The `.kiln/` files every pipeline is defined by, for path filters.
pub const KILN: [&str; 3] = [".kiln/src/**", ".kiln/Cargo.toml", ".kiln/Cargo.lock"];

/// node 22 and npm, from NodeSource: Debian bookworm's own `nodejs` is 18.
const NODE_KEY: &str = "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key";
const NODE_SOURCE: &str = "https://deb.nodesource.com/node_22.x nodistro main";

/// `apt-get install`, non-interactively. Step containers run as root.
pub fn apt(ctx: &Ctx, packages: &[&str]) -> Result<()> {
    ctx.step("apt", |ctx| {
        ctx.run("apt-get", ["update", "-qq"]).env("DEBIAN_FRONTEND", "noninteractive").call()?;
        ctx.run("apt-get", ["install", "-y", "-qq", "--no-install-recommends"])
            .args(packages.iter().copied())
            .env("DEBIAN_FRONTEND", "noninteractive")
            .call()?;
        Ok(())
    })
}

/// Install node 22 unless it's already on `PATH`.
pub fn ensure_node(ctx: &Ctx) -> Result<()> {
    if !ctx.run("sh", ["-c", "command -v node"]).allow_failure().call()?.failed() {
        return Ok(());
    }
    ctx.step("install node", |ctx| {
        let keyring = "/etc/apt/keyrings/nodesource.asc";
        ctx.run("mkdir", ["-p", "/etc/apt/keyrings"]).call()?;
        ctx.run("curl", ["-fsSL", "-o", keyring, NODE_KEY]).call()?;
        let list =
            format!("echo \"deb [signed-by={keyring}] {NODE_SOURCE}\" > /etc/apt/sources.list.d/nodesource.list");
        ctx.run("sh", ["-c", list.as_str()]).call()?;
        apt(ctx, &["nodejs"])
    })
}
