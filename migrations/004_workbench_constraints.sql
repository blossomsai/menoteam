ALTER TABLE wb_records ADD CONSTRAINT wb_record_kind CHECK(kind IN ('project','work','message','run','artifact','setting','event'));
ALTER TABLE wb_records ADD CONSTRAINT wb_record_scope_matches CHECK((data->>'projectId') IS NOT DISTINCT FROM project_id);
CREATE INDEX wb_message_history ON wb_records(project_id,(data->>'workId'),(data->>'createdAt'),id) WHERE kind='message';
CREATE INDEX wb_run_status ON wb_records(project_id,(data->>'status')) WHERE kind='run';
CREATE INDEX wb_run_events ON wb_records((data->>'runId'),((data->>'sequence')::integer)) WHERE kind='event';
