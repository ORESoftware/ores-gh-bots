# Kubernetes deployment

The base intentionally runs one replica with `Recreate` because the durable queue uses a local SQLite/WAL database on a `ReadWriteOnce` volume. Do not scale beyond one replica until the queue is moved to a shared transactional store.

Create a SOPS-encrypted `ores-gh-bots-secrets` Secret containing the App IDs/private keys, webhook secret, provider keys, and explicit owner allowlist. Then render one overlay:

```bash
kubectl apply -k deploy/kubernetes/overlays/canary
```

Replace `latest` with an immutable image digest before production activation. The canary overlay is for `*-test` installations; production must remain disabled until current-SHA invalidation and fail-closed behavior have been proven.
