// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use anyhow::Result;
use atlas_engine_execpolicy::ExecPolicyCheckCommand;
use clap::Parser;

/// CLI for evaluating exec policies
#[derive(Parser)]
#[command(name = "atlas-engine-execpolicy")]
enum Cli {
    /// Evaluate a command against a policy.
    Check(ExecPolicyCheckCommand),
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli {
        Cli::Check(cmd) => cmd.run(),
    }
}
