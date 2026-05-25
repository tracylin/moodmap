CREATE TABLE dev_notes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE INDEX idx_dev_notes_ts ON dev_notes(ts DESC);
