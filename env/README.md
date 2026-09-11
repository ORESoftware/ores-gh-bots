# Encrypted secret workflow

The committed source is `env/enc/review-bots.env`. Plaintext is written only to the ignored, mode-`0600` path `env/dec/review-bots.env`.

## Bootstrap

1. Enter the pinned tool shell with `nix develop`.
2. Generate or select an Age identity outside the repository. Commit only its public `age1...` recipient.
3. Run `just set-age-recipient age1...`.
4. Run `just init-env`, populate every required value, and run `just validate-env`.
5. Export the same public recipient as `SOPS_AGE_RECIPIENTS` and run `just encrypt-env`.
6. Commit `.sops.yaml` and the SOPS document under `env/enc/`. Never commit anything under `env/dec/`.

The five manifest-conversion fragments are written under ignored `env/dec/registrations/` by `just app-convert ROLE STATE_FILE` after the callback code and state are supplied through environment variables or private mode-`0600` files. Copy their generated values into `env/dec/review-bots.env`, add provider credentials, validate, encrypt, then securely delete obsolete fragments.

## Routine use

- `just decrypt-env` creates a validated mode-`0600` plaintext file.
- `just edit-env` edits the encrypted SOPS document in place.
- `just rotate-age` applies the recipients committed in `.sops.yaml`, generates a new SOPS data key, and verifies decryption.
- `just validate-env` rejects placeholders, duplicate App IDs, malformed PEM values, and short webhook secrets.

The deployment reference is machine-readable in `config/secrets.example.json`; the Kubernetes base consumes Secret `ores-gh-bots-secrets` in namespace `ores-gh-bots`.
