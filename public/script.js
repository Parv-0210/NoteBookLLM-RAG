/**
 * DocuMind — Client-Side Application Logic
 * ==========================================
 * Handles document upload (with drag & drop), chat messaging,
 * document switching, and UI state management.
 */

// ── DOM Elements ─────────────────────────────────────────
const uploadZone = document.getElementById("upload-zone");
const fileInput = document.getElementById("file-input");
const uploadProgress = document.getElementById("upload-progress");
const progressFilename = document.getElementById("progress-filename");
const progressStatus = document.getElementById("progress-status");
const progressBarFill = document.getElementById("progress-bar-fill");
const documentList = document.getElementById("document-list");
const emptyState = document.getElementById("empty-state");
const chatMessages = document.getElementById("chat-messages");
const chatInputArea = document.getElementById("chat-input-area");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const charCount = document.getElementById("char-count");
const activeDocName = document.getElementById("active-doc-name");
const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
const sidebar = document.getElementById("sidebar");

// ── State ────────────────────────────────────────────────
let activeDocumentId = null;
let documents = [];
let chatHistory = {}; // documentId -> messages[]
let isProcessing = false;

// ── Toast Notifications ──────────────────────────────────
function createToastContainer() {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message, type = "info") {
  const container = createToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Sidebar Toggle ───────────────────────────────────────
sidebarToggleBtn.addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
});

// ── File Upload ──────────────────────────────────────────

// Click to upload
uploadZone.addEventListener("click", () => fileInput.click());

// File selected
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) {
    handleFileUpload(e.target.files[0]);
  }
  fileInput.value = ""; // Reset
});

// Drag & Drop
uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadZone.classList.add("drag-over");
});

uploadZone.addEventListener("dragleave", () => {
  uploadZone.classList.remove("drag-over");
});

uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length > 0) {
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

async function handleFileUpload(file) {
  // Validate file type
  const allowedTypes = [
    "application/pdf",
    "text/plain",
    "text/markdown",
  ];
  if (!allowedTypes.includes(file.type) && !file.name.match(/\.(pdf|txt|md)$/i)) {
    showToast("Only PDF, TXT, and MD files are supported.", "error");
    return;
  }

  // Validate file size (20MB)
  if (file.size > 20 * 1024 * 1024) {
    showToast("File size must be under 20 MB.", "error");
    return;
  }

  // Show progress
  uploadProgress.classList.remove("hidden");
  progressFilename.textContent = file.name;
  progressStatus.textContent = "Uploading...";
  progressBarFill.style.width = "10%";

  try {
    const formData = new FormData();
    formData.append("document", file);

    // Simulate progress phases
    progressBarFill.style.width = "30%";
    progressStatus.textContent = "Parsing document...";

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    progressBarFill.style.width = "80%";
    progressStatus.textContent = "Indexing chunks...";

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Upload failed");
    }

    progressBarFill.style.width = "100%";
    progressStatus.textContent = "Done!";

    // Add document to list
    documents.push(data.document);
    chatHistory[data.document.id] = [];
    renderDocumentList();

    // Auto-select the uploaded document
    selectDocument(data.document.id);

    showToast(data.message, "success");

    // Hide progress after a moment
    setTimeout(() => {
      uploadProgress.classList.add("hidden");
      progressBarFill.style.width = "0%";
    }, 1500);
  } catch (error) {
    progressStatus.textContent = "Failed";
    progressBarFill.style.width = "0%";
    showToast(error.message, "error");
    setTimeout(() => uploadProgress.classList.add("hidden"), 2000);
  }
}

// ── Document List ────────────────────────────────────────

function renderDocumentList() {
  documentList.innerHTML = "";

  if (documents.length === 0) {
    return;
  }

  documents.forEach((doc) => {
    const item = document.createElement("div");
    item.className = `doc-item${doc.id === activeDocumentId ? " active" : ""}`;
    item.setAttribute("data-id", doc.id);

    const isPdf = doc.originalName?.toLowerCase().endsWith(".pdf");

    item.innerHTML = `
      <div class="doc-item-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${isPdf
            ? '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
            : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'
          }
        </svg>
      </div>
      <div class="doc-item-info">
        <div class="doc-item-name" title="${doc.name}">${doc.name}</div>
        <div class="doc-item-meta">${doc.pages} page${doc.pages !== 1 ? "s" : ""} · ${doc.chunks} chunks</div>
      </div>
      <button class="doc-item-delete" title="Remove document" onclick="event.stopPropagation(); deleteDocument('${doc.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    item.addEventListener("click", () => selectDocument(doc.id));
    documentList.appendChild(item);
  });
}

function selectDocument(docId) {
  activeDocumentId = docId;
  const doc = documents.find((d) => d.id === docId);

  // Update UI
  activeDocName.textContent = doc ? doc.name : "No document selected";
  emptyState.classList.add("hidden");
  chatMessages.classList.add("visible");
  chatInputArea.classList.remove("hidden");
  chatInputArea.classList.add("visible");

  // Render chat history for this document
  renderChatMessages();
  renderDocumentList();

  // Focus input
  chatInput.focus();
}

function deleteDocument(docId) {
  documents = documents.filter((d) => d.id !== docId);
  delete chatHistory[docId];

  if (activeDocumentId === docId) {
    activeDocumentId = null;
    activeDocName.textContent = "No document selected";
    emptyState.classList.remove("hidden");
    chatMessages.classList.remove("visible");
    chatInputArea.classList.add("hidden");
    chatInputArea.classList.remove("visible");
    chatMessages.innerHTML = "";
  }

  renderDocumentList();

  // Also delete from server (fire & forget)
  fetch(`/api/documents/${docId}`, { method: "DELETE" }).catch(() => {});
}

// ── Chat Messages ────────────────────────────────────────

function renderChatMessages() {
  chatMessages.innerHTML = "";
  const messages = chatHistory[activeDocumentId] || [];

  if (messages.length === 0) {
    // Show welcome message
    const welcomeMsg = createMessageElement(
      "assistant",
      "👋 I've loaded your document! Ask me anything about it and I'll find the answer directly from the content.",
      [],
      new Date()
    );
    chatMessages.appendChild(welcomeMsg);
  }

  messages.forEach((msg) => {
    const el = createMessageElement(
      msg.role,
      msg.content,
      msg.sources || [],
      msg.timestamp
    );
    chatMessages.appendChild(el);
  });

  scrollToBottom();
}

function createMessageElement(role, content, sources = [], timestamp) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;

  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  const avatarContent =
    role === "user"
      ? "U"
      : `<svg width="18" height="18" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="url(#logoGrad)"/><path d="M9 10h14M9 16h10M9 22h12" stroke="white" stroke-width="2.5" stroke-linecap="round"/><circle cx="24" cy="22" r="3" fill="white" opacity="0.9"/></svg>`;

  const formattedContent = formatMarkdown(content);

  let sourcesHtml = "";
  if (sources.length > 0) {
    sourcesHtml = `
      <div class="message-sources">
        <span class="source-label">Sources:</span>
        ${sources.map((p) => `<span class="source-tag">Page ${p}</span>`).join("")}
      </div>
    `;
  }

  msg.innerHTML = `
    <div class="message-avatar">${avatarContent}</div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-sender">${role === "user" ? "You" : "DocuMind"}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-body">${formattedContent}</div>
      ${sourcesHtml}
    </div>
  `;

  return msg;
}

function createTypingIndicator() {
  const el = document.createElement("div");
  el.className = "typing-indicator";
  el.id = "typing-indicator";
  el.innerHTML = `
    <div class="message-avatar">
      <svg width="18" height="18" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="url(#logoGrad)"/><path d="M9 10h14M9 16h10M9 22h12" stroke="white" stroke-width="2.5" stroke-linecap="round"/><circle cx="24" cy="22" r="3" fill="white" opacity="0.9"/></svg>
    </div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-sender">DocuMind</span>
      </div>
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  return el;
}

function formatMarkdown(text) {
  if (!text) return "";

  let html = text
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Bold
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Blockquote
    .replace(/^&gt;\s(.+)$/gm, "<blockquote>$1</blockquote>")
    // Unordered lists
    .replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>")
    // Ordered lists
    .replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>")
    // Paragraphs
    .replace(/\n{2,}/g, "</p><p>")
    // Line breaks
    .replace(/\n/g, "<br>");

  // Wrap consecutive <li> elements in <ul>
  html = html.replace(
    /(<li>[\s\S]*?<\/li>)(?=\s*<li>|$)/g,
    (match) => match
  );
  html = html.replace(
    /((?:<li>.*?<\/li>\s*(?:<br>)?)+)/g,
    "<ul>$1</ul>"
  );
  // Clean up <br> inside <ul>
  html = html.replace(/<ul>([\s\S]*?)<\/ul>/g, (match, inner) => {
    return "<ul>" + inner.replace(/<br>/g, "") + "</ul>";
  });

  return `<p>${html}</p>`;
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Chat Input ───────────────────────────────────────────

// Auto-resize textarea
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";

  const len = chatInput.value.length;
  charCount.textContent = `${len} / 2000`;
  sendBtn.disabled = len === 0 || isProcessing;
});

// Send on Enter (Shift+Enter for newline)
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) {
      sendMessage();
    }
  }
});

sendBtn.addEventListener("click", sendMessage);

async function sendMessage() {
  const question = chatInput.value.trim();
  if (!question || !activeDocumentId || isProcessing) return;

  isProcessing = true;
  sendBtn.disabled = true;

  // Add user message
  const userMsg = {
    role: "user",
    content: question,
    timestamp: new Date().toISOString(),
  };

  if (!chatHistory[activeDocumentId]) {
    chatHistory[activeDocumentId] = [];
  }
  chatHistory[activeDocumentId].push(userMsg);

  const userEl = createMessageElement("user", question, [], new Date());
  chatMessages.appendChild(userEl);

  // Clear input
  chatInput.value = "";
  chatInput.style.height = "auto";
  charCount.textContent = "0 / 2000";

  // Show typing indicator
  const typingEl = createTypingIndicator();
  chatMessages.appendChild(typingEl);
  scrollToBottom();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        documentId: activeDocumentId,
      }),
    });

    const data = await response.json();

    // Remove typing indicator
    typingEl.remove();

    if (!response.ok) {
      throw new Error(data.error || "Failed to get answer");
    }

    // Add assistant message
    const assistantMsg = {
      role: "assistant",
      content: data.answer,
      sources: data.sources || [],
      timestamp: new Date().toISOString(),
    };
    chatHistory[activeDocumentId].push(assistantMsg);

    const assistantEl = createMessageElement(
      "assistant",
      data.answer,
      data.sources || [],
      new Date()
    );
    chatMessages.appendChild(assistantEl);
    scrollToBottom();
  } catch (error) {
    typingEl.remove();
    showToast(error.message, "error");

    // Add error message in chat
    const errorEl = createMessageElement(
      "assistant",
      `⚠️ Sorry, I encountered an error: ${error.message}. Please try again.`,
      [],
      new Date()
    );
    chatMessages.appendChild(errorEl);
    scrollToBottom();
  } finally {
    isProcessing = false;
    sendBtn.disabled = chatInput.value.length === 0;
  }
}

// ── Initialize ───────────────────────────────────────────
async function init() {
  try {
    const response = await fetch("/api/documents");
    const data = await response.json();
    documents = data.documents || [];

    documents.forEach((doc) => {
      if (!chatHistory[doc.id]) {
        chatHistory[doc.id] = [];
      }
    });

    renderDocumentList();
  } catch (error) {
    console.error("Failed to load documents:", error);
  }
}

init();
