import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "crypto";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/hf_transformers";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
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
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const embeddings = new HuggingFaceTransformersEmbeddings({
  modelName: "Xenova/all-MiniLM-L6-v2",
});
const documents = new Map();
function getTextSplitter() {
  return new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
    separators: ["\n\n", "\n", " ", ""],
  });
}
app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }
    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const documentId = `doc-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    console.log(`\n📄 Processing: ${originalName}`);
    let docs;
    if (req.file.mimetype === "application/pdf") {
      const loader = new PDFLoader(filePath);
      docs = await loader.load();
    } else {
      const text = fs.readFileSync(filePath, "utf-8");
      docs = [{ pageContent: text, metadata: { source: originalName, loc: { pageNumber: 1 } } }];
    }
    const splitter = getTextSplitter();
    const chunks = await splitter.splitDocuments(docs);
    console.log(`   ✂️  Split into ${chunks.length} chunks`);
    console.log(`   💾 Generating Embeddings & indexing...`);
    const vectorStore = await MemoryVectorStore.fromDocuments(chunks, embeddings);
    const docInfo = {
      id: documentId,
      name: originalName.replace(/\.[^/.]+$/, ""),
      originalName,
      pages: docs.length,
      chunks: chunks.length,
      createdAt: new Date().toISOString(),
    };
    documents.set(documentId, { info: docInfo, vectorStore });
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
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
app.post("/api/chat", async (req, res) => {
  try {
    const { question, documentId } = req.body;
    if (!question || !documentId) {
      return res.status(400).json({ error: "Both 'question' and 'documentId' are required." });
    }
    const docEntry = documents.get(documentId);
    if (!docEntry) {
      return res.status(404).json({ error: "Document not found." });
    }
    console.log(`\n💬 Question: "${question}"`);
    const searchResult = await docEntry.vectorStore.similaritySearch(question, 4);
    console.log(`   🔍 Retrieved ${searchResult.length} chunks`);
    if (searchResult.length === 0) {
      return res.json({
        answer: "I couldn't find relevant information in the document.",
        sources: [],
      });
    }
    const context = searchResult.map((doc, i) => {
      return `[Chunk ${i + 1} — Page ${doc.metadata?.loc?.pageNumber || 1}]\n${doc.pageContent}`;
    }).join("\n\n---\n\n");
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `You are Notebook Pro, an intelligent assistant. Answer questions STRICTLY based on the context.
RULES:
1. ONLY use the provided context. 
2. Cite page numbers.
3. Be concise and accurate.
CONTEXT:
${context}`,
        },
        { role: "user", content: question },
      ],
    });
    const answer = completion.choices[0].message.content;
    const sources = [...new Set(searchResult.map((h) => h.metadata?.loc?.pageNumber || 1))].sort();
    res.json({ answer, sources });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: `Failed to generate answer: ${error.message}` });
  }
});
app.get("/api/documents", (req, res) => {
  const docList = Array.from(documents.values()).map(d => d.info).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ documents: docList });
});
app.delete("/api/documents/:id", (req, res) => {
  const { id } = req.params;
  if (documents.has(id)) {
    documents.delete(id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Document not found." });
  }
});
app.listen(PORT, () => {
  console.log(`🚀 Notebook RAG Pro running on http://localhost:${PORT}`);
});
