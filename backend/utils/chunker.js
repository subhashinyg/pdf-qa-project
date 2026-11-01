/**
 * Chunker utility for splitting text into overlapping chunks for vector search / RAG.
 */

/**
 * Splits extracted text into semantic chunks with overlap.
 * 
 * @param {string} text - Raw text extracted from PDF
 * @param {object} options - Chunking configuration options
 * @param {number} options.chunkSize - Target maximum chunk size in characters (default: 800)
 * @param {number} options.overlap - Character overlap between consecutive chunks (default: 150)
 * @returns {Array<{ chunkIndex: number, content: string, characterCount: number }>}
 */
function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize || 800;
  const overlap = options.overlap || 150;

  if (!text || typeof text !== "string") {
    return [];
  }

  // Normalize newlines and multiple spaces
  const cleanedText = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleanedText.length <= chunkSize) {
    return [
      {
        chunkIndex: 0,
        content: cleanedText,
        characterCount: cleanedText.length,
      },
    ];
  }

  const chunks = [];
  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < cleanedText.length) {
    let endIndex = startIndex + chunkSize;

    // If not at the very end of the text, look for a natural break point
    if (endIndex < cleanedText.length) {
      // Look for natural delimiters near the end of the chunk
      const searchWindowStart = Math.max(startIndex, endIndex - 120);
      const window = cleanedText.slice(searchWindowStart, endIndex);

      // Preferred delimiters in order of priority: paragraph, sentence, punctuation, space
      const paragraphBreak = window.lastIndexOf("\n\n");
      const sentenceBreak = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! ")
      );
      const lineBreak = window.lastIndexOf("\n");
      const spaceBreak = window.lastIndexOf(" ");

      if (paragraphBreak !== -1) {
        endIndex = searchWindowStart + paragraphBreak + 2;
      } else if (sentenceBreak !== -1) {
        endIndex = searchWindowStart + sentenceBreak + 2;
      } else if (lineBreak !== -1) {
        endIndex = searchWindowStart + lineBreak + 1;
      } else if (spaceBreak !== -1) {
        endIndex = searchWindowStart + spaceBreak + 1;
      }
    } else {
      endIndex = cleanedText.length;
    }

    const chunkContent = cleanedText.slice(startIndex, endIndex).trim();

    if (chunkContent.length > 0) {
      chunks.push({
        chunkIndex,
        content: chunkContent,
        characterCount: chunkContent.length,
      });
      chunkIndex++;
    }

    // Move start index forward, retaining overlap
    if (endIndex >= cleanedText.length) {
      break;
    }

    const nextStartIndex = endIndex - overlap;
    // Guard against infinite loop
    startIndex = nextStartIndex > startIndex ? nextStartIndex : endIndex;
  }

  return chunks;
}

module.exports = {
  chunkText,
};
