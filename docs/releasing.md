# Release Menoteam Work Map

The repository publishes one versioned OCI container image to GitHub Container
Registry (GHCR). It does not publish an npm package: `package.json` remains
private intentionally. The release workflow does not create a GitHub Release or
change repository or package visibility.

## Release rules

- A stable release tag is `vX.Y.Z`, for example `v0.1.0`.
- The tag must match the `version` in `package.json` exactly. The workflow
  stops before publishing when they differ.
- A successful tag run publishes these image tags:
  `vX.Y.Z` (tag form), `X.Y.Z` (semver form), `X.Y`, and `latest`.
- The workflow publishes one multi-architecture manifest for `linux/amd64`
  and `linux/arm64`, with BuildKit provenance and an SBOM attached by GHCR.

Use the exact version tag for deployments and rollback. `latest` and the
`X.Y` convenience tag are mutable aliases, not immutable release references.

## Maintainer release checklist

Before creating a tag:

1. Update `package.json` to the next version and review the complete diff.
2. Run the same source checks used by the release gate:

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm test
   pnpm build
   docker compose --env-file .env.example config --quiet
   git diff --check
   ```

3. Confirm `.env`, credentials, private Work Map content, backups, and local
   build output are not staged. `.env` is ignored; `.env.example` contains
   placeholders only.
4. Confirm the default branch CI run is green, then create and push the
   matching tag:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

The tag workflow repeats the typecheck, test, build, and Compose checks before
the publish job receives `packages: write`. If any check fails, no image is
published by that run. Inspect the workflow summary and the GHCR package after
the run; a pushed Git tag alone is not proof that an image was published.

## GHCR package setup

The workflow authenticates with the repository-provided `GITHUB_TOKEN`; no
long-lived registry credential belongs in GitHub Actions variables or source.
The first successful run creates the package under:

```text
ghcr.io/<lowercase-github-owner>/menoteam-work-map
```

GHCR package visibility is separate from repository visibility. A maintainer
must review the package settings and explicitly make the package public before
anonymous users can pull it. Keep it private while the image, security model,
and release process are still under review. For a private package, operators
must authenticate with a GitHub credential that has `read:packages`; never put
that credential in this repository or in an image tag/URL.

## Deploy a published image

Complete the secret, TLS, allowlist, and backup prerequisites in the
[self-hosting guide](self-hosting.md) first. Then pin Compose to an exact image
tag and pull it:

```bash
export APP_IMAGE=ghcr.io/<lowercase-github-owner>/menoteam-work-map:vX.Y.Z
docker compose --env-file .env pull app
docker compose --env-file .env up -d
curl --fail --retry 20 --retry-delay 2 http://127.0.0.1:3000/healthz
```

For a private package, run `docker login ghcr.io` using the operator's normal
secret-injection method before `docker compose pull`. Do not use `--build` in
this image-deployment path, because that would rebuild from the checkout rather
than run the published artifact.

To roll back, set `APP_IMAGE` to the previously verified exact version tag,
pull the app image, and recreate the app. Keep the database backup and verify
health, authenticated MCP read, dashboard read-only access, and migration
compatibility after the rollback; health alone is not a complete rollback
proof.

Other architectures can build locally from the checkout as described in
[`docs/self-hosting.md`](self-hosting.md). Do not assume that a successful
registry pull proves support outside the two published platforms.

## What this workflow does not provide

- No npm publication, hosted control plane, agent runner, or Discord gateway.
- No image signing or vulnerability gate yet. BuildKit provenance and SBOMs
  improve inspection, but they are not substitutes for either control.
- No automatic GHCR package-visibility change. Review and perform that one-time
  setting explicitly in GitHub if public anonymous pulls are intended.
