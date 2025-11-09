// app.js (CommonJS)

const express = require("express");
const cors = require("cors");
const fileUpload = require("express-fileupload");

// Robust CJS import for pdf-parse (handles default/named exports)
const pdfParseModule = require("pdf-parse");
const pdfParse =
  typeof pdfParseModule === "function" ? pdfParseModule : pdfParseModule.default;

const app = express();
const PORT = process.env.PORT || 3000; // important for Render

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

app.use(
  cors({
    origin: ["https://learn.bcit.ca", "chrome-extension://*"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// OPTIONAL: serve /public if you add an index.html later
// app.use(express.static("public"));

/**
 * Convert incoming ArrayBuffer / number[] / Buffer into text using pdf-parse.
 */
async function arrayBufferToText(arrayBufferOrNumberArray) {
  let buf;

  if (Buffer.isBuffer(arrayBufferOrNumberArray)) {
    buf = arrayBufferOrNumberArray;
  } else if (Array.isArray(arrayBufferOrNumberArray)) {
    buf = Buffer.from(arrayBufferOrNumberArray);
  } else if (arrayBufferOrNumberArray instanceof ArrayBuffer) {
    buf = Buffer.from(arrayBufferOrNumberArray);
  } else {
    throw new Error("Unsupported input for arrayBufferToText");
  }

  const pdfData = await pdfParse(buf);
  return pdfData.text ?? "";
}

/**
 * Accept a "blob-like" object and extract text.
 */
async function blobObjectToText(blob) {
  if (blob && blob.data && Buffer.isBuffer(blob.data)) {
    // express-fileupload file object
    return arrayBufferToText(blob.data);
  }
  if (blob && typeof blob.arrayBuffer === "function") {
    const ab = await blob.arrayBuffer();
    return arrayBufferToText(ab);
  }
  if (Buffer.isBuffer(blob) || blob instanceof ArrayBuffer || Array.isArray(blob)) {
    return arrayBufferToText(blob);
  }
  throw new Error("Unsupported blob type");
}

/**
 * Summarize using OpenAI-compatible API.
 */
async function summarizeTextWithAPI(text, { max_tokens = 200 } = {}) {
  if (!text || text.trim() === "") return "";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const system = "You are a helpful summarization assistant. Produce a concise, clear summary.";
  const user = `Summarize the following text concisely (1-3 short paragraphs or bullet points):\n\n${text}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
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
  const assistantMessage =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    "";

  return assistantMessage.trim();
}

/**
 * Routes
 */

// Simple landing page so "/" doesn't show "Cannot GET /"
app.get("/", (req, res) => {
  res.type("html").send(`
    <h1>Summurai Server ✅</h1>
    <p>Your API is running.</p>
    <ul>
      <li><a href="/test">/test</a> – health check</li>
    </ul>
    <p>POST endpoints:</p>
    <pre>POST /buffer-to-text   (JSON) { "buffer": [numbers] | base64 }</pre>
    <pre>POST /blob-to-text     (multipart/form-data) file=@doc.pdf</pre>
    <pre>POST /summarize        (JSON) { "text": "..." }</pre>
  `);
});

// Accepts { buffer: [numbers] } or { buffer: "<base64string>" } optionally
app.post("/buffer-to-text", async (req, res) => {
  try {
    const { buffer } = req.body;
    if (!buffer) return res.status(400).json({ error: "buffer required in body" });

    let text;
    if (typeof buffer === "string") {
      const maybeBuf = Buffer.from(buffer, "base64");
      if (maybeBuf.slice(0, 4).toString() === "%PDF") {
        text = await arrayBufferToText(maybeBuf);
      } else {
        try {
          const arr = JSON.parse(buffer);
          if (Array.isArray(arr)) text = await arrayBufferToText(arr);
        } catch {
          text = buffer;
        }
      }
    } else {
      text = await arrayBufferToText(buffer);
    }

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
    if (req.files && req.files.file) {
      const extracted = await blobObjectToText(req.files.file);
      const summary = await summarizeTextWithAPI(extracted);
      return res.json({ text: extracted, summary });
    }

    const { blob } = req.body;
    if (!blob) return res.status(400).json({ error: "file (multipart) or blob (JSON) required" });

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
    env: { OPENAI_API_KEY_SET: !!process.env.OPENAI_API_KEY },
  });
});

console.log("pdfParse typeof:", typeof pdfParse); // should print "function"
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
