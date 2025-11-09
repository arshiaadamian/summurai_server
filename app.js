const express = require("express");
const cors = require("cors");
const app = express();
const PORT = 3000;

app.use(
  cors({
    origin: [
        "https://learn.bcit.ca",
        "chrome-extension://*"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],

  })
);

async function arrayBufferToText(arrayBuffer) {
  return "data";
}

async function blobObjectToText(blob){
    return "data";
}


app.post("/buffer-to-text", async (req, res) => {
     res.json({ text: "Data from buffer" });
});


app.post("/blob-to-text", async (req, res) => {
 res.json({ text: "Data from blob" });
});


app.post("/summarize", async (req, res) => {
     res.json({ text: "Summarized data" });
});

app.get("/test", (req, res) => {
  res.json({
    message: "Server is up and running!",
    status: "success",
    timestamp: new Date().toISOString(),
  });
});


app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
