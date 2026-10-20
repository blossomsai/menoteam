CREATE INDEX wb_records_snapshot_run_evidence_idx
ON wb_records (project_id, (data->>'runId'))
WHERE kind='message' AND data->>'role' IN ('master','agent','subagent');
