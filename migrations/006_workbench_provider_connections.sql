-- Only real Connector-bound workspace provider connections participate. Older
-- metadata-only provider rows remain readable and explicitly unbound.
CREATE UNIQUE INDEX wb_provider_single_default ON wb_records ((data->>'kind'))
WHERE kind='setting' AND project_id IS NULL AND data->>'kind'='provider'
  AND data->'data'->>'connectorId' IS NOT NULL AND data->'data'->>'default'='true';
CREATE UNIQUE INDEX wb_provider_connector_identity ON wb_records ((data->'data'->>'connectorId'))
WHERE kind='setting' AND project_id IS NULL AND data->>'kind'='provider'
  AND data->'data'->>'connectorId' IS NOT NULL;
