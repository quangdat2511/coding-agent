"""PROTOTYPE, THROWAWAY (CDA-121). Runs proto (4 variants) as root in the music-harmony task
sandbox on Modal. Run from the repo root:
    uv run --project evaluation/terminalbench --frozen python <this file> <proto-x64> <probe.sh>
"""

import asyncio
import secrets
import sys
import tempfile
from pathlib import Path

DATASET = "terminal-bench/terminal-bench@4.1.0"
TASK = "music-harmony"
FAKE_KEY = "sk-ant-cda121-prototype-" + secrets.token_hex(8)  # not a real key


async def main(binary: str, probe: str) -> None:
    from harbor.environments.factory import EnvironmentFactory
    from harbor.models.environment_type import EnvironmentType
    from harbor.models.task.id import PackageTaskId
    from harbor.models.task.task import Task
    from harbor.models.trial.paths import TrialPaths
    from harbor.registry.client.package import PackageDatasetClient
    from harbor.tasks.client import TaskClient

    metadata = await PackageDatasetClient().get_dataset_metadata(DATASET)
    ids = [t for t in metadata.task_ids if isinstance(t, PackageTaskId)]
    chosen = next(t for t in ids if TASK in (t.name, t.get_name()))
    task = Task((await TaskClient().download_tasks([chosen])).paths[0])
    with tempfile.TemporaryDirectory(prefix="proto121-") as trial_dir:
        paths = TrialPaths(trial_dir=Path(trial_dir))
        paths.mkdir()
        env = EnvironmentFactory.create_environment(
            type=EnvironmentType.MODAL,
            environment_dir=task.paths.environment_dir,
            environment_name=task.name,
            session_id=f"proto121-{secrets.token_hex(4)}__env",
            trial_paths=paths,
            task_env_config=task.config.environment,
        )
        print("[host] starting the Modal sandbox", flush=True)
        await env.start(force_build=False)
        try:
            await env.exec("mkdir -p /proto", user="root")
            await env.upload_file(binary, "/proto/proto")
            await env.upload_file(probe, "/proto/probe.sh")
            key_file = Path(trial_dir) / "key"
            key_file.write_text(FAKE_KEY)
            await env.upload_file(str(key_file), "/proto/key")
            await env.exec("chmod 0755 /proto/proto", user="root")
            for variant in ("none", "effective", "bounding", "all"):
                # bash exports the key, then exec replaces bash, so only proto holds it.
                command = f"bash -c 'export ANTHROPIC_API_KEY=$(cat /proto/key); exec /proto/proto {variant}'"
                result = await env.exec(command)
                print(f"===== variant {variant} rc={result.return_code}", flush=True)
                print((result.stdout or "").replace(FAKE_KEY, "<KEY>"), flush=True)
                if result.stderr:
                    print("[stderr]", result.stderr.replace(FAKE_KEY, "<KEY>"), flush=True)
        finally:
            await env.stop(delete=True)
            print("[host] sandbox stopped and deleted", flush=True)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
