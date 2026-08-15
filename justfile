set shell := ["bash", "-euo", "pipefail", "-c"]

default:
  @just --list

check:
  npm run check
  npm run verify

start:
  npm start

encrypt-env:
  test -f env/dec/review-bots.env
  sops --encrypt --input-type dotenv --output-type dotenv env/dec/review-bots.env > env/enc/review-bots.env

decrypt-env:
  sops --decrypt --input-type dotenv --output-type dotenv env/enc/review-bots.env > env/dec/review-bots.env

canary-plan:
  node apps/cli/src/main.mjs rulesets plan --enforcement evaluate --branch-mode all
