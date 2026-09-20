# Kubernetes deployment

The base intentionally runs one replica with `Recreate` because the durable queue uses a local SQLite/WAL database on a `ReadWriteOnce` volume. Do not scale beyond one replica until the queue is moved to a shared transactional store.

Create a SOPS-encrypted `ores-gh-bots-secrets` Secret containing the App IDs/private keys, webhook secret, provider keys, and explicit owner allowlist.

## Image provenance is a deployment precondition

The checked-in base, canary, and production manifests deliberately use the all-zero SHA-256 digest as an **inactive fail-closed sentinel**. It is immutable syntax but does not identify a published release. This prevents `latest`, a mutable release tag, or an accidental bare-base apply from selecting executable code that was not the image reviewed for activation.

After publishing and verifying an OCI image, replace the selected overlay's `digest:` with the registry-reported full `sha256:<64-hex>` digest. Do not derive a digest from a tag string, Git SHA, Dockerfile, or local image ID; use the digest of the exact published manifest/image that the cluster will pull.

Repository verification accepts the inactive sentinel because the service is not activated yet:

```bash
npm run verify:k8s-images
```

Immediately before any canary or production apply, require activation mode as a separate gate:

```bash
node scripts/verify-k8s-image-pins.mjs --activation
kubectl apply -k deploy/kubernetes/overlays/canary
```

`--activation` fails while either deployment overlay still contains the all-zero sentinel. Canary is for `*-test` installations; production remains disabled until current-SHA invalidation, fail-closed review behavior, GitHub App registration/installation, secret provisioning, and the exact published image digest have all been proven.
