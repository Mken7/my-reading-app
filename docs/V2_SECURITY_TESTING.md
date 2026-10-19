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
5. `supabase/migrations/20261018231000_v2_private_book_chunks.sql`
   - No direct client SELECT on book content. Authenticated RPC checks active room membership and returns at most two limited-size chunks per request.
   - Owner-only immutable chunk upload, 300 chunks/day per account, and 60 read chunks/hour per room member. Closed rooms cannot deliver content.
   - Manual staging-only content upload/reader panel is wired into `/v2/`; local TXT / EPUB / searchable-text PDF staged ingest is available; legal deletion/export, gateway/IP throttling and production migration still missing. See `docs/V2_PROTECTED_CONTENT.md`.

6. `supabase/migrations/20261018234000_v2_chapters_progress.sql` adds private chapter navigation and per-user revision-safe reading cursors.
7. `supabase/migrations/20261018235000_v2_overlap_annotations.sql` permits independent overlapping text notes, enforces private/shared RLS and appends hash-chain audit events. See `docs/V2_READING_ANNOTATIONS.md`.

8. `supabase/migrations/20261019001000_v2_ink.sql` adds normalized and bounded circle/arrow/stroke shapes with private/shared membership checks and hash-chain audit.
9. `supabase/migrations/20261019002000_v2_note_replies.sql` adds visibility-inherited text note replies, strict per-note limits and audit. See `docs/V2_INK_AND_REPLIES.md`.
10. `supabase/migrations/20261019003000_v2_text_relative_ink.sql` adds optional Unicode text range anchors for new strokes, retaining nullable legacy shapes. The ink audit digest includes the anchor range, and database guards reject half-empty or out-of-range anchors.
11. `supabase/migrations/20261019004000_v2_soft_hide.sql` adds owner-only, server-audited hide RPCs for saved ink and replies. Hidden content is excluded from authenticated RLS SELECT but retained for later lawful erasure/retention planning.
12. `supabase/migrations/20261019005000_v2_idempotent_submissions.sql` adds room/author/client-operation uniqueness and authenticated submission RPCs. Identical retries do not duplicate notes/replies or audit events; changed payloads, visibility changes, hidden reply replays and unauthorized members cannot silently change prior data. See `docs/V2_RETRY_SAFE_SUBMISSIONS.md`.
13. `supabase/migrations/20261019006000_v2_saved_bookmarks_sync.sql` adds at most 20 private personal named pins per room/reader and fixes nonzero initial revision creating a cursor.
14. `supabase/migrations/20261019007000_v2_character_reading_position.sql` adds Unicode-codepoint offsets to the private reading cursor, preserves the legacy three-argument API, and exposes read/update RPCs with strict CAS and private membership checks. See `docs/MODULE_08_ACCEPTANCE.md`.
15. `supabase/migrations/20261019008000_v2_ink_reflow_policy.sql` records single-line reflow-safe geometry, revokes ink visibility for former/closed-room members, and includes the layout mode in chained ink audit payloads. See `docs/MODULE_07_ACCEPTANCE.md`.

16. `supabase/migrations/20261019009000_v2_note_management.sql` adds version-checked editing, soft retraction, annotation quotas, and stricter parent-child access. See `docs/MODULE_06_ACCEPTANCE.md`.
17. `supabase/migrations/20261019010000_v2_idempotent_book_import.sql` adds owner-only exact-match immutable paragraph retry. A retry with identical text does not charge quota; another text at the same index is rejected. PDF, EPUB and TXT are parsed locally before explicit upload consent. See `docs/MODULE_04_ACCEPTANCE.md`.

CI: `.github/workflows/validate-pr.yml` executes `tests/sql/reading_import_v2_smoke.sql` (which includes the prior access/audit smoke tests) in an **ephemeral PostgreSQL 16 service**, independent of the real Supabase database. Tests assert owner access, partner privacy, anonymous and third-user denial, two-member capacity, field immutability, private audit access, hash-chain consistency, invite rotation, owner approval, replay denial, actor-level throttling, issuance quotas, protected chunk reads, immutable owner uploads and per-user read/write limits. The frontend continues to require strict lint + TypeScript/static export.

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
- [x] Add limited-size member-only content RPC and per-user database read/upload quotas, verified with isolated PostgreSQL tests.
- [x] Add locally parsed TXT/EPUB/PDF-text preview, explicit rights confirmation, PNG-free worker-only PDF.js extraction, and exact-match immutable upload retries without quota double-charging. CI includes actual Chromium EPUB/DEFLATE and PDF.js decoding and staging-only PostgreSQL security checks.
- [x] Add chapter indexes, per-account reading progress with stale-device conflict detection, and independently overlapping private/shared text notes, with isolated database and Unicode tests.
- [x] Add bounded hand-drawn circles/arrows/strokes and private/shared threaded replies with isolated SQL and geometry tests.
- [x] Introduce optional text-relative anchored ink with legacy-stroke compatibility, Unicode/emoji range tests and paragraph reflow recalculation.
- [x] Prevent distortion of new ink after selected words wrap across multiple lines, while preserving old anchor layout. Real Chromium DOM Range tests cover line wrapping and reset. Keyboard selection + circle/arrow presets are implemented.
- [ ] Validate touch/selection/scroll and screen readers on actual iOS/Android. The single-line design intentionally does not reconstruct arbitrary multi-line freehand curves.
- [x] Add owner-only soft hide of saved ink/replies, enforced by RLS and trusted RPCs with hash-chain events and multi-user regression checks.
- [ ] Implement actual legal erasure/retention/export workflows; soft hiding leaves the original payload in the server database.
- [x] Add encrypted per-target pending drafts with retained client operation IDs and server-checked idempotent manual retries (not an automatic offline queue).
- [x] Add bounded multi-item (10 per target) encrypted pending list with explicit per-item recovery and clearing; never auto-send private text.
- [x] Add IndexedDB atomic writes, storage health checks, password-authenticated encrypted backup file transfer, real Chromium IndexedDB integration tests and no-plaintext queues.
- [ ] Add transactional multi-tab coordination, automatic offline queue policy, accessibility alternatives and device/browser integration tests.
- [ ] Add IP/network-aware gateway limits, anomalous-use detection and accessible challenges; preserve legitimate reading and data exports.
- [ ] Add signed/audited off-database chain-head snapshots and explicit data-retention process.
- [ ] Add monitoring and rollback plans and rehearse restore on synthetic data.
- [ ] Only then migrate UI flows and determine whether current users can safely migrate.
- [ ] Keep production deployment and merges gated by explicit review.
