"""The project's pins match ADR 0005 §1 and §6."""

import tomllib
import unittest
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent


def read_toml(name: str) -> dict:
    with (PROJECT_DIR / name).open("rb") as file:
        return tomllib.load(file)


class ProjectPinsTest(unittest.TestCase):
    def test_harbor_is_the_only_direct_dependency(self) -> None:
        project = read_toml("pyproject.toml")["project"]
        self.assertEqual(project["dependencies"], ["harbor[modal]==0.23.0"])
        self.assertNotIn("optional-dependencies", project)
        self.assertNotIn("dependency-groups", read_toml("pyproject.toml"))

    def test_python_is_3_12_or_newer(self) -> None:
        self.assertEqual(read_toml("pyproject.toml")["project"]["requires-python"], ">=3.12")
        self.assertEqual((PROJECT_DIR / ".python-version").read_text().strip(), "3.12")

    def test_the_lock_file_resolves_harbor_0_23_0_with_modal(self) -> None:
        lock = read_toml("uv.lock")
        self.assertEqual(lock["requires-python"], ">=3.12")
        packages = {package["name"]: package for package in lock["package"]}
        self.assertEqual(packages["harbor"]["version"], "0.23.0")
        self.assertIn("modal", packages["harbor"].get("optional-dependencies", {}))
        self.assertIn("modal", packages)
        project = packages["coding-agent-terminalbench"]
        self.assertEqual(
            project["metadata"]["requires-dist"],
            [{"name": "harbor", "extras": ["modal"], "specifier": "==0.23.0"}],
        )


if __name__ == "__main__":
    unittest.main()
