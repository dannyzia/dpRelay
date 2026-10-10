-- F5 amendments (ISSUE-89, owner correction hub event 1320): regional
-- pricing. Each package carries its PRICE currency — credits stay
-- SMS-count-denominated, currency affects price only, never quota math.
--
-- SQLite allows CHECK constraints on ADD COLUMN; existing rows take the
-- DEFAULT 'BDT', which satisfies the CHECK, so no backfill or table rebuild
-- is needed. Applied migrations are never edited (schema_migrations tracks
-- by filename).

ALTER TABLE packages ADD COLUMN currency TEXT NOT NULL DEFAULT 'BDT'
  CHECK (currency IN ('BDT', 'USD', 'EUR'));
