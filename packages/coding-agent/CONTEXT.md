# Coding Agent

The Coding Agent context describes the user-facing application formed by composing the other
project contexts.

## Language

**Coding Agent**:
The application that accepts a Coding Task and coordinates model interaction, controlled tools,
the Agent Session, and the Full-screen TUI.
_Avoid_: Chatbot, assistant, model

**TerminalBench Evaluation**:
A reproducible run that records this Coding Agent's results on TerminalBench without using Pi's
score as a pass or fail threshold.
_Avoid_: Pi comparison, benchmark competition

**Evaluation Profile**:
A named, source-controlled set of Agent Session limits selected for a run; it changes no prompt,
tool, or model setting.
_Avoid_: Benchmark mode, eval config, limit flags

**Isolation Record**:
The dated list, kept with the repository, of the passing runs of the credential isolation test
for one artifact. Each run names a backend and an agent user. It is distinct from the artifact
manifest, which the build writes before any test runs, and from the job manifest, which the record
tooling writes after a job.
_Avoid_: Isolation manifest, isolation report
