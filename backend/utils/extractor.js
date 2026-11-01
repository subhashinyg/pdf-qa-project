const path = require("path");
const pdfParseModule = require("pdf-parse");
const mammoth = require("mammoth");

/**
 * Extracts raw text and page count from supported document types.
 * Supports: PDF, DOCX, TXT, MD, JSON, CSV.
 * For image formats, returns metadata notice without failing.
 * 
 * @param {object} file - Multer file object
 * @param {Buffer} file.buffer - Binary buffer
 * @param {string} file.originalname - Original filename
 * @param {string} file.mimetype - File MIME type
 * @returns {Promise<{ text: string, totalPages: number, fileType: string }>}
 */
async function extractDocumentContent(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype || "";

  // 1. PDF Documents
  if (ext === ".pdf" || mime === "application/pdf") {
    const pdfData = await extractTextFromPDF(file.buffer);
    return {
      text: pdfData.text,
      totalPages: pdfData.totalPages,
      fileType: "pdf",
    };
  }

  // 2. Word Documents (.docx)
  if (
    ext === ".docx" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      const text = result.value ? result.value.trim() : "";
      return {
        text,
        totalPages: 1,
        fileType: "docx",
      };
    } catch (err) {
      console.warn("Failed to extract DOCX text:", err.message);
      return {
        text: "",
        totalPages: 1,
        fileType: "docx",
      };
    }
  }

  // 3. Plain Text, Markdown, CSV, JSON
  if (
    [".txt", ".md", ".csv", ".json", ".xml", ".log"].includes(ext) ||
    mime.startsWith("text/") ||
    mime === "application/json"
  ) {
    const text = file.buffer.toString("utf-8").trim();
    return {
      text,
      totalPages: 1,
      fileType: ext.replace(".", "") || "text",
    };
  }

  // 4. Image Files
  if (
    [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".bmp"].includes(ext) ||
    mime.startsWith("image/")
  ) {
    return {
      text: `[Image Document: ${file.originalname}]`,
      totalPages: 1,
      fileType: "image",
    };
  }

  // 5. Fallback for other file formats
  return {
    text: "",
    totalPages: 1,
    fileType: ext.replace(".", "") || "unknown",
  };
}

/**
 * Extracts text and page count from a PDF buffer.
 * Supports both pdf-parse v2 (PDFParse class) and v1 (function).
 */
async function extractTextFromPDF(buffer) {
  // Support pdf-parse v2+ (exports class PDFParse)
  if (pdfParseModule.PDFParse) {
    const parser = new pdfParseModule.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return {
        text: result.text || "",
        totalPages: result.total || (result.pages ? result.pages.length : 1),
      };
    } finally {
      if (typeof parser.destroy === "function") {
        await parser.destroy();
      }
    }
  }

  // Support pdf-parse v1 (callable function)
  if (typeof pdfParseModule === "function") {
    const data = await pdfParseModule(buffer);
    return {
      text: data.text || "",
      totalPages: data.numpages || 1,
    };
  }

  // Fallback for default export
  if (pdfParseModule.default && typeof pdfParseModule.default === "function") {
    const data = await pdfParseModule.default(buffer);
    return {
      text: data.text || "",
      totalPages: data.numpages || 1,
    };
  }

  throw new Error("Unsupported pdf-parse module format.");
}

module.exports = {
  extractDocumentContent,
  extractTextFromPDF,
};
