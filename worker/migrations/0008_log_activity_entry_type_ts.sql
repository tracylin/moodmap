CREATE INDEX IF NOT EXISTS idx_log_activity_entry_type_ts ON log_activity(entry_date, type, ts DESC);
