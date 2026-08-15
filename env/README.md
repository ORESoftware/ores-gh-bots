# Secret workflow

Place plaintext only in ignored `env/dec/review-bots.env`. Encrypt it with `just encrypt-env` and commit only the resulting SOPS document under `env/enc/`. Replace the example Age recipient in `.sops.yaml` before use.
