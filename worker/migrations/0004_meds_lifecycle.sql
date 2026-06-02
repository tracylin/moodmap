-- Additive only. Safe on existing populated medications rows.

-- Dual names + display preference.
-- Existing `name` becomes the generic/primary; brand is new, display_pref defaults to showing what we already show.
ALTER TABLE medications ADD COLUMN brand TEXT;
ALTER TABLE medications ADD COLUMN display_pref TEXT NOT NULL DEFAULT 'generic'; -- 'generic' | 'both' | 'brand'

-- med_events: type the regimen change explicitly so the timeline renders without guessing.
-- old/new_value already exist (TEXT) -- keep them for the human-readable label, but add typed columns.
ALTER TABLE med_events ADD COLUMN new_ct REAL;          -- daily count after this event (NULL for 'discontinued')
ALTER TABLE med_events ADD COLUMN old_ct REAL;          -- daily count before (NULL for 'started')
ALTER TABLE med_events ADD COLUMN dose_text TEXT;       -- per-pill dose in effect at this event, e.g. '100mg'
ALTER TABLE med_events ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'; -- 'manual' | 'seed'

-- Backfill nothing structural; new columns are NULL/defaulted. No row rewrite needed.
