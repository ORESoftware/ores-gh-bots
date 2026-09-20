# Agent notes for ores-gh-bots

- Keep the runtime dependency graph minimal, lockfile-pinned, and explicit. `@oresoftware/f2e` is a required runtime dependency for the canonical `.cli-flags.toml` boundary. Install dependencies with lifecycle scripts disabled (`npm ci --ignore-scripts`; OCI additionally uses `--omit=dev`) and explicitly compile only the reviewed flags2env native boundary with `npm run build:flags2env`. Never enable arbitrary dependency lifecycle scripts to make a build pass.
- `npm test` (`node --test`) and `npm run lint` use the repository's checked-in test/lint code; run both before committing.
- Build values, don't mutate them: functions return new values instead of pushing into caller-owned
  arrays or reassigning a `let` across a closure; validators are lists of pure rules concatenated in
  order. Deliberate exceptions on hot paths carry a `HOT-PATH (imperative by design)` comment with the
  reason. See [`FUNCTIONAL-STYLE.md`](./FUNCTIONAL-STYLE.md).
