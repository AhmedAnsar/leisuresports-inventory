const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Detect environment ───
const IS_RAILWAY = !!process.env.DATABASE_URL;
const RAILWAY_VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || "/data";

// Uploads directory: use Railway volume if available, else local
const UPLOADS_DIR = IS_RAILWAY
  ? path.join(RAILWAY_VOLUME, "uploads")
  : path.join(__dirname, "uploads");

const PDF_DIR = IS_RAILWAY
  ? path.join(RAILWAY_VOLUME, "pdf")
  : path.join(__dirname, "pdf");

// Ensure directories
[UPLOADS_DIR, PDF_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Multer for photo uploads ───
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `racquet_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Middleware
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/pdf", express.static(PDF_DIR));

// ─── Database Abstraction Layer ───
// Supports both SQLite (local) and PostgreSQL (Railway)
let db;

async function initDB() {
  if (IS_RAILWAY) {
    // PostgreSQL on Railway
    const { Pool } = require("pg");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
    });

    db = {
      async run(sql, params = []) {
        // Convert ? placeholders to $1, $2... for pg
        let i = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++i}`);
        await pool.query(pgSql, params);
      },
      async get(sql, params = []) {
        let i = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++i}`);
        const result = await pool.query(pgSql, params);
        return result.rows[0] || null;
      },
      async all(sql, params = []) {
        let i = 0;
        const pgSql = sql.replace(/\?/g, () => `$${++i}`);
        const result = await pool.query(pgSql, params);
        return result.rows;
      },
    };

    // Create table (PostgreSQL syntax)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS racquets (
        id SERIAL PRIMARY KEY,
        inventory_code TEXT UNIQUE NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_email TEXT,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        head_size TEXT,
        weight TEXT,
        grip_size TEXT,
        condition TEXT NOT NULL,
        string_brand TEXT,
        string_model TEXT,
        string_type TEXT,
        string_tension TEXT,
        expected_price REAL NOT NULL,
        notes TEXT,
        photo_path TEXT,
        status TEXT DEFAULT 'Available',
        date_added TIMESTAMP DEFAULT NOW(),
        date_sold TIMESTAMP
      )
    `);

    console.log("✓ Connected to PostgreSQL (Railway)");
  } else {
    // SQLite for local development
    const initSqlJs = require("sql.js");
    const DB_PATH = path.join(__dirname, "tennisrack.db");
    const SQL = await initSqlJs();

    let sqliteDb;
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      sqliteDb = new SQL.Database(buffer);
    } else {
      sqliteDb = new SQL.Database();
    }

    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS racquets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inventory_code TEXT UNIQUE NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_email TEXT,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        head_size TEXT,
        weight TEXT,
        grip_size TEXT,
        condition TEXT NOT NULL,
        string_brand TEXT,
        string_model TEXT,
        string_type TEXT,
        string_tension TEXT,
        expected_price REAL NOT NULL,
        notes TEXT,
        photo_path TEXT,
        status TEXT DEFAULT 'Available',
        date_added TEXT DEFAULT (datetime('now','localtime')),
        date_sold TEXT
      )
    `);

    function saveDB() {
      const data = sqliteDb.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    }
    saveDB();

    db = {
      async run(sql, params = []) {
        sqliteDb.run(sql, params);
        saveDB();
      },
      async get(sql, params = []) {
        const result = sqliteDb.exec(sql, params);
        if (!result.length || !result[0].values.length) return null;
        const cols = result[0].columns;
        const vals = result[0].values[0];
        const obj = {};
        cols.forEach((c, i) => (obj[c] = vals[i]));
        return obj;
      },
      async all(sql, params = []) {
        const result = sqliteDb.exec(sql, params);
        if (!result.length) return [];
        const cols = result[0].columns;
        return result[0].values.map((vals) => {
          const obj = {};
          cols.forEach((c, i) => (obj[c] = vals[i]));
          return obj;
        });
      },
    };

    console.log("✓ Using local SQLite database");
  }
}

// ─── Inventory Code Generator ───
async function generateInventoryCode() {
  const prefix = "LS-A";
  // Get the highest existing number
  const row = await db.get(
    "SELECT inventory_code FROM racquets WHERE inventory_code LIKE 'LS-A-%' ORDER BY id DESC LIMIT 1"
  );
  let nextNum = 1;
  if (row && row.inventory_code) {
    const parts = row.inventory_code.split("-");
    const lastNum = parseInt(parts[2], 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }
  return `${prefix}-${String(nextNum).padStart(4, "0")}`;
}

// ─── API Routes ───

// Health check (Railway uses this)
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Add racquet
app.post("/api/racquets", upload.single("photo"), async (req, res) => {
  try {
    const b = req.body;
    const code = await generateInventoryCode();
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    await db.run(
      `INSERT INTO racquets (inventory_code, customer_name, customer_phone, customer_email,
        brand, model, head_size, weight, grip_size, condition,
        string_brand, string_model, string_type, string_tension,
        expected_price, notes, photo_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code,
        b.customer_name,
        b.customer_phone,
        null,
        b.brand,
        b.model,
        b.head_size || null,
        null,
        b.grip_size || null,
        "Good",
        null,
        null,
        null,
        null,
        parseFloat(b.expected_price),
        b.notes || null,
        photoPath,
      ]
    );

    const row = await db.get(
      "SELECT * FROM racquets WHERE inventory_code = ?",
      [code]
    );
    res.json({ success: true, racquet: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all racquets
app.get("/api/racquets", async (req, res) => {
  try {
    const search = req.query.search || "";
    const status = req.query.status || "";
    let sql = "SELECT * FROM racquets WHERE 1=1";
    const params = [];

    if (search) {
      if (IS_RAILWAY) {
        sql += ` AND (inventory_code ILIKE $${params.length + 1} OR brand ILIKE $${params.length + 2} OR model ILIKE $${params.length + 3} OR customer_name ILIKE $${params.length + 4} OR customer_phone ILIKE $${params.length + 5})`;
      } else {
        sql += ` AND (inventory_code LIKE ? OR brand LIKE ? OR model LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)`;
      }
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (status) {
      if (IS_RAILWAY) {
        sql += ` AND status = $${params.length + 1}`;
      } else {
        sql += ` AND status = ?`;
      }
      params.push(status);
    }
    sql += " ORDER BY id DESC";

    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Lookup by code
app.get("/api/racquets/lookup/:code", async (req, res) => {
  try {
    const row = await db.get(
      "SELECT * FROM racquets WHERE inventory_code = ?",
      [req.params.code.toUpperCase()]
    );
    if (row) {
      res.json(row);
    } else {
      res.status(404).json({ error: "Not found" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search by phone number
app.get("/api/racquets/search-phone", async (req, res) => {
  try {
    const phone = (req.query.phone || "").replace(/\D/g, "");
    if (!phone || phone.length < 4) {
      return res.status(400).json({ error: "Enter at least 4 digits" });
    }
    let rows;
    if (IS_RAILWAY) {
      rows = await db.all(
        `SELECT * FROM racquets WHERE REPLACE(REPLACE(REPLACE(REPLACE(customer_phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE $1 ORDER BY id DESC`,
        [`%${phone}%`]
      );
    } else {
      rows = await db.all(
        `SELECT * FROM racquets WHERE REPLACE(REPLACE(REPLACE(REPLACE(customer_phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ? ORDER BY id DESC`,
        [`%${phone}%`]
      );
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update status
app.patch("/api/racquets/:code/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (IS_RAILWAY) {
      const dateSold = status === "Sold" ? new Date().toISOString() : null;
      await db.run(
        "UPDATE racquets SET status = $1, date_sold = $2 WHERE inventory_code = $3",
        [status, dateSold, req.params.code]
      );
    } else {
      const dateSold = status === "Sold" ? new Date().toISOString() : null;
      await db.run(
        "UPDATE racquets SET status = ?, date_sold = ? WHERE inventory_code = ?",
        [status, dateSold, req.params.code]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete
app.delete("/api/racquets/:code", async (req, res) => {
  try {
    await db.run("DELETE FROM racquets WHERE inventory_code = ?", [
      req.params.code,
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PDF Generation ───
app.get("/api/racquets/:code/pdf", async (req, res) => {
  try {
    const item = await db.get(
      "SELECT * FROM racquets WHERE inventory_code = ?",
      [req.params.code.toUpperCase()]
    );
    if (!item) return res.status(404).json({ error: "Not found" });

    const pdfPath = path.join(PDF_DIR, `${item.inventory_code}.pdf`);

    // Generate QR code
    const qrDataUrl = await QRCode.toDataURL(item.inventory_code, {
      width: 120,
      margin: 1,
    });
    const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    const W = doc.page.width - 100;
    const accent = "#c8a96e";
    const dark = "#1a1a2e";
    const gray = "#666666";

    // ── Header ──
    doc.rect(50, 50, W, 80).fill(dark);
    doc.fill("#fff").fontSize(22).font("Helvetica-Bold").text("LEISURE SPORTS", 70, 60);
    doc.fill(accent).fontSize(9).font("Helvetica").text("TENNIS PRO SHOP · EST. 1978", 70, 84);
    doc.fill("#aaa").fontSize(8).font("Helvetica").text("400 Orchard Road #04-22 Singapore 238875 · +65 6737 0656", 70, 98);
    doc.fill("#fff").fontSize(14).font("Helvetica-Bold").text(item.inventory_code, 320, 65, { width: 210, align: "right" });
    doc.fill(accent).fontSize(9).font("Helvetica").text("PRE-OWNED RACQUET RECEIPT", 320, 84, { width: 210, align: "right" });
    doc.fill("#aaa").fontSize(9).font("Helvetica").text(formatDatePDF(item.date_added), 320, 98, { width: 210, align: "right" });

    // ── QR Code ──
    doc.image(qrBuffer, W - 30, 145, { width: 80 });
    doc.fill(gray).fontSize(7).text("Scan or paste code", W - 35, 228, { width: 90, align: "center" });

    let y = 155;

    // ── Customer ──
    y = sectionHeader(doc, "CUSTOMER DETAILS", y, accent);
    y = tableRow(doc, "Name", item.customer_name, y);
    y = tableRow(doc, "Phone", item.customer_phone, y);
    y += 10;

    // ── Racquet ──
    y = sectionHeader(doc, "RACQUET DETAILS", y, accent);
    y = tableRow(doc, "Brand", item.brand, y);
    y = tableRow(doc, "Model", item.model, y);
    y = tableRow(doc, "Variant", item.head_size || "—", y);
    y = tableRow(doc, "Grip Size", item.grip_size || "—", y);
    y += 10;

    // ── Price ──
    y = sectionHeader(doc, "PRICING", y, accent);
    doc.rect(50, y, W, 40).fill("#f8f8f8");
    doc.fill(dark).fontSize(12).font("Helvetica").text("Expected Selling Price", 70, y + 12);
    doc.fill(accent).fontSize(18).font("Helvetica-Bold").text(`S$${Number(item.expected_price).toFixed(2)}`, 300, y + 9, { width: 230, align: "right" });
    y += 50;

    if (item.notes) {
      y = sectionHeader(doc, "NOTES", y, accent);
      doc.fill(gray).fontSize(10).font("Helvetica").text(item.notes, 70, y, { width: W - 40 });
      y += doc.heightOfString(item.notes, { width: W - 40 }) + 15;
    }

    // ── Photo ──
    if (item.photo_path) {
      const absPhoto = IS_RAILWAY
        ? path.join(RAILWAY_VOLUME, item.photo_path.replace(/^\//, ""))
        : path.join(__dirname, item.photo_path);
      if (fs.existsSync(absPhoto)) {
        if (y > 580) { doc.addPage(); y = 50; }
        y = sectionHeader(doc, "RACQUET PHOTO", y, accent);
        try {
          doc.image(absPhoto, 120, y, { fit: [350, 250] });
          y += 260;
        } catch (e) { /* skip */ }
      }
    }

    // ── Footer ──
    const footerY = doc.page.height - 60;
    doc.rect(50, footerY, W, 0.5).fill("#ddd");
    doc.fill("#aaa").fontSize(8).font("Helvetica")
      .text(`Generated by Leisure Sports Inventory System · ${formatDatePDF(item.date_added)} · Code: ${item.inventory_code}`, 50, footerY + 8, { width: W, align: "center" });
    doc.fill("#bbb").fontSize(7).text("400 Orchard Road #04-22 Singapore 238875 · www.leisuresports.sg", 50, footerY + 22, { width: W, align: "center" });

    doc.end();

    stream.on("finish", () => {
      res.download(pdfPath, `${item.inventory_code}.pdf`);
    });
  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ─── Stats ───
app.get("/api/stats", async (req, res) => {
  try {
    const total = await db.get("SELECT COUNT(*) as count FROM racquets");
    const available = await db.get("SELECT COUNT(*) as count FROM racquets WHERE status='Available'");
    const sold = await db.get("SELECT COUNT(*) as count FROM racquets WHERE status='Sold'");
    const value = await db.get("SELECT COALESCE(SUM(expected_price),0) as total FROM racquets WHERE status='Available'");

    res.json({
      total: Number(total?.count || 0),
      available: Number(available?.count || 0),
      sold: Number(sold?.count || 0),
      totalValue: Number(value?.total || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ───
function formatDatePDF(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function sectionHeader(doc, title, y, color) {
  doc.fill(color).fontSize(9).font("Helvetica-Bold").text(title, 60, y);
  doc.rect(60, y + 14, 470, 0.5).fill("#eee");
  return y + 22;
}

function tableRow(doc, label, value, y) {
  doc.fill("#888").fontSize(10).font("Helvetica").text(label, 70, y);
  doc.fill("#222").fontSize(10).font("Helvetica-Bold").text(value || "—", 220, y);
  return y + 20;
}

// ─── Start ───
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("  ╔══════════════════════════════════════════════╗");
    console.log(`  ║   🎾 Leisure Sports Inventory Manager         ║`);
    console.log(`  ║   Running at: http://localhost:${PORT}            ║`);
    console.log(`  ║   Mode: ${IS_RAILWAY ? "☁️  Railway (PostgreSQL)" : "💻 Local (SQLite)"}             ║`);
    console.log("  ╚══════════════════════════════════════════════╝");
    console.log("");
  });
});
