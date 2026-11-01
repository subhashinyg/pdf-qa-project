const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "llama3.2";

/**
 * Checks if the Ollama service is reachable.
 * @returns {Promise<boolean>}
 */
async function isOllamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Generates a 768-dimensional vector embedding for a given text snippet.
 * @param {string} text
 * @returns {Promise<number[] | null>}
 */
async function generateEmbedding(text) {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBED_MODEL,
        prompt: text,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.warn(`Ollama embedding error: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.embedding || null;
  } catch (err) {
    console.warn(`Failed to generate embedding with Ollama: ${err.message}`);
    return null;
  }
}

/**
 * Generates embeddings for an array of chunks in sequence or small batches.
 * @param {string[]} texts
 * @returns {Promise<Array<number[] | null>>}
 */
async function generateBatchEmbeddings(texts) {
  const embeddings = [];
  for (const text of texts) {
    const vector = await generateEmbedding(text);
    embeddings.push(vector);
  }
  return embeddings;
}

/**
 * Generates an answer from llama3.2 using grounded context.
 * @param {object} options
 * @param {string} options.question
 * @param {string} options.context
 * @returns {Promise<string>}
 */
async function answerQuestion({ question, context }) {
  const systemPrompt = `You are an expert AI document analyst assistant. You answer questions strictly and accurately based on the provided document excerpts.
Each excerpt is clearly labeled with its source document name: [Source: "filename.pdf" (Chunk #...)].

Instructions:
1. Multi-Document Synthesis: If the user question relates to multiple documents, asks to compare, contrast, or summarize across documents, review ALL provided excerpts and synthesize a thorough, well-organized response.
2. Direct Document Attribution: Explicitly state which document each piece of information comes from (for example: "According to [resume.pdf]... whereas [whitepaper.pdf] discusses...").
3. Handling Differences: If an aspect is covered in one document but absent in another, state clearly what was found and what was not mentioned, instead of refusing to answer.
4. Single-Document / Factual Questions: If the question focuses on a single fact or file, provide a direct, concise, and accurate answer based on the relevant excerpt.
5. Strict Grounding: Do not invent or assume facts not supported by the context. Only say "I cannot find the answer in the provided documents" if NONE of the provided excerpts contain relevant information.`;

  const userPrompt = `Context from uploaded documents:
-------------------------
${context}
-------------------------

Question: ${question}

Answer based on the context above:`;

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      prompt: userPrompt,
      system: systemPrompt,
      stream: false,
      options: {
        temperature: 0.2, // Low temperature for factual fidelity
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama LLM generation error (status ${response.status})`);
  }

  const data = await response.json();
  return data.response ? data.response.trim() : "No response generated.";
}

module.exports = {
  isOllamaAvailable,
  generateEmbedding,
  generateBatchEmbeddings,
  answerQuestion,
};
