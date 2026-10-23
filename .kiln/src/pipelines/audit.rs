//! `audit.ci`: npm advisories, blocking on critical only, through libci's `AuditGate`.
//!
//! The gate logs every finding and fails only on a critical one without a live exception, on an
//! expired or malformed exception, or on a report that isn't one (a tool that failed must not
//! read as clean). Exceptions are in `audit-exceptions.json`:
//! `{ "id": "GHSA-…", "reason": "…", "expires": "YYYY-MM-DD" }`, all three required.
//!
//! **The weekly schedule is recorded here, not honoured**: the emitted `event: cron` names the
//! pipeline, so a Woodpecker UI cron named `audit.ci` has to exist for it to fire.

use kiln::prelude::*;
use kiln::recipes::node::Npm;
use libci::audit::AuditGate;

use super::{IMAGE, KILN, ensure_node};

const EXCEPTIONS: &str = "audit-exceptions.json";

pub fn ci() -> Pipeline {
    Pipeline::new("audit.ci")
        .describe("npm advisories; blocks on critical and on expired exceptions")
        .on(Push::to("main")
            .paths(["package-lock.json", EXCEPTIONS, ".kiln/src/pipelines/audit.rs"].into_iter().chain(KILN)))
        .on(Schedule::cron("0 6 * * 1"))
        .on(Manual)
        .job("audit", |j| {
            j.on(Linux).image(IMAGE).run(|ctx| {
                ensure_node(ctx)?;
                // Every `npm audit` exits non-zero on any advisory, so the report is the input
                // and AuditGate is the only verdict.
                let report = Npm::audit(ctx).report_to(ctx.tmp().join("npm-audit.json"))?;
                let json = ctx.read_to_string(report)?;
                AuditGate::new().exceptions(EXCEPTIONS).npm("extension", json).run(ctx).map(drop)
            })
        })
}
