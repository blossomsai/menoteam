CREATE TABLE IF NOT EXISTS wb_records (id text PRIMARY KEY, kind text NOT NULL, project_id text, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS wb_records_scope ON wb_records(kind, project_id);
CREATE TABLE IF NOT EXISTS wb_users (id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_hash text NOT NULL, role text NOT NULL);
CREATE TABLE IF NOT EXISTS wb_sessions (digest text PRIMARY KEY, user_id text NOT NULL REFERENCES wb_users(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS wb_memberships (user_id text NOT NULL REFERENCES wb_users(id), project_id text NOT NULL, role text NOT NULL, PRIMARY KEY(user_id,project_id));
CREATE TABLE IF NOT EXISTS wb_invites (digest text PRIMARY KEY, email text NOT NULL, project_id text, role text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE IF NOT EXISTS wb_connectors (id text PRIMARY KEY, digest text UNIQUE NOT NULL, project_ids jsonb NOT NULL, capabilities jsonb NOT NULL DEFAULT '{}', last_seen timestamptz);
CREATE TABLE IF NOT EXISTS wb_requests (scope text NOT NULL, request_id text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(scope,request_id));
