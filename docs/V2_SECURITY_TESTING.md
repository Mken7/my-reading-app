# V2 backend security foundation — NOT DEPLOYED

## What has been committed

Migration order (isolated v2 names only):

1. `supabase/migrations/20261018223000_reading_access_v2.sql`
   - Room metadata, two-member slots (unique owner and partner role), notes.
   - Supabase `auth.uid()`-based RLS, authenticated-only create-room RPC.
   - Private/shared note visibility and server-generated revision/timestamps.
   - No direct client mutation of room memberships.
2. `supabase/migrations/20261018224000_reading_audit_v2.sql`
   - Server-side audit event on note create/update.
   - Room-scoped monotonically increasing sequence and chained SHA-256 event hashes.
   - Metadata and content digests only, no note or book plaintext in audit rows.
   - Database advisory locks serialize concurrent events in a room.

CI: `.github/workflows/validate-pr.yml` executes `tests/sql/reading_access_v2_smoke.sql` in an **ephemeral PostgreSQL 16 service**, independent of the real Supabase database. Tests assert owner access, partner privacy, anonymous and third-user denial, two-member capacity, field immutability, private audit access, and hash-chain consistency. The frontend continues to require strict lint + TypeScript/static export.

## Important limits

- **Not wired into the current reader UI.** Its existing legacy Supabase tables and browser-local identity remain unchanged and must not be considered protected by the V2 RLS tests.
- **Not applied to production.** Do not run `supabase db push`, connect the scripts to a production project or flip existing live RLS until staged migrations, migration compatibility, user mapping and rollback have been reviewed.
- Existing file/text delivery and old notes require a staged migration with user consent where relevant. No data is copied or deleted by these migrations.
- V2 room creation is not yet rate-limited. A real online release requires protected server-side invitation redemption, captcha/abuse risk checks, rate limiting, and book-text access checks (prefer chapter-scoped delivery) plus quotas and monitoring.
- The chain is **not independently anchored, signed or distributed**. A powerful database administrator could replace all events and recompute the hashes. Audit metadata still needs privacy retention, export/deletion policy, and independent signatures or immutable off-database anchors.
- The current two-seat uniqueness reserves the partner role permanently even if someone leaves. Replacement/archival rules are product decisions; do not work around them through client SQL.
- User blocking, co-reading archive, user deletion/erasure requests and moderator due process are **not implemented** yet.
- Passing an isolated role test does not prove real Supabase Realtime, storage policies, Edge Function security, abuse thresholds, or migrations from the legacy schema.

## Release safety checklist

- [ ] Review SQL migration and least-privilege grants in a disposable Supabase project (not just local PostgreSQL).
- [ ] Validate Supabase Auth user lifecycle, RLS, API schema exposure and Realtime subscriptions using two distinct real test accounts and a third unauthorized test account.
- [ ] Establish room invite generation/approval with cryptographic tokens, expiry, idempotency and server-validated cap.
- [ ] Introduce server-enforced quotas and anomaly rate limits; ensure accessibility and legitimate exports still work.
- [ ] Add signed/audited off-database chain-head snapshots and explicit data-retention process.
- [ ] Add monitoring and rollback plans and rehearse restore on synthetic data.
- [ ] Only then migrate UI flows and determine whether current users can safely migrate.
- [ ] Keep production deployment and merges gated by explicit review.
