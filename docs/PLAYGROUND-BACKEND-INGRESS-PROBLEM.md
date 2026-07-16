# AdaptaLabs playground: backend ingress never provisioned despite green deploy pipeline

> **Status update 2026-07-06:** LARGELY RESOLVED without intervention.
> The ingress and DNS came good roughly 10-14 hours after the ArgoCD config push —
> `adaptalabs-backend.kubera-playground.adaptavist.net/health` returns 200 and the
> HMAC-verified webhook receiver responds correctly (401 on unsigned POSTs).
> The reconciliation latency (hours, not minutes) may still interest the DevEx team
> as a data point, but nothing is blocked on it.
> **The one remaining platform ask is the secret — see "What we need" item 2 below.**

**Date:** 2026-07-05
**Project:** `cto/AdaptaLabs` (gitlab.adaptavist.net)
**Environment:** Kubera playground, namespace `adaptalabs`
**Raised by:** Nick Fine (Office of the CTO)
**Audience:** DevEx / platform team (#dep-internal-engineering)

---

## Summary

A merge to `main` this morning added a public ingress to the `adaptalabs-backend` app.
The CI pipeline and the downstream Kubera deploy pipeline both completed successfully and the rendered ArgoCD Application spec is correct.
However, more than 90 minutes later the ingress hostname `adaptalabs-backend.kubera-playground.adaptavist.net` does not resolve (NXDOMAIN on public and local resolvers), so the ingress was never provisioned cluster-side.
The `adaptalabs` frontend hostname (`adaptalabs.kubera-playground.adaptavist.net`) resolves and serves normally, so this is specific to the backend app's new ingress, not the namespace or environment.

We suspect the ArgoCD sync for `adaptalabs-backend` is stuck or degraded and need someone with cluster access to inspect it.

---

## Why the change was made

The Cortex ↔ FirstHand integration (unmoderated research sessions) requires FirstHand — a Next.js app on Vercel, on the public internet — to deliver HMAC-signed webhook callbacks to `POST /api/firsthand/callbacks` on the AdaptaLabs backend.
The only existing route to the backend is via the frontend's ingress, which has `okta_alb` auth enabled.
We verified live that the Okta ALB intercepts unauthenticated server-to-server POSTs and 302s them to Okta, so callbacks cannot get through that path.
The fix was to give the backend its own public ingress with no `okta_alb` block.
The backend enforces its own auth: cookie sessions on user and admin routes, HMAC signature verification on the callback endpoint, and demo login routes are only compiled in under `NODE_ENV=development` (playground runs `production`).

---

## The change

Commit `ede4862` on `main` (merged via MR !13), in `.kubera/playground-backend.yaml`:

```yaml
ingress:
  enabled: true
  type: public
config:
  data:
    OIDC_ISSUER: https://adaptavist.okta.com
    NODE_ENV: production
    SKIP_OIDC: "true"
    ENABLE_CSRF: "false"
    FIRSTHAND_BASE_URL: https://first-hand.vercel.app
    BACKEND_URL: https://adaptalabs-backend.kubera-playground.adaptavist.net
    FRONTEND_URL: https://adaptalabs.kubera-playground.adaptavist.net
```

Previously the backend had `ingress: enabled: false` and none of the three new config keys.
The ingress syntax matches the documented Kubera pattern for a public ingress without Okta auth (per `kubera-config` reference docs in `cloud-native-platform/devex/devex-ai/kubera-agent-skills`).

---

## Evidence

### Pipelines are green

- Main pipeline **332225** (sha `a05c002`, created 2026-07-05T09:36Z): all jobs succeeded, including `docker-kaniko-build` and `docker-publish` for both apps.
  The only failure was `docker-trivy` on the backend image, which is `allow_failure` and did not block.
- Bridge `trigger-deployment-prod` → downstream pipeline **332226**: `get-kubera-secrets`, `kubera-playground-backend` and `kubera-playground-frontend` all **success** (completed ~09:41Z).

### The rendered ArgoCD spec is correct

The `kubera-playground-backend` job trace (job 1123115) shows the full Application spec that was committed and pushed to `cloud-native-platform/kubera/kubera-argo-apps/playground-apps.git` ("Updated ArgoCD config for adaptalabs-backend", ~09:41:42Z):

- `ingress: enabled: true / type: public` present
- All three new config keys present
- Chart: `kubera-application-chart`, targetRevision pinned by the values handler from `1.22.3` to `1.20.7`
- Sync policy: automated, `prune: true`, `selfHeal: true`

### The ingress does not exist

As of ~12:15Z (over 2.5 hours after the config push):

```
dig +short adaptalabs-backend.kubera-playground.adaptavist.net @8.8.8.8   → NXDOMAIN
dig +short adaptalabs-backend.kubera-playground.adaptavist.net @1.1.1.1   → NXDOMAIN
dig +short adaptalabs.kubera-playground.adaptavist.net @8.8.8.8           → resolves (frontend, for comparison)
curl https://adaptalabs-backend.kubera-playground.adaptavist.net/health   → connection failure (000)
```

Automated sync with selfHeal should have reconciled within minutes.
ALB plus external-dns provisioning normally completes well inside 10 minutes.

---

## Hypotheses (unverified — we lack cluster access)

1. **ArgoCD sync stuck or degraded on the backend app.**
   The platform's own `kubera-runtime-debug` docs record a failure class where a chart bug aborts the entire sync (PushSecret hook runs before its SecretStore exists; ESO rejects it; Argo aborts; nothing else in the sync gets applied).
   That was seen on `kubera-application-chart` 1.20.3; this deploy pinned **1.20.7**.
   If the sync aborts wholesale, the new Ingress resource would never be applied — consistent with what we observe.
   Relevant detail: the app has `secret: enabled: true` and the expected secret contents may not exist in the secret store yet (see the second ask below).
2. **Ingress applied but ALB/external-dns provisioning failed** (cert, IngressClass or target group issue).
   Less likely given nothing resolves at all after 2.5 hours.

## What we need

1. **Inspect the `adaptalabs-backend` ArgoCD Application on playground** (`kubectl get application -n argocd adaptalabs-backend -o yaml`, `.status.resources[]` and `.status.operationState`) and tell us why the Ingress isn't being applied — or fix the sync if it's the known chart issue.
2. **Add a secret to the `adaptalabs-backend` secret store:** key `FIRSTHAND_INTEGRATION_SECRET`.
   Nick holds the value (64 hex chars; it must match the value already configured on the FirstHand Vercel project).
   This is the last configuration step to enable the Cortex ↔ FirstHand integration — the app treats the integration as disabled until both `FIRSTHAND_BASE_URL` (already in config) and this secret are present.

## Access constraints on our side

Diagnosis needs kubectl against the playground cluster (AWS account `270148732964`, role `AWSKuberaPlayground`) or the ArgoCD UI.
Neither AWS SSO nor kubectl is set up on the machine this was driven from, and the `kubera-runtime-debug` guidance says application teams without that access should escalate rather than work around it.

## References

- MR !13: https://gitlab.adaptavist.net/cto/AdaptaLabs/-/merge_requests/13
- Main pipeline: https://gitlab.adaptavist.net/cto/AdaptaLabs/-/pipelines/332225
- Deploy pipeline: https://gitlab.adaptavist.net/cto/AdaptaLabs/-/pipelines/332226
- Backend deploy job trace: https://gitlab.adaptavist.net/cto/AdaptaLabs/-/jobs/1123115
- Integration contract: `docs/FIRSTHAND-INTEGRATION-CONTRACT.md` in this repo
