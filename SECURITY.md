# Security policy

Report suspected vulnerabilities privately to the repository maintainers. Do not include live credentials in an issue, pull request, check output, provider prompt, test fixture, or log.

## Credential rules

- Store GitHub App keys, webhook secrets, and provider keys in SOPS-encrypted deployment material or an external secret manager.
- Do not use a broad personal access token as the long-lived runtime credential.
- Use separate GitHub Apps for provider checks when rulesets must enforce distinct check identities.
- Rotate any bootstrap token that has been pasted into chat, logs, tickets, or a shell history.

## Untrusted input

No code from a pull request is executed by the central reviewer. Diffs, filenames, commit messages, PR descriptions, and issue comments are data and cannot override system policy.
