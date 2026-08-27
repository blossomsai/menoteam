CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS teammates (
  ref text PRIMARY KEY CHECK (ref ~ '^teammate_[A-Za-z0-9_-]+$'),
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  agent_addresses jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(agent_addresses) = 'object'),
  memory text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS teammates_display_name_ci_idx ON teammates (lower(display_name));
CREATE INDEX IF NOT EXISTS teammates_search_idx ON teammates USING gin (to_tsvector('simple', display_name || ' ' || memory));

CREATE TABLE IF NOT EXISTS works (
  ref text PRIMARY KEY CHECK (ref ~ '^work_[A-Za-z0-9_-]+$'),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  owner_teammate_ref text NOT NULL REFERENCES teammates(ref),
  state text NOT NULL CHECK (state IN ('current', 'completed')),
  parent_ref text REFERENCES works(ref),
  current_summary text NOT NULL,
  living_doc_markdown text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS works_search_idx ON works USING gin (to_tsvector('simple', title || ' ' || current_summary || ' ' || living_doc_markdown));
CREATE INDEX IF NOT EXISTS works_owner_state_idx ON works (owner_teammate_ref, state, title, ref);
CREATE INDEX IF NOT EXISTS works_parent_idx ON works (parent_ref, title, ref);

CREATE TABLE IF NOT EXISTS work_dependencies (
  work_ref text NOT NULL REFERENCES works(ref),
  dependency_ref text NOT NULL REFERENCES works(ref),
  PRIMARY KEY (work_ref, dependency_ref),
  CHECK (work_ref <> dependency_ref)
);

CREATE TABLE IF NOT EXISTS entity_revisions (
  entity_kind text NOT NULL CHECK (entity_kind IN ('work', 'teammate')),
  entity_ref text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  full_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, entity_ref, revision)
);

CREATE INDEX IF NOT EXISTS entity_revisions_ref_idx ON entity_revisions (entity_ref, revision);
