CREATE TABLE model_pricing (
  id                      SERIAL PRIMARY KEY,
  model_prefix            TEXT NOT NULL UNIQUE,
  input_cost_per_million  NUMERIC(12, 4) NOT NULL,
  output_cost_per_million NUMERIC(12, 4) NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
