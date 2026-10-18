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
3. `supabase/migrations/20261018225000_room_invites_v2.sql`
   - Generates one-time six-character invitation codes (base32, 30-bit entropy), shown only at creation.
   - Stores keyed SHA-256 code digests using a database-private random pepper. The code is **not reversibly encrypted**.
   - A 24-hour expiry, automatic revocation on rotation, and owner-only review are enforced in trusted RPCs.
   - Failed and successful lookups count toward an authenticated-account limit of five attempts per hour; the counter persists after invalid responses.
   - Pending requests are not memberships. Only owner approval can consume a code and fill the partner slot.
4. `supabase/migrations/20261018230000_v2_issuance_quotas.sql`
   - Transactional database triggers cap account issuance to three rooms and ten invitations per rolling 24-hour window.
   - Separate from the five join-code attempts per hour; account-farm and IP/device risk protection still needed.

CI: `.github/workflows/validate-pr.yml` executes `tests/sql/reading_invites_v2_smoke.sql` (which includes the prior access/audit smoke tests) in an **ephemeral PostgreSQL 16 service**, independent of the real Supabase database. Tests assert owner access, partner privacy, anonymous and third-user denial, two-member capacity, field immutability, private audit access, hash-chain consistency, invite rotation, owner approval, replay denial, actor-level throttling, and issuance quotas. The frontend continues to require strict lint + TypeScript/static export.

## Important limits

- **Not wired into the current legacy reader UI.** Its existing Supabase tables and browser-local identity remain unchanged and must not be considered protected by V2 RLS. A separate `/v2/` preview now demonstrates email authentication, room lists and approval flow, but it is disabled by default and must use an isolated staging Supabase project. See `docs/V2_AUTH_PREVIEW.md`.
- **Not applied to production.** Do not run `supabase db push`, connect the scripts to a production project or flip existing live RLS until staged migrations, migration compatibility, user mapping and rollback have been reviewed.
- Existing file/text delivery and old notes require a staged migration with user consent where relevant. No data is copied or deleted by these migrations.
- V2 room creation, invite issuance and code redemption now have **per-account database quotas only**. An attacker can distribute guesses or spam across throwaway accounts. Before any public rollout, add signup protection, IP/device/network-based adaptive limits, bot-risk checks with accessible fallbacks, and monitoring at a trusted Edge Function / gateway, plus book-text access checks (prefer chapter-scoped delivery).
- The chain is **not independently anchored, signed or distributed**. A powerful database administrator could replace all events and recompute the hashes. Audit metadata still needs privacy retention, export/deletion policy, and independent signatures or immutable off-database anchors.
- The current two-seat uniqueness reserves the partner role permanently even if someone leaves. Replacement/archival rules are product decisions; do not work around them through client SQL.
- User blocking, co-reading archive, user deletion/erasure requests and moderator due process are **not implemented** yet.
- Passing an isolated role test does not prove real Supabase Realtime, storage policies, Edge Function security, abuse thresholds, or migrations from the legacy schema.

## Release safety checklist

- [ ] Review SQL migration and least-privilege grants in a disposable Supabase project (not just local PostgreSQL).
- [ ] Validate Supabase Auth user lifecycle, RLS, API schema exposure and Realtime subscriptions using two distinct real test accounts and a third unauthorized test account.
- [x] Add owner-approved, expiring, rotating, one-use code redemption RPCs with persistent per-account throttling in the isolated V2 schema.
- [x] Add transactional account-based quotas for room creation and invitation issuance, with PostgreSQL regression tests.
- [x] Add opt-in isolated V2 email login and owner-approval preview route (requires separate staging credentials, never activated in the normal build).
- [ ] Confirm the preview with real Supabase Auth in a non-production environment; prevent account-farm / IP-scale guessing before public exposure.
- [ ] Introduce server-enforced quotas and anomaly rate limits; ensure accessibility and legitimate exports still work.
- [ ] Add signed/audited off-database chain-head snapshots and explicit data-retention process.
- [ ] Add monitoring and rollback plans and rehearse restore on synthetic data.
- [ ] Only then migrate UI flows and determine whether current users can safely migrate.
- [ ] Keep production deployment and merges gated by explicit review.
