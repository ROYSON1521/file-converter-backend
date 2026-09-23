// server.js
// Node.js backend for File Converter Web App

const bcrypt = require("bcrypt");
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const usersPath = process.env.USERS_FILE || path.join(__dirname, "users.json");
const PDFDocument = require("pdfkit");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { Document, Packer, Paragraph } = require("docx");
const jwt = require("jsonwebtoken");
const SECRET_KEY = process.env.JWT_SECRET;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

if (!SECRET_KEY) {
  throw new Error("JWT_SECRET environment variable must be configured");
}

// Storage setup
const upload = multer({ dest: 'uploads/' });

function readUsers() {
  if (!fs.existsSync(usersPath)) return [];
  const users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
  if (!Array.isArray(users)) throw new Error("User data file has an invalid format");
  return users;
}

function writeUsers(users) {
  const tempPath = `${usersPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, usersPath);
}

app.post("/register", async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!username || !password.trim()) {
      return res.status(400).json({ message: "Username and password required" });
    }

    const users = readUsers();
    if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    users.push({ username, password: hashedPassword });
    writeUsers(users);
    return res.status(201).json({ success: true, message: "Registration successful" });
  } catch (err) {
    console.error("Registration error:", err);
    return res.status(500).json({ message: "Could not save the account. Check server storage and logs." });
  }
});

app.post("/login", async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password required" });
    }

    const users = readUsers();
    const user = users.find(item => item.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(401).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid password" });

    const token = jwt.sign({ username: user.username }, SECRET_KEY, { expiresIn: "1h" });
    return res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "Could not read account data. Check server storage and logs." });
  }
});

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ message: "No token provided" });

  const token = authHeader.split(" ")[1];

  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ message: "Invalid token" });
    req.user = decoded;
    next();
  });
}

// File conversion API
app.post("/convert", verifyToken, upload.single("file"), async (req, res) => {
  if (!req.file) {
  return res.status(400).send("No file uploaded");
  }
const { format } = req.body;
const ext = path.extname(req.file.originalname).toLowerCase();

const allowedMap = {
  txt_to_pdf: [".txt"],
  txt_to_docx: [".txt"],
  pdf_to_txt: [".pdf"],
  docx_to_txt: [".docx"],
  pdf_to_docx: [".pdf"],
};

if (!allowedMap[format]?.includes(ext)) {
  return res.status(400).send("Invalid file type for selected conversion");
}

  const filePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    // TXT → PDF
    if (format === "txt_to_pdf") {
      const text = fs.readFileSync(filePath, "utf-8");
      const pdf = new PDFDocument();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=output.pdf");
      pdf.pipe(res);
      pdf.text(text);
      pdf.end();
    }

    // TXT → DOCX
    else if (format === "txt_to_docx") {
      const text = fs.readFileSync(filePath, "utf-8");
      const doc = new Document({
        sections: [{ children: [new Paragraph(text)] }],
      });
      const buffer = await Packer.toBuffer(doc);
      res.setHeader("Content-Disposition", "attachment; filename=output.docx");
      res.send(buffer);
    }

    // PDF → TXT
    else if (format === "pdf_to_txt") {
      const data = await pdfParse(fs.readFileSync(filePath));
      res.setHeader("Content-Disposition", "attachment; filename=output.txt");
      res.send(data.text);
    }

    // DOCX → TXT
    else if (format === "docx_to_txt") {
      const result = await mammoth.extractRawText({ path: filePath });
      res.setHeader("Content-Disposition", "attachment; filename=output.txt");
      res.send(result.value);
    }

    // PDF → DOCX
    else if (format === "pdf_to_docx") {
      const data = await pdfParse(fs.readFileSync(filePath));
      const doc = new Document({
        sections: [{ children: [new Paragraph(data.text)] }],
      });
      const buffer = await Packer.toBuffer(doc);
      res.setHeader("Content-Disposition", "attachment; filename=output.docx");
      res.send(buffer);
    }

    else {
      res.status(400).send("Unsupported conversion type");
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Conversion failed");
  } finally {
    if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  } // cleanup
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
