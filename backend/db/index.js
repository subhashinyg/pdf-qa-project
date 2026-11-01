const { Pool } = require("pg");
const pgvector = require("pgvector/pg");

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pdf_qa";

const isRemoteDb =
  DATABASE_URL.includes("supabase.co") ||
  DATABASE_URL.includes("pooler.supabase.com") ||
  DATABASE_URL.includes("neon.tech") ||
  DATABASE_URL.includes("sslmode=require");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

let isInitialized = false;
let hasVectorExtension = false;

/**
 * Initializes database tables and pgvector extension if available.
 * Adds folders table and extends documents with folder_id, file_type, storage_path, etc.
 */
async function initDb() {
  if (isInitialized) return;

  try {
    const client = await pool.connect();
    try {
      // 1. Try enabling pgvector extension
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
        hasVectorExtension = true;
        console.log("PostgreSQL pgvector extension verified/enabled.");
      } catch (extErr) {
        hasVectorExtension = false;
        console.warn(
          "Notice: pgvector extension not installed on this PostgreSQL instance. " +
            "Vector search will use in-memory cosine similarity: " +
            extErr.message
        );
      }

      console.log("Initializing database schema for File Explorer...");

      // 2. Create folders table
      await client.query(`
        CREATE TABLE IF NOT EXISTS folders (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `);

      // 3. Create or update documents table
      await client.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id SERIAL PRIMARY KEY,
          file_name TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          total_pages INTEGER,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `);

      // 4. Safely add explorer columns to documents
      await client.query(`
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_type TEXT DEFAULT 'pdf';
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime_type TEXT;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_path TEXT;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS extracted_text TEXT;
      `);

      // 5. Create document_chunks table
      const embeddingType = hasVectorExtension ? "vector(768)" : "JSONB";
      await client.query(`
        CREATE TABLE IF NOT EXISTS document_chunks (
          id SERIAL PRIMARY KEY,
          document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          character_count INTEGER,
          embedding ${embeddingType},
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `);

      // 6. Create vector index if pgvector is supported
      if (hasVectorExtension) {
        try {
          await client.query(`
            CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding 
            ON document_chunks USING hnsw (embedding vector_cosine_ops);
          `);
        } catch (idxErr) {
          console.warn("Notice: HNSW index creation deferred:", idxErr.message);
        }
      }

      isInitialized = true;
      console.log("Database initialized successfully with folders, documents, and chunks.");
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn(
      `PostgreSQL connection pending: ${err.message}. Server will remain functional and retry on requests.`
    );
  }
}

/**
 * Checks connection status to PostgreSQL.
 */
async function getDbStatus() {
  try {
    const client = await pool.connect();
    client.release();
    return { connected: true, hasVector: hasVectorExtension };
  } catch (err) {
    return { connected: false, hasVector: false, error: err.message };
  }
}

/* ============================================================
   FOLDERS OPERATIONS
   ============================================================ */

/**
 * Lists folders under a parent folder (or root if parentId is null).
 */
async function getFolders(parentId = null) {
  const query = parentId
    ? `
      SELECT f.*,
        (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) AS subfolder_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) AS file_count
      FROM folders f
      WHERE f.parent_id = $1
      ORDER BY f.name ASC;
    `
    : `
      SELECT f.*,
        (SELECT COUNT(*) FROM folders sub WHERE sub.parent_id = f.id) AS subfolder_count,
        (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) AS file_count
      FROM folders f
      WHERE f.parent_id IS NULL
      ORDER BY f.name ASC;
    `;

  const values = parentId ? [parentId] : [];
  const res = await pool.query(query, values);
  return res.rows;
}

/**
 * Creates a new folder.
 */
async function createFolder(name, parentId = null) {
  const query = `
    INSERT INTO folders (name, parent_id)
    VALUES ($1, $2)
    RETURNING *;
  `;
  const res = await pool.query(query, [name.trim(), parentId || null]);
  return res.rows[0];
}

/**
 * Deletes a folder and all its contents (cascading).
 */
async function deleteFolder(folderId) {
  const query = `DELETE FROM folders WHERE id = $1 RETURNING *;`;
  const res = await pool.query(query, [folderId]);
  return res.rows[0] || null;
}

/**
 * Retrieves breadcrumb hierarchy leading to a folder.
 */
async function getFolderBreadcrumbs(folderId) {
  if (!folderId) return [];
  try {
    const query = `
      WITH RECURSIVE breadcrumbs AS (
        SELECT id, name, parent_id, 1 as level FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id, f.name, f.parent_id, b.level + 1 FROM folders f
        JOIN breadcrumbs b ON f.id = b.parent_id
      )
      SELECT id, name, parent_id FROM breadcrumbs ORDER BY level DESC;
    `;
    const res = await pool.query(query, [folderId]);
    return res.rows;
  } catch (err) {
    console.warn("Breadcrumb query fallback:", err.message);
    const res = await pool.query("SELECT id, name, parent_id FROM folders WHERE id = $1", [folderId]);
    return res.rows;
  }
}

/* ============================================================
   DOCUMENTS OPERATIONS
   ============================================================ */

/**
 * Lists documents inside a folder, or at root if folderId is null.
 * Optionally filters by search term.
 */
async function getDocuments({ folderId = null, search = "" } = {}) {
  let query = `
    SELECT d.*, 
      (SELECT COUNT(*) FROM document_chunks dc WHERE dc.document_id = d.id) AS chunk_count,
      f.name AS folder_name
    FROM documents d
    LEFT JOIN folders f ON d.folder_id = f.id
  `;
  const params = [];

  const conditions = [];

  if (folderId === "all") {
    // Show all documents regardless of folder
  } else if (folderId) {
    params.push(folderId);
    conditions.push(`d.folder_id = $${params.length}`);
  } else {
    conditions.push(`d.folder_id IS NULL`);
  }

  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`d.file_name ILIKE $${params.length}`);
  }

  if (conditions.length > 0) {
    query += ` WHERE ` + conditions.join(" AND ");
  }

  query += ` ORDER BY d.created_at DESC;`;

  const res = await pool.query(query, params);
  return res.rows;
}

/**
 * Gets a single document by ID.
 */
async function getDocumentById(id) {
  const query = `
    SELECT d.*, 
      (SELECT COUNT(*) FROM document_chunks dc WHERE dc.document_id = d.id) AS chunk_count,
      f.name AS folder_name
    FROM documents d
    LEFT JOIN folders f ON d.folder_id = f.id
    WHERE d.id = $1;
  `;
  const res = await pool.query(query, [id]);
  return res.rows[0] || null;
}

/**
 * Inserts a new document record.
 */
async function insertDocument({
  fileName,
  fileSize,
  totalPages = 1,
  folderId = null,
  fileType = "pdf",
  mimeType = "",
  storagePath = null,
  extractedText = "",
}) {
  const query = `
    INSERT INTO documents (
      file_name, file_size, total_pages, folder_id, file_type, mime_type, storage_path, extracted_text
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;
  const res = await pool.query(query, [
    fileName,
    fileSize,
    totalPages || 1,
    folderId || null,
    fileType,
    mimeType,
    storagePath,
    extractedText,
  ]);
  return res.rows[0];
}

/**
 * Deletes a document record by ID.
 */
async function deleteDocument(id) {
  const query = `DELETE FROM documents WHERE id = $1 RETURNING *;`;
  const res = await pool.query(query, [id]);
  return res.rows[0] || null;
}

/**
 * Batch-inserts chunks for a document.
 */
async function insertChunks(documentId, chunks) {
  if (!chunks || chunks.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const chunk of chunks) {
      const embeddingVal =
        chunk.embedding && hasVectorExtension
          ? pgvector.toSql(chunk.embedding)
          : chunk.embedding
          ? JSON.stringify(chunk.embedding)
          : null;

      await client.query(
        `INSERT INTO document_chunks (document_id, chunk_index, content, character_count, embedding)
         VALUES ($1, $2, $3, $4, $5);`,
        [
          documentId,
          chunk.chunkIndex,
          chunk.content,
          chunk.characterCount,
          embeddingVal,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ============================================================
   VECTOR SIMILARITY SEARCH
   ============================================================ */

/**
 * Computes cosine similarity between two numeric vectors in JavaScript.
 */
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Selects a diverse, balanced set of chunks across multiple documents.
 * Ensures that if a user asks a question touching multiple files, no single file
 * (especially large PDFs or duplicates) starves other documents of context.
 *
 * @param {Array} chunks - Scored chunks
 * @param {number} totalLimit - Target number of chunks to return (default 8)
 * @param {string} [query] - User question for entity / filename matching boost
 * @param {boolean} [isMultiDoc=true] - Whether search is across multiple documents
 */
function selectStratifiedDiverseChunks(chunks, totalLimit = 8, query = "", isMultiDoc = true) {
  if (!chunks || chunks.length === 0) return [];

  // For single document scope, deduplicate and return top scoring chunks
  if (!isMultiDoc) {
    const seenText = new Set();
    const deduped = [];
    for (const chunk of chunks) {
      const textKey = (chunk.content || "").trim().slice(0, 100);
      if (!seenText.has(textKey)) {
        seenText.add(textKey);
        deduped.push(chunk);
      }
    }
    return deduped.sort((a, b) => b.similarity - a.similarity).slice(0, totalLimit);
  }

  // Extract query keywords for term matching boost
  const queryWords = query
    ? query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2)
    : [];

  // 1. Boost similarity if query specifically mentions words in the document filename
  const boostedChunks = chunks.map((chunk) => {
    let sim = Number(chunk.similarity) || 0;
    if (queryWords.length > 0 && chunk.file_name) {
      const fileNameLower = chunk.file_name.toLowerCase();
      let matchCount = 0;
      for (const word of queryWords) {
        if (fileNameLower.includes(word)) {
          matchCount++;
        }
      }
      if (matchCount > 0) {
        sim += Math.min(matchCount * 0.08, 0.20);
      }
    }
    return { ...chunk, similarity: sim };
  }).sort((a, b) => b.similarity - a.similarity);

  // 2. Deduplicate identical chunk content (protects against duplicate uploads of the same file)
  const seenContent = new Set();
  const fileGroups = {};

  for (const chunk of boostedChunks) {
    const textSnippet = (chunk.content || "").trim().slice(0, 100);
    if (seenContent.has(textSnippet)) continue;
    seenContent.add(textSnippet);

    const groupKey = chunk.file_name || String(chunk.document_id);
    fileGroups[groupKey] = fileGroups[groupKey] || [];
    fileGroups[groupKey].push(chunk);
  }

  // 3. Sort files by their top chunk's similarity
  const sortedFiles = Object.keys(fileGroups).sort((a, b) => {
    return fileGroups[b][0].similarity - fileGroups[a][0].similarity;
  });

  // 4. Stratified selection: Round-robin across the top files
  // Round 1: Top 2 chunks from each file (gives immediate voice to all relevant documents)
  const finalPicks = [];
  for (const file of sortedFiles) {
    const topPicks = fileGroups[file].slice(0, 2);
    finalPicks.push(...topPicks);
    if (finalPicks.length >= totalLimit) break;
  }

  // Round 2: If we still have slots under totalLimit, take the 3rd chunk
  if (finalPicks.length < totalLimit) {
    for (const file of sortedFiles) {
      if (fileGroups[file].length > 2) {
        finalPicks.push(fileGroups[file][2]);
        if (finalPicks.length >= totalLimit) break;
      }
    }
  }

  // Round 3: If still under totalLimit, fill with any remaining highest-scoring chunks
  if (finalPicks.length < totalLimit) {
    const pickedIds = new Set(
      finalPicks.map((p) => (p.chunk_index !== undefined ? p.chunk_index : "") + "-" + (p.file_name || p.document_id))
    );
    for (const file of sortedFiles) {
      for (const c of fileGroups[file]) {
        const id = (c.chunk_index !== undefined ? c.chunk_index : "") + "-" + (c.file_name || c.document_id);
        if (!pickedIds.has(id)) {
          pickedIds.add(id);
          finalPicks.push(c);
          if (finalPicks.length >= totalLimit) break;
        }
      }
      if (finalPicks.length >= totalLimit) break;
    }
  }

  // Preserve descending order of similarity
  return finalPicks.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Flexible semantic search supporting:
 * - Single document scope (documentId)
 * - Folder scope (folderId)
 * - Global all-documents scope
 * With multi-document diversification and keyword boosting.
 * 
 * @param {object} options
 * @param {number[]} options.queryEmbedding
 * @param {string} [options.query=""]
 * @param {number} [options.limit=8]
 * @param {number} [options.documentId]
 * @param {number} [options.folderId]
 * @param {'file' | 'folder' | 'all'} [options.scope='all']
 */
async function searchSimilarChunks({
  queryEmbedding,
  query = "",
  limit = 8,
  documentId = null,
  folderId = null,
  scope = "all",
}) {
  const whereClauses = [];
  const params = [];

  if (scope === "file" && documentId) {
    params.push(documentId);
    whereClauses.push(`dc.document_id = $${params.length}`);
  } else if (scope === "folder" && folderId) {
    params.push(folderId);
    whereClauses.push(`d.folder_id = $${params.length}`);
  }

  // Fallback if no embedding is available
  if (!queryEmbedding) {
    let fallbackSql = `
      SELECT dc.chunk_index, dc.content, dc.document_id, d.file_name
      FROM document_chunks dc
      JOIN documents d ON dc.document_id = d.id
    `;
    if (whereClauses.length > 0) {
      fallbackSql += ` WHERE ` + whereClauses.join(" AND ");
    }
    fallbackSql += ` ORDER BY dc.id ASC LIMIT $${params.length + 1};`;
    params.push(limit * 3);

    const res = await pool.query(fallbackSql, params);
    const mapped = res.rows.map((r) => ({ ...r, similarity: 1.0 }));
    return selectStratifiedDiverseChunks(mapped, limit, query, scope !== "file");
  }

  // 1. If pgvector extension is enabled, use native <=> operator
  if (hasVectorExtension) {
    params.unshift(pgvector.toSql(queryEmbedding)); // $1 is query embedding
    const pgWhere = ["dc.embedding IS NOT NULL"];
    if (scope === "file" && documentId) {
      params.push(documentId);
      pgWhere.push(`dc.document_id = $${params.length}`);
    } else if (scope === "folder" && folderId) {
      params.push(folderId);
      pgWhere.push(`d.folder_id = $${params.length}`);
    }

    // Fetch candidate pool (3x to 4x limit) so we can diversify across documents
    const candidateLimit = scope === "file" ? limit : Math.max(limit * 4, 30);
    params.push(candidateLimit);
    const limitIndex = params.length;

    const querySql = `
      SELECT dc.chunk_index, dc.content, dc.document_id, d.file_name,
             1 - (dc.embedding <=> $1) AS similarity
      FROM document_chunks dc
      JOIN documents d ON dc.document_id = d.id
      WHERE ${pgWhere.join(" AND ")}
      ORDER BY dc.embedding <=> $1
      LIMIT $${limitIndex};
    `;

    const res = await pool.query(querySql, params);
    return selectStratifiedDiverseChunks(res.rows, limit, query, scope !== "file");
  }

  // 2. In-memory cosine similarity fallback
  let selectSql = `
    SELECT dc.chunk_index, dc.content, dc.embedding, dc.document_id, d.file_name
    FROM document_chunks dc
    JOIN documents d ON dc.document_id = d.id
    WHERE dc.embedding IS NOT NULL
  `;
  if (whereClauses.length > 0) {
    selectSql += ` AND ` + whereClauses.join(" AND ");
  }

  const res = await pool.query(selectSql, params);

  if (res.rows.length === 0) {
    // If no embeddings yet, return top text chunks
    let emptyFallbackSql = `
      SELECT dc.chunk_index, dc.content, dc.document_id, d.file_name
      FROM document_chunks dc
      JOIN documents d ON dc.document_id = d.id
    `;
    if (whereClauses.length > 0) {
      emptyFallbackSql += ` WHERE ` + whereClauses.join(" AND ");
    }
    emptyFallbackSql += ` ORDER BY dc.id ASC LIMIT $${params.length + 1}`;
    const fallbackRes = await pool.query(emptyFallbackSql, [...params, limit]);
    return fallbackRes.rows.map((r) => ({ ...r, similarity: 1.0 }));
  }

  const scored = res.rows.map((row) => {
    const vec = Array.isArray(row.embedding)
      ? row.embedding
      : typeof row.embedding === "string"
      ? JSON.parse(row.embedding)
      : null;
    const sim = vec ? cosineSimilarity(queryEmbedding, vec) : 0;
    return {
      chunk_index: row.chunk_index,
      content: row.content,
      document_id: row.document_id,
      file_name: row.file_name,
      similarity: sim,
    };
  });

  return selectStratifiedDiverseChunks(scored, limit, query, scope !== "file");
}

module.exports = {
  pool,
  initDb,
  getDbStatus,
  // Folders
  getFolders,
  createFolder,
  deleteFolder,
  getFolderBreadcrumbs,
  // Documents
  getDocuments,
  getDocumentById,
  insertDocument,
  deleteDocument,
  insertChunks,
  // Search
  searchSimilarChunks,
};
