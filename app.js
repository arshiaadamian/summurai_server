// server.js
const express = require("express");
const cors = require("cors");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");
const app = express();
const PORT = 3000;

// Middleware
app.use(express.json({ limit: "50mb" })); // parse JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload()); // for multipart/form-data file uploads

app.use(
  cors({
    origin: ["https://learn.bcit.ca", "chrome-extension://*"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

/**
 * Convert incoming ArrayBuffer / number[] / Buffer into text using pdf-parse.
 * Accepts:
 * - Buffer
 * - ArrayBuffer
 * - Array<number>
 */
async function arrayBufferToText(arrayBufferOrNumberArray) {
  let buf;

  if (Buffer.isBuffer(arrayBufferOrNumberArray)) {
    buf = arrayBufferOrNumberArray;
  } else if (Array.isArray(arrayBufferOrNumberArray)) {
    // number[] -> Buffer
    buf = Buffer.from(arrayBufferOrNumberArray);
  } else if (arrayBufferOrNumberArray instanceof ArrayBuffer) {
    buf = Buffer.from(arrayBufferOrNumberArray);
  } else {
    throw new Error("Unsupported input for arrayBufferToText");
  }

  // pdf-parse returns { text, info, numpages, ... }
  const pdfData = await pdfParse(buf);
  return pdfData.text ?? "";
}

/**
 * Accept a "blob-like" object and extract text.
 * Handles:
 * - object with arrayBuffer() method (e.g. Blob)
 * - express-fileupload file object (has .data Buffer)
 * - Buffer / ArrayBuffer / number[]
 */
async function blobObjectToText(blob) {
  // express-fileupload object
  if (blob && blob.data && Buffer.isBuffer(blob.data)) {
    return arrayBufferToText(blob.data);
  }

  // If blob has arrayBuffer() (browser Blob-like)
  if (blob && typeof blob.arrayBuffer === "function") {
    const ab = await blob.arrayBuffer(); // ArrayBuffer
    return arrayBufferToText(ab);
  }

  // If it's raw Buffer / ArrayBuffer / number[]
  if (Buffer.isBuffer(blob) || blob instanceof ArrayBuffer || Array.isArray(blob)) {
    return arrayBufferToText(blob);
  }

  throw new Error("Unsupported blob type");
}

/**
 * Summarize using an LLM (OpenAI-compatible endpoint).
 * Reads key from process.env.OPENAI_API_KEY.
 * Returns a short summary string.
 */
async function summarizeTextWithAPI(text, { max_tokens = 200 } = {}) {
  if (!text || text.trim() === "") return "";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  // Build a prompt that asks for a concise summary.
  const system = "You are a helpful summarization assistant. Produce a concise, clear summary.";
  const user = `Summarize the following text concisely (1-3 short paragraphs or bullet points):\n\n${text}`;

  // Use Chat Completions (v1/chat/completions)
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini", // if unavailable in your account switch to "gpt-4o" or "gpt-3.5-turbo"
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens,
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM API error: ${resp.status} ${errText}`);
  }

  const json = await resp.json();

  // Extract the assistant text safely
  const assistantMessage =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    "";

  return assistantMessage.trim();
}

/**
 * Routes
 */

// Accepts { buffer: [numbers] } or { buffer: "<base64string>" } optionally
app.post("/buffer-to-text", async (req, res) => {
  try {
    const { buffer } = req.body;
    if (!buffer) return res.status(400).json({ error: "buffer required in body" });

    let text;
    // If client passed base64 string:
    if (typeof buffer === "string") {
      // try base64 decode
      const maybeBuf = Buffer.from(buffer, "base64");
      // crude check: does it look like PDF? (first bytes %PDF)
      if (maybeBuf.slice(0, 4).toString() === "%PDF") {
        text = await arrayBufferToText(maybeBuf);
      } else {
        // treat as number array serialized as string (e.g. "[34,45,...]")
        try {
          const arr = JSON.parse(buffer);
          if (Array.isArray(arr)) text = await arrayBufferToText(arr);
        } catch {
          text = buffer; // fallback: treat as plain text
        }
      }
    } else {
      // buffer is likely an array of numbers or ArrayBuffer or Buffer
      text = await arrayBufferToText(buffer);
    }

    // Summarize and return
    const summary = await summarizeTextWithAPI(text);
    res.json({ text, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to parse buffer" });
  }
});

// multipart/form-data upload (express-fileupload) OR JSON with blob-like object
app.post("/blob-to-text", async (req, res) => {
  try {
    // If file uploaded via express-fileupload (file.data present)
    if (req.files && req.files.file) {
      const extracted = await blobObjectToText(req.files.file);
      const summary = await summarizeTextWithAPI(extracted);
      return res.json({ text: extracted, summary });
    }

    // If client sent a blob-like object in JSON body with arrayBuffer data or base64
    const { blob } = req.body;
    if (!blob) return res.status(400).json({ error: "file (multipart) or blob (JSON) required" });

    // If blob is object with .data (e.g. serialized) or number array
    const extracted = await blobObjectToText(blob);
    const summary = await summarizeTextWithAPI(extracted);
    res.json({ text: extracted, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to parse blob" });
  }
});

app.post("/summarize", async (req, res) => {
  try {
    const { text, context } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });

    // Optionally include context to the prompt
    const promptText = context ? `${context}\n\n${text}` : text;
    const summary = await summarizeTextWithAPI(promptText);

    res.json({ summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to summarize" });
  }
});

app.get("/test", (req, res) => {
  res.json({
    message: "✅ Server is up and running!",
    status: "success",
    timestamp: new Date().toISOString(),
    env: {
      // DO NOT leak sensitive info — only check presence
      OPENAI_API_KEY_SET: !!process.env.OPENAI_API_KEY,
    },
  });
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
