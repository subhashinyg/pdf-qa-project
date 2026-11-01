require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const db = require("./db");
const { chunkText } = require("./utils/chunker");
const { extractDocumentContent } = require("./utils/extractor");
const ollama = require("./services/ollama");

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure upload directory exists
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Initialize database schema asynchronously on boot
db.initDb();

// Middleware
app.use(cors());
app.use(express.json());

// Configure Multer for in-memory file uploads with 30MB limit per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024, // 30 MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Allow documents and images
    const allowedExtensions = [
      ".pdf",
      ".docx",
      ".doc",
      ".txt",
      ".md",
      ".csv",
      ".json",
      ".xml",
      ".log",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".svg",
      ".gif",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext) || file.mimetype.startsWith("image/") || file.mimetype.startsWith("text/")) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type (${ext}). Supported: PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG, WEBP.`));
    }
  },
});

/* ============================================================
   HEALTH CHECK
   ============================================================ */
app.get("/api/health", async (req, res) => {
  const dbStatus = await db.getDbStatus();
  const ollamaStatus = await ollama.isOllamaAvailable();

  res.json({
    message: "Knowledge Hub File Explorer backend is running!",
    services: {
      database: dbStatus,
      ollama: { available: ollamaStatus },
    },
  });
});

/* ============================================================
   FOLDER MANAGEMENT ENDPOINTS
   ============================================================ */

// List folders (under parent or root) and breadcrumbs
app.get("/api/folders", async (req, res) => {
  try {
    const parentId = req.query.parentId ? parseInt(req.query.parentId, 10) : null;
    const folders = await db.getFolders(parentId);
    const breadcrumbs = parentId ? await db.getFolderBreadcrumbs(parentId) : [];

    res.json({
      success: true,
      folders,
      breadcrumbs,
    });
  } catch (err) {
    console.error("Error fetching folders:", err);
    res.status(500).json({ error: "Failed to fetch folders: " + err.message });
  }
});

// Create a new folder
app.post("/api/folders", async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Folder name is required." });
    }

    const folder = await db.createFolder(
      name.trim(),
      parentId ? parseInt(parentId, 10) : null
    );

    res.status(201).json({
      success: true,
      folder,
    });
  } catch (err) {
    console.error("Error creating folder:", err);
    res.status(500).json({ error: "Failed to create folder: " + err.message });
  }
});

// Delete a folder
app.delete("/api/folders/:id", async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    const deleted = await db.deleteFolder(folderId);

    if (!deleted) {
      return res.status(404).json({ error: "Folder not found." });
    }

    res.json({
      success: true,
      message: "Folder and its contents deleted successfully.",
      folder: deleted,
    });
  } catch (err) {
    console.error("Error deleting folder:", err);
    res.status(500).json({ error: "Failed to delete folder: " + err.message });
  }
});

/* ============================================================
   FILE & DOCUMENT MANAGEMENT ENDPOINTS
   ============================================================ */

// List files (filter by folderId and optional search)
app.get("/api/files", async (req, res) => {
  try {
    const folderId = req.query.folderId !== undefined && req.query.folderId !== "" 
      ? (req.query.folderId === "all" ? "all" : parseInt(req.query.folderId, 10))
      : null;
    const search = req.query.search || "";

    const documents = await db.getDocuments({ folderId, search });

    res.json({
      success: true,
      documents,
    });
  } catch (err) {
    console.error("Error fetching files:", err);
    res.status(500).json({ error: "Failed to fetch files: " + err.message });
  }
});

// Get a single file metadata and content
app.get("/api/files/:id", async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    const document = await db.getDocumentById(fileId);

    if (!document) {
      return res.status(404).json({ error: "File not found." });
    }

    res.json({
      success: true,
      document,
    });
  } catch (err) {
    console.error("Error fetching file details:", err);
    res.status(500).json({ error: "Failed to fetch file details: " + err.message });
  }
});

// View physical file content (inline streaming for PDF, image, text)
app.get("/api/files/:id/content", async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    const document = await db.getDocumentById(fileId);

    if (!document || !document.storage_path) {
      return res.status(404).json({ error: "File not found or has no physical storage." });
    }

    const fullPath = path.isAbsolute(document.storage_path)
      ? document.storage_path
      : path.join(__dirname, document.storage_path);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Stored file not found on disk." });
    }

    if (document.mime_type) {
      res.setHeader("Content-Type", document.mime_type);
    }
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(document.file_name)}"`);

    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    console.error("Error streaming file content:", err);
    res.status(500).json({ error: "Failed to stream file: " + err.message });
  }
});

// Download physical file
app.get("/api/files/:id/download", async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    const document = await db.getDocumentById(fileId);

    if (!document || !document.storage_path) {
      return res.status(404).json({ error: "File not found." });
    }

    const fullPath = path.isAbsolute(document.storage_path)
      ? document.storage_path
      : path.join(__dirname, document.storage_path);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Stored file not found on disk." });
    }

    res.download(fullPath, document.file_name);
  } catch (err) {
    console.error("Error downloading file:", err);
    res.status(500).json({ error: "Failed to download file: " + err.message });
  }
});

// Delete a file
app.delete("/api/files/:id", async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    const document = await db.getDocumentById(fileId);

    if (!document) {
      return res.status(404).json({ error: "File not found." });
    }

    // Delete record from DB
    await db.deleteDocument(fileId);

    // Remove physical file from disk
    if (document.storage_path) {
      const fullPath = path.isAbsolute(document.storage_path)
        ? document.storage_path
        : path.join(__dirname, document.storage_path);
      if (fs.existsSync(fullPath)) {
        fs.unlink(fullPath, () => {});
      }
    }

    res.json({
      success: true,
      message: `File "${document.file_name}" deleted successfully.`,
    });
  } catch (err) {
    console.error("Error deleting file:", err);
    res.status(500).json({ error: "Failed to delete file: " + err.message });
  }
});

/**
 * Common processor for uploaded files
 */
async function processUploadedFile(file, folderId) {
  // 1. Save physical file to uploads directory
  const safeBaseName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
  const uniqueFileName = `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safeBaseName}`;
  const relativeStoragePath = path.join("uploads", uniqueFileName);
  const absoluteStoragePath = path.join(UPLOADS_DIR, uniqueFileName);

  fs.writeFileSync(absoluteStoragePath, file.buffer);

  // 2. Extract content based on file type
  const { text, totalPages, fileType } = await extractDocumentContent(file);

  // 3. Insert document record into DB
  const docRecord = await db.insertDocument({
    fileName: file.originalname,
    fileSize: file.size,
    totalPages,
    folderId,
    fileType,
    mimeType: file.mimetype || "application/octet-stream",
    storagePath: relativeStoragePath,
    extractedText: text,
  });

  // 4. If text was extracted, generate chunks and embeddings
  let chunkCount = 0;
  if (text && text.trim().length > 0) {
    const rawChunks = chunkText(text, { chunkSize: 800, overlap: 150 });
    const ollamaOnline = await ollama.isOllamaAvailable();

    const chunksWithEmbeddings = [];
    for (const chunk of rawChunks) {
      let vector = null;
      if (ollamaOnline) {
        vector = await ollama.generateEmbedding(chunk.content);
      }
      chunksWithEmbeddings.push({
        ...chunk,
        embedding: vector,
      });
    }

    if (chunksWithEmbeddings.length > 0) {
      await db.insertChunks(docRecord.id, chunksWithEmbeddings);
      chunkCount = chunksWithEmbeddings.length;
    }
  }

  return {
    ...docRecord,
    chunk_count: chunkCount,
  };
}

// Upload Multiple Files (supports PDF, DOCX, TXT, Images, etc.)
app.post("/api/upload-files", (req, res) => {
  upload.array("files", 20)(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "A file exceeds the 30MB size limit." });
      }
      return res.status(400).json({ error: err.message || "File upload failed." });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Please select one or more files." });
    }

    const folderId = req.body.folderId ? parseInt(req.body.folderId, 10) : null;
    const processedFiles = [];
    const errors = [];

    for (const file of req.files) {
      try {
        const doc = await processUploadedFile(file, folderId);
        processedFiles.push(doc);
      } catch (fileErr) {
        console.error(`Error processing file ${file.originalname}:`, fileErr);
        errors.push({ fileName: file.originalname, error: fileErr.message });
      }
    }

    res.json({
      success: true,
      count: processedFiles.length,
      files: processedFiles,
      errors: errors.length > 0 ? errors : undefined,
    });
  });
});

// Backward-compatible single PDF upload endpoint
app.post("/api/upload-pdf", (req, res) => {
  upload.single("pdf")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || "Upload failed." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file provided." });
    }

    try {
      const folderId = req.body.folderId ? parseInt(req.body.folderId, 10) : null;
      const doc = await processUploadedFile(req.file, folderId);

      res.json({
        success: true,
        documentId: doc.id,
        storedInDb: true,
        fileName: doc.file_name,
        fileSize: doc.file_size,
        totalPages: doc.total_pages,
        totalChunks: doc.chunk_count,
        text: doc.extracted_text,
      });
    } catch (parseErr) {
      console.error("PDF upload error:", parseErr);
      res.status(500).json({ error: "Failed to process PDF: " + parseErr.message });
    }
  });
});

/* ============================================================
   AI Q&A ENDPOINT (RAG ACROSS FILE, FOLDER, OR ALL DOCS)
   ============================================================ */
app.post("/api/ask-question", async (req, res) => {
  const { question, documentId, folderId, scope = "all", text } = req.body;

  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Please provide a valid question." });
  }

  const trimmedQuestion = question.trim();

  // Detect cross-document comparison or synthesis keywords
  const multiDocIntentRegex =
    /\b(both|all|across|compare|comparison|differ|difference|between|versus|vs|other\s+doc|another\s+file|each\s+pdf|two\s+files|3\s+files|multiple\s+docs|second\s+file|first\s+file)\b/i;

  let effectiveScope = scope;
  let scopeAutoExpanded = false;

  // Auto-expand scope if user question explicitly asks across documents/comparison
  if (scope === "file" && multiDocIntentRegex.test(trimmedQuestion)) {
    effectiveScope = folderId ? "folder" : "all";
    scopeAutoExpanded = true;
    console.log(
      `[AI Q&A] Detected multi-document question intent ("${trimmedQuestion}"). Auto-expanding scope from 'file' to '${effectiveScope}'.`
    );
  }

  try {
    const dbStatus = await db.getDbStatus();
    let context = "";
    let sourceChunks = [];

    if (dbStatus.connected) {
      // 1. Generate embedding for user question
      const queryEmbedding = await ollama.generateEmbedding(trimmedQuestion);

      // 2. Perform scoped semantic search with stratified multi-document selection
      const chunkLimit = effectiveScope === "file" ? 6 : 9;

      sourceChunks = await db.searchSimilarChunks({
        queryEmbedding,
        query: trimmedQuestion,
        limit: chunkLimit,
        documentId: effectiveScope === "file" && documentId ? parseInt(documentId, 10) : null,
        folderId: effectiveScope === "folder" && folderId ? parseInt(folderId, 10) : null,
        scope: effectiveScope, // 'file' | 'folder' | 'all'
      });

      // If single-file search returned 0 results or low relevance, auto-fallback to all docs
      if (sourceChunks.length === 0 && effectiveScope === "file") {
        console.log(`[AI Q&A] 0 chunks in single-file scope. Falling back to all documents.`);
        sourceChunks = await db.searchSimilarChunks({
          queryEmbedding,
          query: trimmedQuestion,
          limit: 9,
          scope: "all",
        });
        if (sourceChunks.length > 0) {
          effectiveScope = "all";
          scopeAutoExpanded = true;
        }
      }

      // 3. Format context with source document attribution
      context = sourceChunks
        .map(
          (c) =>
            `[Source: "${c.file_name}" (Chunk #${(c.chunk_index !== undefined ? c.chunk_index : 0) + 1})]\n${c.content}`
        )
        .join("\n\n---\n\n");
    } else if (text) {
      // Fallback if DB is disconnected
      const chunks = chunkText(text, { chunkSize: 900, overlap: 100 });
      sourceChunks = chunks.slice(0, 6).map((c) => ({
        chunk_index: c.chunkIndex,
        content: c.content,
        file_name: "Uploaded Document",
        similarity: 1.0,
      }));
      context = sourceChunks.map((c) => c.content).join("\n\n");
    }

    if (!context.trim()) {
      return res.status(404).json({
        error: "No relevant documents or text chunks found for the selected scope.",
      });
    }

    // 4. Generate grounded answer with Ollama (llama3.2)
    const answer = await ollama.answerQuestion({
      question: trimmedQuestion,
      context,
    });

    res.json({
      success: true,
      answer,
      scope: effectiveScope,
      originalScope: scope,
      scopeAutoExpanded,
      sourceChunks: sourceChunks.map((c) => ({
        chunkIndex: c.chunk_index !== undefined ? c.chunk_index : c.chunkIndex,
        content: c.content,
        fileName: c.file_name,
        similarity: c.similarity,
      })),
    });
  } catch (err) {
    console.error("Q&A generation error:", err);
    res.status(500).json({
      error: `Failed to generate answer: ${err.message}`,
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Knowledge Hub Backend running at http://localhost:${PORT}`);
});
