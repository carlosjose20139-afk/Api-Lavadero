-- Migración 005: Índices y trazabilidad por target_type para respuestas del foro
-- Reglas:
-- - Conserva la tabla forum_posts (publicaciones y respuestas) y forum_audits sin duplicar tablas.
-- - Asegura idempotentemente edited_at y deleted_at en forum_posts.
-- - Agrega índices para parent_id (post_id), author_id, deleted_at y created_at.
-- - Agrega target_type en forum_audits con backfill para auditorías de respuestas existentes.

ALTER TABLE forum_posts
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_forum_posts_author_id
  ON forum_posts(author_id);

CREATE INDEX IF NOT EXISTS idx_forum_posts_deleted_at
  ON forum_posts(deleted_at);

CREATE INDEX IF NOT EXISTS idx_forum_posts_created_at
  ON forum_posts(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_forum_posts_parent_created
  ON forum_posts(parent_id, created_at ASC);

ALTER TABLE forum_audits
  ADD COLUMN IF NOT EXISTS target_type VARCHAR(30) NOT NULL DEFAULT 'forum_post';

UPDATE forum_audits fa
SET target_type = 'forum_reply'
WHERE target_type = 'forum_post'
  AND EXISTS (
    SELECT 1
    FROM forum_posts fp
    WHERE fp.id = fa.post_id
      AND fp.parent_id IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_forum_audits_target_type
  ON forum_audits(target_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_forum_audits_post_id
  ON forum_audits(post_id, occurred_at DESC);

-- DOWN (reversión documentada para rollback manual si se requiere):
-- DROP INDEX IF EXISTS idx_forum_audits_post_id;
-- DROP INDEX IF EXISTS idx_forum_audits_target_type;
-- ALTER TABLE forum_audits DROP COLUMN IF EXISTS target_type;
-- DROP INDEX IF EXISTS idx_forum_posts_parent_created;
-- DROP INDEX IF EXISTS idx_forum_posts_created_at;
-- DROP INDEX IF EXISTS idx_forum_posts_deleted_at;
-- DROP INDEX IF EXISTS idx_forum_posts_author_id;
