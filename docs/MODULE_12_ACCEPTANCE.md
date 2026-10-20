# Module 12 — V2 room lifecycle acceptance

Staging-only code. Not deployed to production.

Implemented: voluntary partner departure; owner archive, restore and irreversible closure; authenticated personal export in eight page-limited sections; user-authored content erasure with retained tombstones; unanimous historical-member consent before room purge; moderation report hold.

Verified by `tests/sql/reading_retention_v2_smoke.sql` and `tests/unit/personalExportSchema.test.mjs`, plus existing CI suites.

**Explicit limits:** the UI shows copyable JSON pages, not a complete one-click archive. Personal erasure retains shared book chunks, others' replies, historic membership, moderation reports and audit metadata. True Auth-account deletion, backup deletion, real staging accounts, physical devices and regulatory data-retention policies are not completed. Production and main are unchanged.
