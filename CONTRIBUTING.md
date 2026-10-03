# Contributing

Use Node.js 22 or later. Keep runtime code dependency-light and preserve the rule that pull-request code is never executed by the central orchestrator.

Before opening a pull request:

```bash
npm run check
npm run verify
```

Add tests for event routing, gate semantics, redaction, and any change to provider parsing or GitHub check behavior.
