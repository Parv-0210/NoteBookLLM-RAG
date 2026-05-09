import express from "express";
import multer from "multer";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { JinaEmbeddings } from "@langchain/community/embeddings/jina";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { ChatGroq } from "@langchain/groq";

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Single stateless endpoint for Vercel Free Tier
// Accepts the file AND the question at the same time to avoid state issues.
app.post("/api/ask", upload.single("file"), async (req, res) => {
  try {
    const question = req.body.question;
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    if (!question) return res.status(400).json({ error: "No question provided" });

    // 1. Convert memory buffer to Blob for LangChain PDFLoader
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    const loader = new PDFLoader(blob);
    const rawDocs = await loader.load();

    // 2. Chunking strategy
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const chunks = await splitter.splitDocuments(rawDocs);

    // 3. Embeddings via Jina
    const embeddings = new JinaEmbeddings({
      apiKey: process.env.JINA_API_KEY,
      model: "jina-embeddings-v2-base-en",
    });

    // 4. Store in MemoryVectorStore (stateless, deleted after request)
    const vectorStore = await MemoryVectorStore.fromDocuments(chunks, embeddings);

    // 5. Retrieval
    const retriever = vectorStore.asRetriever({ k: 4 });
    const retrievedChunks = await retriever.invoke(question);

    const context = retrievedChunks
      .map((chunk, i) => `[Chunk ${i + 1}]\n${chunk.pageContent}`)
      .join("\n\n---\n\n");

    // 6. LLM Generation via Groq
    const SYSTEM_PROMPT = `You are a strict Document AI Assistant similar to Google NotebookLM.
Your role is to answer the user's query based EXCLUSIVELY on the provided context.

RULES:
1. ONLY answer using the provided context. Do NOT use your general knowledge.
2. If the answer is not in the context, clearly state: "I couldn't find information about that in the uploaded document."

DOCUMENT CONTEXT:
${context}`;

    const model = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: "llama3-70b-8192",
      temperature: 0.1,
    });

    const response = await model.invoke([
      ["system", SYSTEM_PROMPT],
      ["human", question],
    ]);

    res.json({ answer: response.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

export default app;
