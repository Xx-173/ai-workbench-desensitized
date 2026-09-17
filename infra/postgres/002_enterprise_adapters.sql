-- Safe migration for databases initialized before the enterprise adapters.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'http';
ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN ('http', 'python', 'mcp'));

CREATE TABLE IF NOT EXISTS case_memory (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  input_fingerprint text NOT NULL,
  input_bytes bigint NOT NULL,
  output_bytes bigint NOT NULL,
  duration_ms bigint NOT NULL,
  attempts integer NOT NULL,
  strategy text NOT NULL,
  failure_category text
);

CREATE INDEX IF NOT EXISTS idx_case_memory_agent_time ON case_memory (agent_id, occurred_at DESC);
