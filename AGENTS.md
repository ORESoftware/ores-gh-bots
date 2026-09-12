# Agent notes for ores-gh-bots

- Zero runtime dependencies: `npm test` (`node --test`) and `npm run lint` work offline; run both before committing.
- Build values, don't mutate them: functions return new values instead of pushing into caller-owned
  arrays or reassigning a `let` across a closure; validators are lists of pure rules concatenated in
  order. Deliberate exceptions on hot paths carry a `HOT-PATH (imperative by design)` comment with the
  reason. See [`FUNCTIONAL-STYLE.md`](./FUNCTIONAL-STYLE.md).
