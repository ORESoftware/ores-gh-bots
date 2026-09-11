set shell := ["bash", "-euo", "pipefail", "-c"]

plaintext_env := "env/dec/review-bots.env"
encrypted_env := "env/enc/review-bots.env"

default:
  @just --list

check:
  npm run check
  npm run verify

verify-apps:
  npm run verify:github-apps

start:
  npm start

init-env:
  test ! -e {{plaintext_env}}
  install -m 600 .env.example {{plaintext_env}}
  @echo "Created {{plaintext_env}} with mode 0600. Replace every required placeholder before encryption."

validate-env:
  node scripts/validate-secret-env.mjs {{plaintext_env}}

set-age-recipient recipient:
  node scripts/set-sops-age-recipient.mjs "{{recipient}}"

encrypt-env:
  test -n "${SOPS_AGE_RECIPIENTS:-}" || { echo "Set SOPS_AGE_RECIPIENTS to one or more comma-separated age1... recipients." >&2; exit 2; }
  test -f {{plaintext_env}}
  node scripts/validate-secret-env.mjs {{plaintext_env}}
  mkdir -p env/enc
  install -m 600 /dev/null {{encrypted_env}}.tmp
  sops --encrypt --age "$SOPS_AGE_RECIPIENTS" --input-type dotenv --output-type dotenv --filename-override {{encrypted_env}} {{plaintext_env}} > {{encrypted_env}}.tmp
  sops --decrypt --input-type dotenv --output-type dotenv {{encrypted_env}}.tmp >/dev/null
  mv {{encrypted_env}}.tmp {{encrypted_env}}

decrypt-env:
  test -f {{encrypted_env}}
  mkdir -p env/dec
  install -m 600 /dev/null {{plaintext_env}}.tmp
  sops --decrypt --input-type dotenv --output-type dotenv {{encrypted_env}} > {{plaintext_env}}.tmp
  node scripts/validate-secret-env.mjs {{plaintext_env}}.tmp
  mv {{plaintext_env}}.tmp {{plaintext_env}}

edit-env:
  test -f {{encrypted_env}}
  sops {{encrypted_env}}

rotate-age:
  test -f {{encrypted_env}}
  ! grep -q "age1replace" .sops.yaml || { echo "Configure .sops.yaml with `just set-age-recipient age1...` first." >&2; exit 2; }
  sops updatekeys -y {{encrypted_env}}
  sops rotate -i {{encrypted_env}}
  sops --decrypt --input-type dotenv --output-type dotenv {{encrypted_env}} >/dev/null

app-form role owner base_url owner_type="user" output="/tmp/ores-gh-app.html" state_file="/tmp/ores-gh-app.state.json":
  node scripts/app-manifest.mjs form --role "{{role}}" --owner "{{owner}}" --owner-type "{{owner_type}}" --base-url "{{base_url}}" --output "{{output}}" --state-file "{{state_file}}"

app-convert role state_file:
  test -n "${GITHUB_MANIFEST_CODE:-}" || { echo "Set GITHUB_MANIFEST_CODE without placing it in command history." >&2; exit 2; }
  test -n "${GITHUB_MANIFEST_STATE:-}" || { echo "Set GITHUB_MANIFEST_STATE without placing it in command history." >&2; exit 2; }
  node scripts/app-manifest.mjs convert --role "{{role}}" --state-file "{{state_file}}"

canary-plan:
  node apps/cli/src/main.mjs rulesets plan --enforcement evaluate --branch-mode all
