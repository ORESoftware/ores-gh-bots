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

1. Enter the repository tool shell with `nix develop`.
2. Create a registration form for each role. The orchestrator requires the deployed HTTPS base URL:

   ```sh
   just app-form orchestrator ORESoftware https://bots.example.internal /tmp/orchestrator.html
   just app-form openai ORESoftware https://bots.example.internal /tmp/openai.html
   just app-form claude ORESoftware https://bots.example.internal /tmp/claude.html
   just app-form gate ORESoftware https://bots.example.internal /tmp/gate.html
   just app-form actions ORESoftware https://bots.example.internal /tmp/actions.html
   ```

3. Open each local form, inspect the permissions GitHub displays, and create the App. Preserve the generated `state` and verify it on the callback.
4. Within one hour, exchange each callback `code`:

   ```sh
   just app-convert orchestrator CALLBACK_CODE
   ```

   Repeat for `openai`, `claude`, `gate`, and `actions`. The helper writes mode-`0600` dotenv fragments under ignored `env/dec/registrations/` and never prints private keys or webhook secrets.
5. Copy the fragments into `env/dec/review-bots.env`, add the OpenAI and Anthropic provider credentials, then follow `env/README.md` to validate and encrypt the runtime secret.

The conversion endpoint may use `GITHUB_MANIFEST_TOKEN` from the process environment when your GitHub policy requires authentication. Never pass a token as a command-line argument.

## Installation inventory

Copy `config/installations.example.json` to the reviewed inventory location used by deployment automation and replace all `null` and `replace-with-*` values. Install the four public Apps on every target organization. During canarying, selected repositories are acceptable; before fleet enforcement, every governed repository must appear in the inventory or be covered by an `all` installation.

Install the private Actions dispatcher only on `ORESoftware/ores-gh-bots` with selected-repository access. The verifier rejects any broader dispatcher inventory.

Production must keep `ALLOW_SHARED_APP_IDENTITY=false`. Rulesets must pin the OpenAI, Claude, and aggregate contexts to their registered App IDs.
