const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 2330;
const uploadDir = path.join(__dirname, "uploads");

// Buat folder uploads jika belum ada
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Fungsi hapus semua file .sql dan .sqlite(.sqlite3) sebelum simpan baru
function cleanUploadFolder() {
  const files = fs.readdirSync(uploadDir);
  for (const file of files) {
    if (file.endsWith(".sql") || file.endsWith(".sqlite3") || file.endsWith(".sqlite")) {
      fs.unlinkSync(path.join(uploadDir, file));
    }
  }
}

/**
 * Fungsi sanitizeSQLContent()
 *
 * Proses:
 * 1. Hapus perintah LOCK TABLES, UNLOCK TABLES, dan PRAGMA (MySQL/SQLite spesifik)
 * 2. Proses blok CREATE TABLE:
 *    - Bagi blok menjadi baris dan cari baris yang memiliki AUTO_INCREMENT.
 *    - Untuk setiap baris yang mengandung AUTO_INCREMENT, ambil nama kolom (misalnya: `id`)
 *      dan gantikan seluruh baris itu menjadi:
 *         `id` INTEGER PRIMARY KEY AUTOINCREMENT
 *    - Catat nama kolom yang telah diubah.
 *    - Hapus baris constraint PRIMARY KEY yang menyebutkan kolom-kolom tersebut (agar tidak terjadi duplikasi).
 *    - Pastikan tiap baris (selain baris terakhir) diakhiri dengan koma.
 * 3. Bersihkan titik koma ganda dan newline berlebihan.
 */
function sanitizeSQLContent(sql) {
  // Hapus perintah yang tidak dibutuhkan
  sql = sql.replace(/LOCK TABLES .*?;/gs, "");
  sql = sql.replace(/UNLOCK TABLES;/g, "");
  sql = sql.replace(/PRAGMA .*?;/gi, "");

  // Proses blok CREATE TABLE secara keseluruhan
  sql = sql.replace(/CREATE TABLE\s+[`"]?(\w+)[`"]?\s*\(([\s\S]*?)\);/gi, (match, tableName, columnsRaw) => {
    // Pecah baris, hilangkan baris kosong dan komentar
    let lines = columnsRaw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("--"));

    let autoIncrementColumns = new Set();
    let newLines = [];

    // 1. Proses tiap baris untuk deteksi AUTO_INCREMENT
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (/AUTO_INCREMENT/i.test(line)) {
        // Cari nama kolom dengan asumsi format: `colName` int ... AUTO_INCREMENT
        let m = line.match(/[`"]?(\w+)[`"]?\s+int\b.*AUTO_INCREMENT/i);
        if (m) {
          const colName = m[1];
          autoIncrementColumns.add(colName);
          // Gantikan baris dengan definisi sesuai SQLite
          line = `\`${colName}\` INTEGER PRIMARY KEY AUTOINCREMENT`;
        }
      }
      newLines.push(line);
    }

    // 2. Hapus constraint PRIMARY KEY yang menyebutkan kolom auto-increment
    newLines = newLines.filter(line => {
      if (/^PRIMARY KEY/i.test(line)) {
        for (const col of autoIncrementColumns) {
          if (line.includes(col)) return false;
        }
      }
      return true;
    });

    // 3. Tambahkan koma jika bukan baris terakhir (jika belum ada)
    for (let i = 0; i < newLines.length; i++) {
      let line = newLines[i];
      if (i < newLines.length - 1 && !line.endsWith(",")) {
        newLines[i] = line + ",";
      }
    }

    return `CREATE TABLE \`${tableName}\` (\n  ${newLines.join("\n  ")}\n);`;
  });

  // Bersihkan semicolon dan newline yang berlebih
  sql = sql.replace(/;\s*;/g, ";");
  sql = sql.replace(/\n{3,}/g, "\n\n");
  return sql;
}

// Konfigurasi file upload dengan multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cleanUploadFolder(); // Hapus file lama
    cb(null, uploadDir);
  },
  filename: (_, file, cb) => cb(null, "upload.sql"), // Gunakan nama tetap
});
const upload = multer({ storage });

// Serve static files (misalnya index.html)
app.use(express.static(__dirname));

// Endpoint upload dan konversi SQL
app.post("/upload", upload.single("sqlFile"), (req, res) => {
  const sqlFilePath = req.file.path;
  const dbFileName = "db.sqlite"; // Nama file database output
  const dbPath = path.join(uploadDir, dbFileName);

  try {
    let sqlContent = fs.readFileSync(sqlFilePath, "utf-8");
    let sanitized = sanitizeSQLContent(sqlContent);
    fs.writeFileSync(sqlFilePath, sanitized, "utf-8");

    const isWindows = process.platform === "win32";
    const sqliteCmd = isWindows ? `"sqlite3.exe"` : "sqlite3";
    // Gunakan perintah .read untuk menjalankan file SQL
    const command = `${sqliteCmd} "${dbPath}" ".read '${sqlFilePath}'"`;

    exec(command, (error, stdout, stderr) => {
      // Hapus file SQL yang sudah diproses
      if (fs.existsSync(sqlFilePath)) fs.unlinkSync(sqlFilePath);

      if (error) {
        console.error("❌ Error:", stderr || error.message);
        return res.status(500).json({
          success: false,
          message: `Gagal menjalankan SQLite: ${stderr || error.message}`,
        });
      }
      return res.json({ success: true, dbFileName });
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint download file hasil konversi
app.get("/download/:filename", (req, res) => {
  const filePath = path.join(uploadDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath, req.params.filename);
  } else {
    res.status(404).send("File not found");
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server aktif di http://localhost:${PORT}`);
});
