-- Match latestWorkDiff authorization without touching chunk payloads.
CREATE INDEX wb_records_latest_work_diff_idx
ON wb_records (project_id, (data->>'workId'), updated_at DESC, id DESC)
WHERE kind='artifact' AND data->>'kind'='diff';
