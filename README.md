# 📚 DocuMind — RAG-Powered Document Q&A

> **Your own NotebookLM** — Upload any document and have an intelligent conversation with it.

DocuMind is a full-stack RAG (Retrieval-Augmented Generation) application that lets you upload PDF or text documents and ask natural language questions. Every answer is grounded in your document's actual content — not the LLM's general knowledge.

![DocuMind](https://img.shields.io/badge/RAG-Pipeline-818cf8?style=for-the-badge) ![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js) ![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4.1--mini-412991?style=for-the-badge&logo=openai) ![Qdrant](https://img.shields.io/badge/Qdrant-Vector_DB-dc244c?style=for-the-badge)

---

## 🏗️ Architecture

```
User Browser ──► Express Server ──► PDF/Text Parser
                      │
                      ├──► RecursiveCharacterTextSplitter (Chunking)
                      │
                      ├──► OpenAI text-embedding-3-large (Embeddings)
                      │
                      ├──► Qdrant Cloud (Vector Storage)
                      │
                      ├──► Similarity Search (Retrieval)
                      │
                      └──► OpenAI GPT-4.1-mini (Grounded Answer)
                              │
                              ▼
                         User receives answer
                         with page citations
```

### Full RAG Pipeline

| Step | Technology | Description |
|------|-----------|-------------|
| **Ingestion** | Multer + LangChain PDFLoader | Accepts PDF and plain text uploads (up to 20 MB) |
| **Chunking** | RecursiveCharacterTextSplitter | Splits documents into 1000-char chunks with 200-char overlap |
| **Embedding** | OpenAI `text-embedding-3-large` | Generates 3072-dimensional embeddings for each chunk |
| **Storage** | Qdrant Cloud | Stores vectors with metadata (source file, page number) |
| **Retrieval** | Qdrant Similarity Search | Finds top-4 most relevant chunks via cosine similarity |
| **Generation** | OpenAI `gpt-4.1-mini` | Generates answers strictly from retrieved context |

---

## ✂️ Chunking Strategy — RecursiveCharacterTextSplitter

The chunking strategy is a critical component of any RAG pipeline. DocuMind uses **RecursiveCharacterTextSplitter**, the recommended general-purpose splitter from LangChain.

### How It Works

The splitter uses a hierarchy of separators to keep semantically related content together:

1. **`\n\n`** — Split at paragraph boundaries first (strongest semantic boundary)
2. **`\n`** — Fall back to line breaks
3. **`" "`** — Fall back to word boundaries
4. **`""`** — Last resort: character-by-character

### Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `chunkSize` | 1000 chars | Balances granularity with context. Small enough for precise retrieval, large enough for meaningful passages |
| `chunkOverlap` | 200 chars (20%) | Preserves context at chunk boundaries. Prevents information loss when sentences span two chunks |

### Why This Strategy?

- **Preserves meaning**: Unlike naive character splitting, recursive splitting respects paragraph and sentence boundaries
- **Metadata preserved**: Each chunk retains its source file and page number for citations
- **Configurable overlap**: Ensures that a sentence split across two chunks appears fully in at least one of them

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ installed
- OpenAI API key (for embeddings & LLM)
- Qdrant Cloud account (free tier — no credit card needed)

### Setup

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd documind-rag

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env with your API keys

# 4. Start the server
npm start
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | OpenAI API key for embeddings and generation |
| `QDRANT_URL` | ✅ | Qdrant Cloud cluster URL |
| `QDRANT_API_KEY` | ✅ | Qdrant Cloud API key |
| `PORT` | ❌ | Server port (default: 3000) |

### Setting Up Qdrant Cloud (Free)

1. Go to [cloud.qdrant.io](https://cloud.qdrant.io)
2. Sign up with GitHub or Google
3. Create a **Free** tier cluster
4. Copy your **Cluster URL** and **API Key**
5. Add them to your `.env` file

---

## 📡 API Reference

### `POST /api/upload`
Upload and process a document.

**Request:** `multipart/form-data` with field `document` (PDF or TXT file)

**Response:**
```json
{
  "success": true,
  "document": {
    "id": "doc-abc123",
    "name": "my-document",
    "pages": 15,
    "chunks": 47,
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  "message": "Successfully processed \"my-document.pdf\" — 47 chunks indexed."
}
```

### `POST /api/chat`
Ask a question about an uploaded document.

**Request:**
```json
{
  "question": "What are the main topics covered?",
  "documentId": "doc-abc123"
}
```

**Response:**
```json
{
  "answer": "Based on the document, the main topics covered are...",
  "sources": [1, 3, 7],
  "chunksUsed": 4
}
```

### `GET /api/documents`
List all uploaded documents.

### `DELETE /api/documents/:id`
Remove a document from the registry.

---

## 🎨 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | HTML, CSS (dark glassmorphism theme), Vanilla JS |
| **Backend** | Node.js, Express |
| **LLM** | OpenAI GPT-4.1-mini |
| **Embeddings** | OpenAI text-embedding-3-large |
| **Vector DB** | Qdrant Cloud |
| **Chunking** | LangChain RecursiveCharacterTextSplitter |
| **File Parsing** | LangChain PDFLoader |
| **Deployment** | Render |

---

## 📂 Project Structure

```
├── server.js              # Express backend + full RAG pipeline
├── package.json           # Dependencies and scripts
├── .env.example           # Environment variable template
├── .gitignore             # Git ignore rules
├── render.yaml            # Render deployment config
├── README.md              # This file
└── public/                # Frontend (served statically)
    ├── index.html         # Main HTML layout
    ├── style.css          # Premium dark theme styles
    └── script.js          # Client-side application logic
```

---

## 📝 License

MIT
