import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "crypto";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { OpenAI } from "openai"; // Keep for type or utility if needed, but we'll use Gemini
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${randomUUID().slice(0, 8)}-${file.originalname}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "text/plain",
      "text/markdown",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and plain text files are supported."));
    }
  },
});

// -------------------------------------------------------------------
// Middleware
// -------------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -------------------------------------------------------------------
// In-memory document registry
// -------------------------------------------------------------------
const documents = new Map(); // collectionName -> { id, name, originalName, pages, chunks, createdAt }

// -------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------

/**
 * Create OpenAI Embeddings instance (reusable)
 */
function getEmbeddings() {
  return new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GOOGLE_API_KEY,
    modelName: "embedding-001", // Standard Gemini embedding model
  });
}

/**
 * Chunking Strategy — RecursiveCharacterTextSplitter
 * ---------------------------------------------------
 * This is the recommended general-purpose chunking strategy for RAG.
 *
 * HOW IT WORKS:
 * 1. It attempts to split text using a hierarchy of separators:
 *    - First by double newlines (\n\n) — paragraph boundaries
 *    - Then by single newlines (\n) — line breaks
 *    - Then by spaces (" ") — word boundaries
 *    - Finally by characters ("") — as a last resort
 * 2. It tries to keep chunks as close to `chunkSize` as possible
 *    while respecting the separator hierarchy.
 * 3. `chunkOverlap` ensures that context near chunk boundaries
 *    is preserved in adjacent chunks, preventing information loss.
 *
 * WHY THESE PARAMETERS:
 * - chunkSize: 1000 — balances granularity with context. Small enough
 *   for precise retrieval, large enough to contain meaningful passages.
 * - chunkOverlap: 200 (20%) — ensures boundary context is preserved.
 *   Critical for sentences that span chunk boundaries.
 */
function getTextSplitter() {
  return new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
    separators: ["\n\n", "\n", " ", ""],
  });
}

/**
 * Get Qdrant connection config
 */
function getQdrantConfig(collectionName) {
  const config = {
    collectionName,
  };

  // Support both local Qdrant and Qdrant Cloud
  if (process.env.QDRANT_URL) {
    config.url = process.env.QDRANT_URL;
  } else {
    config.url = "http://localhost:6333";
  }

  if (process.env.QDRANT_API_KEY) {
    config.apiKey = process.env.QDRANT_API_KEY;
  }

  return config;
}

// -------------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------------

/**
 * POST /api/upload
 * ----------------
 * Handles document upload and the full ingestion pipeline:
 * 1. Receive file (PDF or TXT)
 * 2. Load & parse content
 * 3. Chunk using RecursiveCharacterTextSplitter
 * 4. Generate embeddings via OpenAI
 * 5. Store in Qdrant vector database
 */
app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const collectionName = `doc-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    console.log(`\n📄 Processing: ${originalName}`);
    console.log(`   Collection: ${collectionName}`);

    // Step 1: Load the document
    let docs;
    if (req.file.mimetype === "application/pdf") {
      const loader = new PDFLoader(filePath);
      docs = await loader.load();
    } else {
      // Plain text or markdown
      const text = fs.readFileSync(filePath, "utf-8");
      docs = [
        {
          pageContent: text,
          metadata: { source: originalName, loc: { pageNumber: 1 } },
        },
      ];
    }

    console.log(`   📖 Loaded ${docs.length} page(s)`);

    // Step 2: Chunk the documents
    const splitter = getTextSplitter();
    const chunks = await splitter.splitDocuments(docs);

    console.log(`   ✂️  Split into ${chunks.length} chunks`);
    console.log(
      `   📏 Chunk sizes: min=${Math.min(...chunks.map((c) => c.pageContent.length))}, max=${Math.max(...chunks.map((c) => c.pageContent.length))}, avg=${Math.round(chunks.map((c) => c.pageContent.length).reduce((a, b) => a + b, 0) / chunks.length)}`
    );

    // Step 3 & 4: Embed and store in Qdrant
    const embeddings = getEmbeddings();
    const qdrantConfig = getQdrantConfig(collectionName);

    await QdrantVectorStore.fromDocuments(chunks, embeddings, qdrantConfig);

    console.log(`   ✅ Indexed into Qdrant`);

    // Step 5: Register the document
    const docInfo = {
      id: collectionName,
      name: originalName.replace(/\.[^/.]+$/, ""), // Remove extension
      originalName,
      pages: docs.length,
      chunks: chunks.length,
      createdAt: new Date().toISOString(),
    };
    documents.set(collectionName, docInfo);

    // Cleanup uploaded file
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      document: docInfo,
      message: `Successfully processed "${originalName}" — ${chunks.length} chunks indexed.`,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({
      error: `Failed to process document: ${error.message}`,
    });
  }
});

/**
 * POST /api/chat
 * ---------------
 * Handles user queries against an uploaded document:
 * 1. Receive question + document collection ID
 * 2. Retrieve top-k relevant chunks from Qdrant
 * 3. Build a prompt with retrieved context
 * 4. Generate grounded answer via OpenAI LLM
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { question, documentId } = req.body;

    if (!question || !documentId) {
      return res.status(400).json({
        error: "Both 'question' and 'documentId' are required.",
      });
    }

    console.log(`\n💬 Question: "${question}"`);
    console.log(`   Document: ${documentId}`);

    // Step 1: Connect to existing Qdrant collection
    const embeddings = getEmbeddings();
    const qdrantConfig = getQdrantConfig(documentId);

    const vectorStore = await QdrantVectorStore.fromExistingCollection(
      embeddings,
      qdrantConfig
    );

    // Step 2: Retrieve top-k relevant chunks
    const retriever = vectorStore.asRetriever({ k: 4 });
    const retrievedChunks = await retriever.invoke(question);

    console.log(`   🔍 Retrieved ${retrievedChunks.length} chunks`);

    if (retrievedChunks.length === 0) {
      return res.json({
        answer:
          "I couldn't find any relevant information in the document to answer your question. Please try rephrasing or asking something else about the document.",
        sources: [],
      });
    }

    // Step 3: Build context string with page numbers
    const contextParts = retrievedChunks.map((chunk, i) => {
      const pageNum =
        chunk.metadata?.loc?.pageNumber ||
        chunk.metadata?.page ||
        "unknown";
      return `[Chunk ${i + 1} — Page ${pageNum}]\n${chunk.pageContent}`;
    });

    const context = contextParts.join("\n\n---\n\n");

    // Step 4: Generate grounded answer via Gemini
    const model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
      modelName: "gemini-2.0-flash",
      temperature: 0.3,
    });

    const systemPrompt = `You are DocuMind, an intelligent document assistant. Your purpose is to answer user questions based STRICTLY on the provided document context.

RULES:
1. ONLY answer based on the context provided below. Do NOT use your own knowledge.
2. If the context does not contain enough information to answer the question, say so clearly.
3. When referencing information, mention the page number(s) where it was found.
4. Provide clear, well-structured answers. Use bullet points or numbered lists when appropriate.
5. If you quote directly from the document, use quotation marks.
6. Do NOT make up or hallucinate information that is not in the context.

DOCUMENT CONTEXT:
${context}`;

    const response = await model.invoke([
      ["system", systemPrompt],
      ["human", question],
    ]);

    const answer = response.content;

    // Extract source page numbers
    const sources = [
      ...new Set(
        retrievedChunks
          .map(
            (c) =>
              c.metadata?.loc?.pageNumber || c.metadata?.page || null
          )
          .filter(Boolean)
      ),
    ].sort((a, b) => a - b);

    console.log(`   ✅ Answer generated (${answer.length} chars)`);

    res.json({
      answer,
      sources,
      chunksUsed: retrievedChunks.length,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({
      error: `Failed to generate answer: ${error.message}`,
    });
  }
});

/**
 * GET /api/documents
 * -------------------
 * Returns the list of uploaded and processed documents.
 */
app.get("/api/documents", (req, res) => {
  const docList = Array.from(documents.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ documents: docList });
});

/**
 * DELETE /api/documents/:id
 * --------------------------
 * Remove a document from the registry.
 */
app.delete("/api/documents/:id", (req, res) => {
  const { id } = req.params;
  if (documents.has(id)) {
    documents.delete(id);
    res.json({ success: true, message: "Document removed." });
  } else {
    res.status(404).json({ error: "Document not found." });
  }
});

// -------------------------------------------------------------------
// Start Server
// -------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║   📚 DocuMind RAG Server                         ║
║   ─────────────────────────                      ║
║   Running on: http://localhost:${PORT}              ║
║                                                  ║
║   Endpoints:                                     ║
║     POST /api/upload     — Upload a document     ║
║     POST /api/chat       — Ask a question        ║
║     GET  /api/documents  — List documents        ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
