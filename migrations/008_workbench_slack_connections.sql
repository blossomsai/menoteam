-- Active Slack routing is one source connection globally, never project fanout.
-- Existing duplicate triples fail migration visibly rather than choosing a route.
CREATE UNIQUE INDEX wb_slack_active_source_identity ON wb_records
    ((data->'data'->>'appId'), (data->'data'->>'teamId'), (data->'data'->>'channelId'))
    WHERE kind='setting' AND data->>'kind'='connection' AND project_id IS NOT NULL
      AND data->'data'->>'provider'='slack'
      AND (NOT (data->'data' ? 'purpose') OR data->'data'->>'purpose'='source')
      AND data->'data'->'enabled' IS DISTINCT FROM 'false'::jsonb
      AND data->'data'->>'appId' IS NOT NULL
      AND data->'data'->>'teamId' IS NOT NULL
      AND data->'data'->>'channelId' IS NOT NULL;
