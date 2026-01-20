// server.js
// Node.js backend for File Converter Web App

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Storage setup
const upload = multer({ dest: 'uploads/' });

// Demo login API
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username && password) {
    return res.json({ success: true, message: 'Login successful' });
  }

  res.status(400).json({ success: false, message: 'Invalid credentials' });
});

// File conversion API
app.post('/convert', upload.single('file'), (req, res) => {
  const format = req.body.format;
  const filePath = req.file.path;

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('File read error');

    let output;
    let ext;

    if (format === 'json') {
      output = JSON.stringify({ data }, null, 2);
      ext = '.json';
    } else {
      output = data;
      ext = '.txt';
    }

    const outputPath = filePath + ext;
    fs.writeFileSync(outputPath, output);

    res.download(outputPath, () => {
      fs.unlinkSync(filePath);
      fs.unlinkSync(outputPath);
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
