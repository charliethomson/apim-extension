//! Every pipeline this repo runs, registered on one screen.
//!
//! `main()` gives the binary kiln's subcommands: `describe` (the graph, which is
//! `.kiln/lock.json`), `run <pipeline> <job>`, `check`, `preflight` and `emit woodpecker`.
//!
//! # Push-only
//!
//! `.kiln/` depends on the private kiln and libci, so every generated job fetches them with the
//! checkout key, and kiln refuses a pull-request trigger on a repo with one: Woodpecker runs a
//! pull request's own copy of the generated YAML, and nothing generated could keep the key from
//! it. So nothing here runs on a pull request; the gates run when a change lands on `main`, and
//! by hand.
//!
//! `emit` overwrites but never deletes: dropping a pipeline from this list means deleting its
//! `.yml` by hand, and `repo.checks` fails on the orphan until then.

mod pipelines;

use libci::secrets::{SshDeployKey, git};

// `vsce_pat`: an Azure DevOps token with Marketplace (Manage) scope for the `thmsn-dev`
// publisher, provisioned by hand in Woodpecker.
kiln::secrets! {
    VscePat = "vsce_pat",
}

fn main() -> kiln::Result<()> {
    kiln::repo("apim-extension")
        // The read-only key every generated job fetches `.kiln/`'s private dependencies with.
        .checkout_key(SshDeployKey)
        .secrets(git::KILN_SECRETS)
        .secrets(KILN_SECRETS)
        // ── Gates ──────────────────────────────────────────────────────────────
        .pipeline(pipelines::extension::ci())
        .pipeline(pipelines::engine::ci())
        .pipeline(pipelines::policy_tests::ci())
        .pipeline(pipelines::audit::ci())
        .pipeline(pipelines::repo::checks())
        // ── Delivery ───────────────────────────────────────────────────────────
        .pipeline(pipelines::extension::prerelease())
        .pipeline(pipelines::extension::release())
        .main()
}
