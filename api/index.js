import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse/lib/pdf-parse.js");
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import Groq from "groq-sdk";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let documents = [];

app.get("/api/documents", (req, res) => {
  res.json({ documents: documents });
});

app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    let extractedText = "";
    if (req.file.mimetype === "application/pdf") {
      const data = await pdf(req.file.buffer);
      extractedText = data.text;
    } else {
      extractedText = req.file.buffer.toString("utf-8");
    }

    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const chunks = await splitter.splitText(extractedText);

    const context = chunks.join("\n\n");

    const docId = `doc-${Date.now()}`;
    const newDoc = {
      id: docId,
      name: req.file.originalname.replace(/\.[^/.]+$/, ""),
      originalName: req.file.originalname,
      pages: 1,
      chunks: chunks.length,
      createdAt: new Date().toISOString(),
      context: context
    };

    documents.push(newDoc);

    res.json({
      success: true,
      document: newDoc,
      context: context,
      message: "Document processed successfully!"
    });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { question, context } = req.body;
    if (!context) return res.status(400).json({ error: "No context provided. Please upload a document first." });

    // Corrective RAG (CRAG) Implementation
    // Step 1: Retrieval Evaluator - Assess if context is relevant
    const evalPrompt = `You are a grader assessing relevance of a retrieved document to a user question.
    Here is the retrieved document:
    ${context.slice(0, 30000)}
    
    Here is the user question: ${question}
    
    If the document contains keyword(s) or semantic meaning related to the user question, grade it as relevant.
    Give a binary score 'yes' or 'no' score to indicate whether the document is relevant to the question.
    Provide only the 'yes' or 'no' without any explanation.`;

    const evalCompletion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: evalPrompt }],
      temperature: 0,
    });

    const isRelevant = evalCompletion.choices[0].message.content.trim().toLowerCase().includes("yes");

    let finalAnswer = "";

    if (isRelevant) {
      // Step 2a: Context is relevant, generate answer from it
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { 
            role: "system", 
            content: `You are Notebook RAG Pro. Answer the user's question based STRICTLY on the provided context. If the answer is not in the context, say you don't know.
            
            CONTEXT:
            ${context.slice(0, 30000)}` 
          },
          { role: "user", content: question }
        ],
      });
      finalAnswer = completion.choices[0].message.content;
    } else {
      // Step 2b: Context is irrelevant, fallback to general knowledge (CRAG Knowledge Refinement / Web Search proxy)
      const fallbackCompletion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { 
            role: "system", 
            content: `You are a helpful AI assistant. The user asked a question about a document, but the provided document does NOT contain the answer.
            You should politely inform the user that the document doesn't contain the answer, but still try to provide a helpful answer based on your general knowledge.` 
          },
          { role: "user", content: question }
        ],
      });
      finalAnswer = fallbackCompletion.choices[0].message.content;
    }

    res.json({ answer: finalAnswer, crag_relevance: isRelevant ? 'yes' : 'no' });
  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/documents/:id", (req, res) => {
  documents = documents.filter(d => d.id !== req.params.id);
  res.json({ success: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
export default app;
