ALTER TABLE works
  ADD COLUMN IF NOT EXISTS owner_source text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS owner_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'works_owner_source_check'
  ) THEN
    ALTER TABLE works
      ADD CONSTRAINT works_owner_source_check
      CHECK (owner_source IN ('confirmed', 'inferred', 'unresolved'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'works_owner_evidence_array_check'
  ) THEN
    ALTER TABLE works
      ADD CONSTRAINT works_owner_evidence_array_check
      CHECK (jsonb_typeof(owner_evidence) = 'array');
  END IF;
END $$;
