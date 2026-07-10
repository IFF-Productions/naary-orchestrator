-- RAG: an ivfflat index for approximate cosine search on VectorChunk.embedding. Speeds up
-- vectorQuery on larger collections; exact search still works if the planner skips it. `lists`
-- is a modest default for small/medium stores. (The extension + column are from the prior migration.)
CREATE INDEX IF NOT EXISTS "VectorChunk_embedding_cosine_idx"
  ON "VectorChunk" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
