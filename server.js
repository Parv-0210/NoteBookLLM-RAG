import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { JinaEmbeddings } from "@langchain/community/embeddings/jina";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import Groq from "groq-sdk";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage() });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    const loader = new PDFLoader(blob);
    const docs = await loader.load();
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const chunks = await splitter.splitDocuments(docs);
    const embeddings = new JinaEmbeddings({ apiKey: process.env.JINA_API_KEY });
    const vectorStore = await MemoryVectorStore.fromDocuments(chunks, embeddings);
    
    // We'll store the context in a simple global variable for the demo.
    // Note: On Vercel, this is stateless, so we'll pass the context back to the UI
    // and the UI will send it back in the chat request.
    const context = chunks.map(c => c.pageContent).join("\n\n");
    
    res.json({ 
      success: true, 
      documentId: "temp-doc", 
      context: context,
      message: "Document processed!" 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { question, context } = req.body;
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: `Answer based on this context: ${context}` },
        { role: "user", content: question }
      ],
    });
    res.json({ answer: completion.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
export default app;
