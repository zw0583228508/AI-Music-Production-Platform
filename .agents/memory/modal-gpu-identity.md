---
name: Modal GPU identity and model immutability
description: Trust boundaries for promoting Modal GPU workers and preserving canonical model hashes.
---

Use Modal's runtime-injected immutable image object ID as the deployed image identity. Keep any deterministic source-tree hash separately labeled as source-build evidence, and promote the observed image ID through configuration controlled independently of the worker.

**Why:** A source hash is not an OCI/container digest, while Modal exposes the actual running image as an `im-...` identity. Readiness must not claim stronger container provenance than it has.

**How to apply:** Require the promoted image ID, exact endpoint origin, checkpoint hash, runtime pins, GPU evidence, and real smoke inference to agree in health and completed-result provenance.

Promote Modal workers with one versioned Ed25519-signed bundle. CI alone holds the private key; the API holds only the public key and derives image, checkpoint, and source-image expectations from the bundle rather than separately rotated environment pins.

**Why:** A shared signing secret lets a compromised API forge promotions, while independently updated pins can expose mixed old/new deployment state.

**How to apply:** Record the Modal app, deployment, function, and image IDs, exact endpoint origin, model/checkpoint revisions and digest, repository source revision, source-image digest, and all runtime pins. Atomically replace the complete record/signature envelope whenever any bound value changes.

Deliver CI-observed app, deployment, and function IDs through a provider-only Modal Secret, refresh containers, and require worker health to repeat those IDs exactly before publishing the matching API bundle.

**Why:** Modal reserves a runtime variable for image ID but does not expose equivalent app/deployment/function variables inside containers; an independently updated Secret keeps those identities out of image configuration.

**How to apply:** Precreate the Secret with fail-closed placeholders for first deploy, replace it from CI after observing final IDs, refresh existing containers without creating a new deployment version, then activate the signed API promotion bundle last.

When a promotion record binds Modal's deployment-history version, do not use `modal app rollover` after capturing that version. Update the identity Secret, gracefully stop every existing container for that exact app, verify the old container IDs are gone, and start smoke/health on fresh containers under the unchanged deployment.

**Why:** Modal rollover creates a new deployment-history version. Signing the pre-rollover version after rollover leaves the active version and promoted version ambiguous, while predicting IDs across a redeploy is unsafe because function IDs may change.

**How to apply:** Capture authoritative app/version/function metadata once after deploy, refresh containers through container lifecycle operations only, re-query the same metadata, and fail closed if any identity changed before smoke and signing.

If an intentional identity-origin mismatch sends a Modal web function into a startup crash loop, a corrected Secret may not recover that deployment promptly. Redeploy the same reviewed endpoint with the corrected origin already present, then observe the final deployment version and rotate its exact IDs before signing.

**Why:** During a real endpoint-label drill, fresh containers correctly rejected drifted origins, but updating the Secret alone left requests trapped behind the crash-looping deployment. A same-label redeploy restored startup without changing the attested image bytes.

**How to apply:** Preserve the negative startup logs, redeploy without changing the reviewed worker image inputs, treat the redeploy as a new deployment identity, stop its stale containers after installing exact observed metadata, and promote only the final ready version.

Treat mounted model snapshots as immutable. If an upstream loader syncs code, caches, or bytecode into its model directory, build a temporary runtime view outside the attested checkpoint and link only validated model bytes into it.

**Why:** ACE-Step initialization overwrites model-adjacent Python files, which changes an otherwise canonical checkpoint digest after successful inference.

**How to apply:** Reject checkpoint symlink escapes, hash the canonical aggregate snapshot, direct loader writes to temporary storage, and verify the checkpoint hash remains stable after smoke and queued jobs.

Give each provider a distinct Dockerfile path, and keep executable runtime files separate from source-evidence files needed when Modal re-imports the deployment module inside a container.

**Why:** Modal can merge Dockerfile-image caches when providers share one Dockerfile with only different build arguments. Remote class hydration also re-imports deployment configuration and may recompute every provider digest; omitting those evidence files crash-loops otherwise healthy images.

**How to apply:** Put only the selected provider runner on the application import path. Copy the complete digest evidence set to a separate non-importable directory, point digest calculation there in containers, and test a constrained-filesystem import before deployment.

Never reuse a historical smoke attestation’s source-image digest as the identity of a newly deployed worker revision. Historical proof remains evidence for that historical release only.

**Why:** A fresh deploy can otherwise repeat an old trusted digest even though its executable source changed, making the new signed promotion claim an identity it did not build.

**How to apply:** Recompute the deterministic source-image digest from the exact checked-out release inputs for every deployment, while retaining historical smoke records unchanged and separately labeled.
