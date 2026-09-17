-- Agent Workbench production metadata schema.
-- Secrets are intentionally absent: keep them in a Secret Manager/KMS.

CREATE TABLE IF NOT EXISTS departments (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workbench_users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  department_id text NOT NULL REFERENCES departments(id),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  manifest jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workbench_tasks (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES workbench_users(id),
  department_id text NOT NULL REFERENCES departments(id),
  agent_id text NOT NULL REFERENCES agents(id),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES workbench_users(id),
  department_id text NOT NULL REFERENCES departments(id),
  area text NOT NULL CHECK (area IN ('inputs', 'outputs', 'tmp')),
  filename text NOT NULL,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS usage_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  user_id text REFERENCES workbench_users(id),
  department_id text REFERENCES departments(id),
  agent_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('user', 'admin_test')),
  kind text NOT NULL CHECK (kind IN ('http', 'python', 'mcp')) DEFAULT 'http',
  success boolean NOT NULL,
  duration_ms bigint NOT NULL,
  input_bytes bigint NOT NULL DEFAULT 0,
  output_bytes bigint NOT NULL DEFAULT 0,
  input_tokens bigint,
  output_tokens bigint
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON workbench_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_department_created ON workbench_tasks (department_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_department_time ON usage_events (department_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_agent_time ON usage_events (agent_id, occurred_at DESC);

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
