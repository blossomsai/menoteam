CREATE TABLE wb_bridge_tokens (digest text PRIMARY KEY, run_id text NOT NULL, generation integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX wb_bridge_run ON wb_bridge_tokens(run_id,generation);
