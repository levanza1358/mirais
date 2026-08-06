DELETE FROM gateway_keys
WHERE id NOT IN (
  SELECT id
  FROM gateway_keys
  ORDER BY datetime(created_at) ASC, id ASC
  LIMIT 1
);
