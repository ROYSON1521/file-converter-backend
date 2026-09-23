// server.js
// Node.js backend for File Converter Web App

const bcrypt = require("bcrypt");
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const usersPath = process.env.USERS_FILE || path.join(__dirname, "users.json");
const PDFDocument = require("pdfkit");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { Document, Packer, Paragraph } = require("docx");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const SECRET_KEY = process.env.JWT_SECRET;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

if (!SECRET_KEY) {
  throw new Error("JWT_SECRET environment variable must be configured");
}

// Storage setup
const MAX_UPLOAD_SIZE = 40 * 1024 * 1024;
const upload = multer({ dest: 'uploads/', limits: { fileSize: MAX_UPLOAD_SIZE } });

function transcodeAudio(inputPath, outputPath, outputFormat) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("FFmpeg binary is unavailable on this server"));

    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-map", "0:a:0", "-vn"];
    if (outputFormat === "m4a") args.push("-c:a", "aac", "-b:a", "192k");
    else if (outputFormat === "flac") args.push("-c:a", "flac");
    else args.push("-c:a", "pcm_s16le");
    args.push(outputPath);

    const ffmpeg = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    ffmpeg.stderr.on("data", chunk => {
      errorOutput = (errorOutput + chunk.toString()).slice(-4000);
    });
    ffmpeg.once("error", reject);
    ffmpeg.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput || `FFmpeg exited with code ${code}`));
    });
  });
}

async function convertOfficeToPdf(sourcePath, originalName) {
  const extension = path.extname(originalName).toLowerCase();
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-converter-office-"));
  const inputPath = path.join(workingDir, `document${extension}`);
  const outputPath = path.join(workingDir, "document.pdf");
  const profilePath = path.join(workingDir, "lo-profile");
  fs.copyFileSync(sourcePath, inputPath);

  try {
    await new Promise((resolve, reject) => {
      const args = [
        "--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
        `-env:UserInstallation=${pathToFileURL(profilePath).href}`,
        "--convert-to", "pdf", "--outdir", workingDir, inputPath,
      ];
      const office = spawn(process.env.LIBREOFFICE_PATH || "soffice", args, { stdio: ["ignore", "ignore", "pipe"] });
      let errorOutput = "";
      let settled = false;
      const timer = setTimeout(() => {
        office.kill("SIGKILL");
        if (!settled) {
          settled = true;
          reject(new Error("Office conversion timed out"));
        }
      }, 90000);
      office.stderr.on("data", chunk => {
        errorOutput = (errorOutput + chunk.toString()).slice(-4000);
      });
      office.once("error", err => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      office.once("close", code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0 && fs.existsSync(outputPath)) resolve();
        else reject(new Error(errorOutput || `LibreOffice exited with code ${code}`));
      });
    });
    return { outputPath, workingDir };
  } catch (err) {
    fs.rmSync(workingDir, { recursive: true, force: true });
    throw err;
  }
}

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
  docx_to_pdf: [".docx"],
  pptx_to_pdf: [".pptx"],
  jpg_to_png: [".jpg"],
  jpeg_to_png: [".jpeg"],
  png_to_jpeg: [".png"],
  webp_to_jpeg: [".webp"],
  webp_to_png: [".webp"],
  mp3_to_m4a: [".mp3"],
  mp3_to_wav: [".mp3"],
  mp3_to_flac: [".mp3"],
  m4a_to_wav: [".m4a"],
};

if (!allowedMap[format]?.includes(ext)) {
  fs.unlinkSync(req.file.path);
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

    else if (["jpg_to_png", "jpeg_to_png", "png_to_jpeg", "webp_to_jpeg", "webp_to_png"].includes(format)) {
      const toPng = format.endsWith("_to_png");
      const outputFormat = toPng ? "png" : "jpeg";
      const output = await sharp(filePath)
        .rotate()
        .toFormat(outputFormat, outputFormat === "jpeg" ? { quality: 90 } : {})
        .toBuffer();
      res.setHeader("Content-Type", outputFormat === "png" ? "image/png" : "image/jpeg");
      res.setHeader("Content-Disposition", `attachment; filename=output.${outputFormat}`);
      res.send(output);
    }

    else if (["mp3_to_m4a", "mp3_to_wav", "mp3_to_flac", "m4a_to_wav"].includes(format)) {
      const outputFormat = format.endsWith("_m4a") ? "m4a" : format.endsWith("_flac") ? "flac" : "wav";
      const outputPath = `${filePath}.${outputFormat}`;
      try {
        await transcodeAudio(filePath, outputPath, outputFormat);
        await new Promise(resolve => {
          res.download(outputPath, `converted.${outputFormat}`, err => {
            if (err) {
              console.error("Audio download error:", err);
              if (!res.headersSent) res.status(500).send("Could not send converted audio");
            }
            resolve();
          });
        });
      } finally {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      }
    }

    else if (["docx_to_pdf", "pptx_to_pdf"].includes(format)) {
      let officeFiles;
      try {
        officeFiles = await convertOfficeToPdf(filePath, originalName);
        await new Promise(resolve => {
          res.download(officeFiles.outputPath, `${path.parse(originalName).name}.pdf`, err => {
            if (err) {
              console.error("Office document download error:", err);
              if (!res.headersSent) res.status(500).send("Could not send converted PDF");
            }
            resolve();
          });
        });
      } finally {
        if (officeFiles && fs.existsSync(officeFiles.workingDir)) {
          fs.rmSync(officeFiles.workingDir, { recursive: true, force: true });
        }
      }
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

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ message: "File size exceeds the 40 MB limit." });
  }
  console.error("Request error:", err);
  return res.status(500).json({ message: "The server could not process the upload." });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
