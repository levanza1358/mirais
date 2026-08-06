INSERT INTO settings (key, value)
VALUES (
  'routing_policy',
  '{"mode":"balanced","preferProviders":[],"denyProviders":[],"denyModels":[],"maxAttempts":3,"respectPriority":true}'
)
ON CONFLICT(key) DO NOTHING;
