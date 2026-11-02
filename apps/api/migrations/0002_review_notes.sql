-- Reviewer notes for "needs info" / rejections. Only keccak256(note) goes on-chain (as reasonRef);
-- the text lives here so the submitter can read what's needed.
CREATE TABLE review_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,   -- e.g. 'warehouse-receipt-submission', 'lpo', 'xown-proposal'
  entity_id    TEXT NOT NULL,
  note         TEXT NOT NULL,
  reason_ref   TEXT NOT NULL,
  author_id    UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_notes_entity_idx ON review_notes (entity_type, entity_id, created_at DESC);
