"""Harbor adapter that runs the Coding Agent artifact on TerminalBench (ADR 0005 §6).

Harbor imports the agent from `coding_agent_terminalbench.agent:CodingAgent`. This module imports
nothing, so a reader of `coding_agent_terminalbench.manifest` does not load Harbor.
"""
