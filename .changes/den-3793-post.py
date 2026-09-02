from pathlib import Path


def replace_once(path: Path, before: str, after: str, label: str) -> None:
    source = path.read_text(encoding="utf-8")
    count = source.count(before)
    if count != 1:
        raise SystemExit(f"expected exactly one {label}, found {count}")
    path.write_text(source.replace(before, after, 1), encoding="utf-8")


test_path = Path("test/cli-contract.test.mjs")
replace_once(
    test_path,
    """  const reaper = resolveCli([\n    'node',\n    'reaper',\n    'reaper',\n    'apply',\n""",
    """  const reaper = resolveCli([\n    'node',\n    'reaper',\n    'apply',\n""",
    "reaper CLI fixture",
)

flags_path = Path(".cli-flags.toml")
flags_source = flags_path.read_text(encoding="utf-8")
marker = "[commands.reaper]\n"
if flags_source.count(marker) != 1:
    raise SystemExit("expected exactly one reaper command block")
prefix = flags_source.split(marker, 1)[0]
reaper_block = '''[commands.reaper]
help = "Plan or apply the fail-closed dependency-aware pull-request merge reaper."

[commands.reaper.flags.policy]
env = "MERGE_REAPER_POLICY"
aliases = ["policy"]
type = "string"
default = "config/merge-reaper.example.json"
help = "Reviewed dependency and merge policy JSON path."

[commands.reaper.flags.minimum_age_hours]
env = "MERGE_REAPER_MIN_AGE_HOURS"
aliases = ["minimum-age-hours"]
type = "integer"
default = 55
help = "Minimum pull-request age before consideration."

[commands.reaper.flags.max_merges]
env = "MERGE_REAPER_MAX_MERGES"
aliases = ["max-merges"]
type = "integer"
default = 3
help = "Maximum merge effects in one run; hard-capped at three."

[commands.reaper.flags.max_repositories]
env = "MERGE_REAPER_MAX_REPOSITORIES"
aliases = ["max-repositories"]
type = "integer"
default = 2000
help = "Maximum installed repositories to inspect."

[commands.reaper.flags.max_prs_per_repository]
env = "MERGE_REAPER_MAX_PRS_PER_REPOSITORY"
aliases = ["max-prs-per-repository"]
type = "integer"
default = 100
help = "Maximum open pull requests inspected per repository."

[commands.reaper.flags.output]
env = "MERGE_REAPER_OUTPUT"
aliases = ["output"]
type = "string"
default = "merge-reaper-report.json"
help = "Machine-readable report path."

[commands.reaper.flags.confirm]
env = "MERGE_REAPER_CONFIRM"
aliases = ["confirm"]
type = "string"
help = "Required MERGE-ticket acknowledgement for apply mode."

[commands.reaper.commands.plan]
help = "Inspect the installed fleet and render an exact-head merge plan without writes."

[commands.reaper.commands.apply]
help = "Merge at most three exact-head eligible pull requests in dependency order."
'''
flags_path.write_text(prefix + reaper_block, encoding="utf-8")
