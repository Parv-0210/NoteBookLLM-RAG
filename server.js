import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "crypto";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { QdrantClient } from "@qdrant/js-client-rest";
import Groq from "groq-sdk";
import { pipeline } from "@xenova/transformers";
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

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${randomUUID().slice(0, 8)}-${file.originalname}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["application/pdf", "text/plain", "text/markdown"];
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
// Clients
// -------------------------------------------------------------------
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

// Embedding vector size for all-MiniLM-L6-v2
const EMBEDDING_SIZE = 384;

// Lazy-load the local embedding model (downloads once, cached)
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    console.log("   🤖 Loading local embedding model (first run)...");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("   ✅ Embedding model ready");
  }
  return embedder;
}

// -------------------------------------------------------------------
// In-memory document registry
// -------------------------------------------------------------------
const documents = new Map();

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Generate embeddings using local all-MiniLM-L6-v2 model (via @xenova/transformers)
 * Runs fully locally — no API key needed, no quota limits.
 * Vector size: 384 dimensions
 */
async function getEmbedding(text) {
  const embedFn = await getEmbedder();
  const output = await embedFn(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Chunking Strategy — RecursiveCharacterTextSplitter
 * ---------------------------------------------------
 * Splits documents using a hierarchy of separators:
 *   1. \n\n (paragraph boundaries)
 *   2. \n   (line breaks)
 *   3. " "  (word boundaries)
 *   4. ""   (characters — last resort)
 *
 * Parameters:
 *   chunkSize:    1000 chars — precise retrieval with meaningful context
 *   chunkOverlap: 200 chars (20%) — prevents info loss at boundaries
 */
function getTextSplitter() {
  return new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
    separators: ["\n\n", "\n", " ", ""],
  });
}

/**
 * Ensure Qdrant collection exists
 */
async function ensureCollection(collectionName) {
  try {
    await qdrant.getCollection(collectionName);
  } catch {
    await qdrant.createCollection(collectionName, {
      vectors: { size: EMBEDDING_SIZE, distance: "Cosine" },
    });
    console.log(`   📦 Created Qdrant collection: ${collectionName}`);
  }
}

// -------------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------------

/**
 * POST /api/upload
 * Full ingestion pipeline: load → chunk → embed (local) → store (Qdrant)
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

    // Step 1: Load document
    let docs;
    if (req.file.mimetype === "application/pdf") {
      const loader = new PDFLoader(filePath);
      docs = await loader.load();
    } else {
      const text = fs.readFileSync(filePath, "utf-8");
      docs = [{ pageContent: text, metadata: { source: originalName, loc: { pageNumber: 1 } } }];
    }

    console.log(`   📖 Loaded ${docs.length} page(s)`);

    // Step 2: Chunk
    const splitter = getTextSplitter();
    const chunks = await splitter.splitDocuments(docs);
    console.log(`   ✂️  Split into ${chunks.length} chunks`);

    // Step 3: Create Qdrant collection
    await ensureCollection(collectionName);

    // Step 4: Embed each chunk using local model and upsert into Qdrant
    const points = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await getEmbedding(chunk.pageContent);
      points.push({
        id: i,
        vector: embedding,
        payload: {
          text: chunk.pageContent,
          page: chunk.metadata?.loc?.pageNumber || chunk.metadata?.page || 1,
          source: originalName,
        },
      });
    }

    await qdrant.upsert(collectionName, { points });
    console.log(`   ✅ Indexed ${points.length} chunks into Qdrant`);

    // Register document
    const docInfo = {
      id: collectionName,
      name: originalName.replace(/\.[^/.]+$/, ""),
      originalName,
      pages: docs.length,
      chunks: chunks.length,
      createdAt: new Date().toISOString(),
    };
    documents.set(collectionName, docInfo);

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      document: docInfo,
      message: `Successfully processed "${originalName}" — ${chunks.length} chunks indexed.`,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: `Failed to process document: ${error.message}` });
  }
});

/**
 * POST /api/chat
 * Retrieval + grounded generation via Groq LLM
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { question, documentId } = req.body;

    if (!question || !documentId) {
      return res.status(400).json({ error: "Both 'question' and 'documentId' are required." });
    }

    console.log(`\n💬 Question: "${question}"`);

    // Step 1: Embed the question using local model
    const queryEmbedding = await getEmbedding(question);

    // Step 2: Search Qdrant for top-4 similar chunks
    const searchResult = await qdrant.search(documentId, {
      vector: queryEmbedding,
      limit: 4,
      with_payload: true,
    });

    console.log(`   🔍 Retrieved ${searchResult.length} chunks`);

    if (searchResult.length === 0) {
      return res.json({
        answer: "I couldn't find relevant information in the document. Please try rephrasing your question.",
        sources: [],
      });
    }

    // Step 3: Build context
    const contextParts = searchResult.map((hit, i) => {
      return `[Chunk ${i + 1} — Page ${hit.payload.page}]\n${hit.payload.text}`;
    });
    const context = contextParts.join("\n\n---\n\n");

    // Step 4: Generate grounded answer using Groq (llama-3.3-70b — free & fast)
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content: `You are DocuMind, an intelligent document assistant. Answer questions based STRICTLY on the document context below.

RULES:
1. ONLY answer based on the context. Do NOT use your general knowledge.
2. If the context doesn't have enough info, say so clearly.
3. Mention page numbers when referencing information.
4. Be clear and well-structured. Use bullet points when appropriate.
5. Do NOT hallucinate or make up information.

DOCUMENT CONTEXT:
${context}`,
        },
        { role: "user", content: question },
      ],
    });

    const answer = completion.choices[0].message.content;
    const sources = [...new Set(searchResult.map((h) => h.payload.page))].sort((a, b) => a - b);

    console.log(`   ✅ Answer generated (${answer.length} chars)`);

    res.json({ answer, sources, chunksUsed: searchResult.length });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: `Failed to generate answer: ${error.message}` });
  }
});

/**
 * GET /api/documents
 */
app.get("/api/documents", (req, res) => {
  const docList = Array.from(documents.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ documents: docList });
});

/**
 * DELETE /api/documents/:id
 */
app.delete("/api/documents/:id", async (req, res) => {
  const { id } = req.params;
  if (documents.has(id)) {
    documents.delete(id);
    try { await qdrant.deleteCollection(id); } catch (_) {}
    res.json({ success: true });
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
║   Embeddings : all-MiniLM-L6-v2 (local)         ║
║   LLM        : Groq llama-3.3-70b (free)        ║
║   Vector DB  : Qdrant Cloud                      ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
