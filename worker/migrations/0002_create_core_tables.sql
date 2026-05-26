CREATE TABLE mood_entries (
  date TEXT PRIMARY KEY,
  day TEXT,
  moods TEXT,
  sleep REAL,
  irritability INTEGER,
  anxiety INTEGER,
  notes TEXT,
  weight REAL,
  actor TEXT DEFAULT 'Wei',
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_med_doses (
  date TEXT NOT NULL,
  med_key TEXT NOT NULL,
  count REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, med_key)
);

CREATE TABLE srm_items (
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  am INTEGER,
  did_not INTEGER DEFAULT 0,
  with_others INTEGER DEFAULT 0,
  who TEXT,
  who_text TEXT,
  engagement INTEGER DEFAULT 0,
  actor TEXT DEFAULT 'Wei',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE medications (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dose TEXT,
  status TEXT DEFAULT 'active',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE med_events (
  id TEXT PRIMARY KEY,
  med_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  date TEXT NOT NULL,
  notes TEXT,
  ts TEXT NOT NULL
);

CREATE INDEX idx_med_events_key ON med_events(med_key, date);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT,
  auth TEXT,
  role TEXT DEFAULT 'primary',
  actor TEXT DEFAULT 'Wei',
  tz TEXT,
  created_at TEXT,
  last_sent_at TEXT
);

CREATE TABLE log_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL
);

CREATE INDEX idx_log_activity_ts ON log_activity(ts DESC);

CREATE TABLE push_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
