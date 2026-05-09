import "dotenv/config";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/hf_transformers";
import { QdrantVectorStore } from "@langchain/qdrant";
import { ChatGroq } from "@langchain/groq";

const filePath = "./node-js.pdf";
const COLLECTION_NAME = "GEN-AI-RAG-CLASS";

/**
 * PHASE 1: INGESTION & INDEXING
 */
async function indexDocument() {
  console.log("📄 Loading PDF Document...");
  const loader = new PDFLoader(filePath);
  const rawDocs = await loader.load();

  console.log("🔪 Chunking Document...");
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const chunks = await splitter.splitDocuments(rawDocs);
  console.log(`✅ Split into ${chunks.length} chunks.`);

  console.log("💾 Generating Embeddings (Running Locally, no API key needed)...");
  const embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2",
  });

  console.log("📦 Storing in Qdrant Vector Database...");
  const vectorStore = await QdrantVectorStore.fromDocuments(chunks, embeddings, {
    url: process.env.QDRANT_URL || "http://localhost:6333",
    collectionName: COLLECTION_NAME,
  });
  
  console.log("🎉 Indexing Completed!");
  return vectorStore;
}

/**
 * PHASE 2: RETRIEVAL & GENERATION
 * This function takes a user query, finds the most relevant chunks from
 * our Vector DB, and uses Groq to generate an answer grounded ONLY in the context.
 */
async function retrieveAndAnswer(userQuery, vectorStoreParams = null) {
  console.log(`\n💬 User Query: "${userQuery}"`);
  console.log("🔍 Retrieving relevant context from Vector DB...");

  let vectorStore = vectorStoreParams;
  if (!vectorStore) {
    const embeddings = new HuggingFaceTransformersEmbeddings({
      modelName: "Xenova/all-MiniLM-L6-v2",
    });
    vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
      url: process.env.QDRANT_URL || "http://localhost:6333",
      collectionName: COLLECTION_NAME,
    });
  }

  // Retrieve top 4 most relevant chunks
  const retriever = vectorStore.asRetriever({ k: 4 });
  const retrievedChunks = await retriever.invoke(userQuery);
  
  // Format the chunks so the LLM can read them easily
  const context = retrievedChunks
    .map((chunk, i) => `[Chunk ${i + 1} | Page ${chunk.metadata.loc?.pageNumber || "N/A"}]\n${chunk.pageContent}`)
    .join("\n\n---\n\n");

  console.log("🤖 Generating grounded answer via Groq LLM...\n");

  const SYSTEM_PROMPT = `You are a strict Document AI Assistant similar to Google NotebookLM.
Your role is to answer the user's query based EXCLUSIVELY on the provided context.

RULES:
1. ONLY answer using the provided context. Do NOT use your general knowledge.
2. If the answer is not in the context, clearly state: "I couldn't find information about that in the uploaded document."
3. Cite your sources by referencing the Page number provided in the context blocks.

DOCUMENT CONTEXT:
${context}`;

  // Initialize Groq Chat Model
  const model = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: "llama3-70b-8192", // Fast and powerful model from Groq
    temperature: 0.1,
  });

  const response = await model.invoke([
    ["system", SYSTEM_PROMPT],
    ["human", userQuery],
  ]);

  console.log("==================== ANSWER ====================");
  console.log(response.content);
  console.log("================================================\n");
}

async function main() {
  try {
    // 1. Index the document into the Vector Store
    const vectorStore = await indexDocument();
    
    // 2. Query it
    await retrieveAndAnswer("Explain me how to do debugging in node js and also provide me some examples", vectorStore);
  } catch (error) {
    console.error("❌ Error running RAG pipeline:", error.message);
  }
}

main();
