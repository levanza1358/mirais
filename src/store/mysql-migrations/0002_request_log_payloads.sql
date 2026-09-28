CREATE TABLE IF NOT EXISTS request_log_payloads (
  request_log_id VARCHAR(64) NOT NULL,
  request_body LONGTEXT NULL,
  response_body LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (request_log_id),
  KEY idx_request_log_payloads_created_at (created_at),
  CONSTRAINT fk_request_log_payloads_log FOREIGN KEY (request_log_id) REFERENCES request_logs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO request_log_payloads (request_log_id, request_body, response_body, created_at)
SELECT id, request_body, response_body, ts
FROM request_logs
WHERE request_body IS NOT NULL OR response_body IS NOT NULL
ON DUPLICATE KEY UPDATE
  request_body = COALESCE(request_log_payloads.request_body, VALUES(request_body)),
  response_body = COALESCE(request_log_payloads.response_body, VALUES(response_body)),
  created_at = COALESCE(request_log_payloads.created_at, VALUES(created_at));

CREATE INDEX idx_logs_kind_ts ON request_logs(kind, ts);
CREATE INDEX idx_logs_kind_status_ts ON request_logs(kind, status, ts);
CREATE INDEX idx_logs_kind_provider_ts ON request_logs(kind, provider, ts);
