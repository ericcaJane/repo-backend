// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Make sure we have: <project>/uploads/research
const uploadRoot = path.join(__dirname, "..", "uploads");
const uploadDir = path.join(uploadRoot, "research");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    // sanitize original name and keep extension (default .pdf)
    const safeBase = path.basename(file.originalname || "document.pdf").replace(/[^\w.-]/g, "_");
    const ext = path.extname(safeBase).toLowerCase() || ".pdf";
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});

const fileFilter = (_req, file, cb) => {
  if (file.mimetype !== "application/pdf") {
    return cb(new Error("Only PDF files are allowed"));
  }
  cb(null, true);
};

const limits = { fileSize: 20 * 1024 * 1024 }; // 20MB

const upload = multer({ storage, fileFilter, limits });

module.exports = upload;          // <-- import this in routes
