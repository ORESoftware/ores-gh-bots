# GitHub App registration

ORES uses four mandatory runtime identities plus a separately restricted Actions dispatcher. The Apps remain independent in production so a single credential cannot publish both provider decisions and the aggregate gate.

| Role | Visibility | Installation | Exact repository permissions | Webhook events |
|---|---|---|---|---|
| Orchestrator | Public, not Marketplace-listed | Every managed organization | Checks: read; Issues: read; Metadata: read; Pull requests: write; Commit statuses: read | `check_run`, `installation`, `installation_repositories`, `issue_comment`, `pull_request` |
| OpenAI reviewer | Public, not Marketplace-listed | Every managed organization | Checks: write; Metadata: read | None |
| Claude reviewer | Public, not Marketplace-listed | Every managed organization | Checks: write; Metadata: read | None |
| Review gate | Public, not Marketplace-listed | Every managed organization | Checks: write; Metadata: read | None |
| Actions dispatcher | Private | Only `ORESoftware/ores-gh-bots` | Actions: write; Metadata: read | None |

A private GitHub App can only be installed on the account that owns it. The four fleet Apps are therefore public so they can be installed across the separate ORES organizations. Public visibility does **not** list an App in GitHub Marketplace; do not submit these Apps for Marketplace publication.

`github-apps/policy.json` is authoritative. `npm run verify:github-apps` rejects permission, visibility, event, inventory, or required-secret drift. Any permission increase requires a reviewed policy change and a corresponding threat-model update.

## Manifest bootstrap

1. Enter the repository tool shell with `nix develop`. Keep shell tracing disabled for all registration and conversion commands.
2. Create a registration form and a separate private callback-state record for each role. The orchestrator requires the deployed HTTPS base URL:

   ```sh
   just app-form orchestrator ORESoftware https://bots.example.internal /tmp/orchestrator.html /tmp/orchestrator.state.json
   just app-form openai ORESoftware https://bots.example.internal /tmp/openai.html /tmp/openai.state.json
   just app-form claude ORESoftware https://bots.example.internal /tmp/claude.html /tmp/claude.state.json
   just app-form gate ORESoftware https://bots.example.internal /tmp/gate.html /tmp/gate.state.json
   just app-form actions ORESoftware https://bots.example.internal /tmp/actions.html /tmp/actions.state.json
   ```

   Both files are written with mode `0600`. The random state is stored only in the state record and is not printed.
3. Open each local form, inspect the permissions GitHub displays, and create the App. GitHub redirects to the configured callback with one-time `code` and `state` query values.
4. Within one hour, read the callback values into environment variables without placing either value in shell history, then exchange them against the private state record:

   ```sh
   read -rsp 'GitHub manifest code: ' GITHUB_MANIFEST_CODE; printf '\n'
   export GITHUB_MANIFEST_CODE
   read -rsp 'GitHub callback state: ' GITHUB_MANIFEST_STATE; printf '\n'
   export GITHUB_MANIFEST_STATE

   just app-convert orchestrator /tmp/orchestrator.state.json

   unset GITHUB_MANIFEST_CODE GITHUB_MANIFEST_STATE
   ```

   Repeat for `openai`, `claude`, `gate`, and `actions` with the corresponding state file. The converter rejects callback-state mismatches and expired state records before contacting GitHub. It also rejects `--code` and `--state`, supports mode-`0600` `--code-file` and `--callback-state-file` inputs for non-interactive operators, and deletes the state record only after a successful conversion.
5. The helper writes mode-`0600` dotenv fragments under ignored `env/dec/registrations/` without printing private keys, webhook secrets, callback state, or conversion codes. Copy the fragments into `env/dec/review-bots.env`, add the OpenAI and Anthropic provider credentials, then follow `env/README.md` to validate and encrypt the runtime secret.

The conversion endpoint may use `GITHUB_MANIFEST_TOKEN` from the process environment when your GitHub policy requires authentication. Never pass a token, one-time code, or callback state as a command-line argument.

## Installation inventory

Copy `config/installations.example.json` to the reviewed inventory location used by deployment automation and replace all `null` and `replace-with-*` values. Install the four public Apps on every target organization. During canarying, selected repositories are acceptable; before fleet enforcement, every governed repository must appear in the inventory or be covered by an `all` installation.

Install the private Actions dispatcher only on `ORESoftware/ores-gh-bots` with selected-repository access. The verifier rejects any broader dispatcher inventory.

Production must keep `ALLOW_SHARED_APP_IDENTITY=false`. Rulesets must pin the OpenAI, Claude, and aggregate contexts to their registered App IDs.
