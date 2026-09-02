# Secret operations and rotation

This runbook covers GitHub App private keys, the orchestrator webhook secret, OpenAI and Anthropic credentials, and the SOPS/Age envelope. Secret names and deployment references are defined in `config/secrets.example.json`; values never belong in issues, pull requests, logs, shell history, or committed plaintext.

## Initial bootstrap

1. Generate an Age identity in an operator-controlled secret store:

   ```sh
   age-keygen -o "$HOME/.config/sops/age/keys.txt"
   ```

2. Record the printed public `age1...` recipient with `just set-age-recipient age1...`. The recipient is not secret and should be reviewed and committed.
3. Register the GitHub Apps with `docs/APP_REGISTRATION.md`.
4. Run `just init-env`, populate the App and provider credentials, and run `just validate-env`.
5. Run `SOPS_AGE_RECIPIENTS=age1... just encrypt-env`.
6. Apply the decrypted dotenv values to Kubernetes Secret `ores-gh-bots-secrets` in namespace `ores-gh-bots` through the normal reviewed deployment path. Do not check generated Kubernetes Secret YAML into source control.

## GitHub App private-key rotation

GitHub App identity is the App ID, not an individual private key. Rotate without changing App IDs or dropping queued jobs:

1. Generate a second private key on the existing App registration. Do not revoke the active key yet.
2. Decrypt the runtime secret, replace only that role's PEM, validate, re-encrypt, and deploy.
3. Verify the new deployment can mint an App JWT, resolve every expected installation, mint installation tokens, and publish a canary check.
4. Confirm the persistent queue path is unchanged and pending jobs continue on the same storage.
5. Revoke the old key in GitHub.
6. Record the App role, unchanged App ID, deployment revision, operator, reason, verification evidence, and old-key revocation time in the deployment audit log. Never record key material.

This overlap is mandatory for orchestrator, OpenAI reviewer, Claude reviewer, review gate, merge reaper, and Actions dispatcher rotations.

## Webhook-secret rotation

Webhook delivery supports one configured secret in the current runtime. Preserve queue storage, pause enforcement changes, update the GitHub App webhook secret and the encrypted deployment secret in a tightly controlled change, roll the webhook process, then replay/reconcile missed events. Existing queued jobs are unaffected because the queue contains event metadata, not webhook credentials.

## Provider-key rotation

Create the replacement provider key, update and deploy the encrypted secret, exercise one canary PR at the exact head SHA, then revoke the old provider key. Provider failure remains fail-closed; never weaken the aggregate gate to complete a rotation.

## Age-recipient and SOPS data-key rotation

Add the new public recipient to `.sops.yaml` before removing the old one. An operator who can decrypt with an existing identity runs `just rotate-age`, verifies a clean decrypt, commits the rewrapped SOPS document, and only then retires the old Age identity. Keep an offline recovery identity or independently controlled recipient.

## Revocation and incident response

1. Disable ruleset expansion; keep existing rulesets active unless documented business continuity requires evaluate mode.
2. Revoke the suspected provider key or GitHub App private key immediately. Suspending an affected App installation is preferable to deleting the App identity.
3. Replace and deploy the secret through SOPS. Do not paste emergency credentials into GitHub, Linear, Slack, or email.
4. Reconcile open pull requests so every current head SHA receives fresh checks from the restored identities.
5. Review webhook rejection, provider error, dead-letter, installation-token, and audit logs for the exposure window.
6. Rotate the Age envelope if an operator identity or decrypted file may have been exposed.
7. Document scope, timestamps, affected App IDs/installations, evidence, and corrective actions without including secrets.
