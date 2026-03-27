const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const initSqlJs = require("sql.js");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "tennisrack.db");
const UPLOADS_DIR = path.join(__dirname, "uploads");

// Ensure uploads dir
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
app.use("/pdf", express.static(path.join(__dirname, "pdf")));

// ─── Database Setup ───
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
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

  saveDB();
  console.log("Database initialized.");
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ─── Inventory Code Generator ───
function generateInventoryCode() {
  const prefix = "LS";
  const ts = Date.now().toString(36).toUpperCase().slice(-4);
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

// ─── API Routes ───

// Add racquet
app.post("/api/racquets", upload.single("photo"), (req, res) => {
  try {
    const b = req.body;
    const code = generateInventoryCode();
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    db.run(
      `INSERT INTO racquets (inventory_code, customer_name, customer_phone, customer_email,
        brand, model, head_size, weight, grip_size, condition,
        string_brand, string_model, string_type, string_tension,
        expected_price, notes, photo_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code, b.customer_name, b.customer_phone, b.customer_email || null,
        b.brand, b.model, b.head_size || null, b.weight || null,
        b.grip_size || null, b.condition,
        b.string_brand || null, b.string_model || null,
        b.string_type || null, b.string_tension || null,
        parseFloat(b.expected_price), b.notes || null, photoPath,
      ]
    );
    saveDB();

    const result = db.exec("SELECT * FROM racquets WHERE inventory_code = ?", [code]);
    const row = rowToObj(result);
    res.json({ success: true, racquet: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all racquets
app.get("/api/racquets", (req, res) => {
  const search = req.query.search || "";
  const status = req.query.status || "";
  let sql = "SELECT * FROM racquets WHERE 1=1";
  const params = [];

  if (search) {
    sql += ` AND (inventory_code LIKE ? OR brand LIKE ? OR model LIKE ? OR customer_name LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  sql += " ORDER BY id DESC";

  const result = db.exec(sql, params);
  res.json(rowsToArray(result));
});

// Lookup by code
app.get("/api/racquets/lookup/:code", (req, res) => {
  const result = db.exec(
    "SELECT * FROM racquets WHERE inventory_code = ?",
    [req.params.code.toUpperCase()]
  );
  const row = rowToObj(result);
  if (row) {
    res.json(row);
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

// Update status
app.patch("/api/racquets/:code/status", (req, res) => {
  const { status } = req.body;
  const dateSold = status === "Sold" ? new Date().toISOString() : null;
  db.run(
    "UPDATE racquets SET status = ?, date_sold = ? WHERE inventory_code = ?",
    [status, dateSold, req.params.code]
  );
  saveDB();
  res.json({ success: true });
});

// Delete
app.delete("/api/racquets/:code", (req, res) => {
  db.run("DELETE FROM racquets WHERE inventory_code = ?", [req.params.code]);
  saveDB();
  res.json({ success: true });
});

// ─── PDF Generation ───
app.get("/api/racquets/:code/pdf", async (req, res) => {
  const result = db.exec(
    "SELECT * FROM racquets WHERE inventory_code = ?",
    [req.params.code.toUpperCase()]
  );
  const item = rowToObj(result);
  if (!item) return res.status(404).json({ error: "Not found" });

  const pdfDir = path.join(__dirname, "pdf");
  if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

  const pdfPath = path.join(pdfDir, `${item.inventory_code}.pdf`);

  try {
    // Generate QR code
    const qrDataUrl = await QRCode.toDataURL(item.inventory_code, { width: 120, margin: 1 });
    const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    const W = doc.page.width - 100;
    const accent = "#e94560";
    const dark = "#1a1a2e";
    const gray = "#666666";

    // ── Header ──
    doc.rect(50, 50, W, 80).fill(dark);
    doc.fill("#fff").fontSize(22).font("Helvetica-Bold").text("LEISURE SPORTS", 70, 60);
    doc.fill("#c8a96e").fontSize(9).font("Helvetica").text("TENNIS PRO SHOP · EST. 1978", 70, 84);
    doc.fill("#aaa").fontSize(8).font("Helvetica").text("400 Orchard Road #04-22 Singapore 238875 · +65 6737 0656", 70, 98);
    doc.fill("#fff").fontSize(14).font("Helvetica-Bold").text(item.inventory_code, 320, 65, { width: 210, align: "right" });
    doc.fill("#c8a96e").fontSize(9).font("Helvetica").text("PRE-OWNED RACQUET RECEIPT", 320, 84, { width: 210, align: "right" });
    doc.fill("#aaa").fontSize(9).font("Helvetica").text(formatDatePDF(item.date_added), 320, 98, { width: 210, align: "right" });

    // ── QR Code ──
    doc.image(qrBuffer, W - 30, 145, { width: 80 });
    doc.fill(gray).fontSize(7).text("Scan or paste code", W - 35, 228, { width: 90, align: "center" });

    let y = 155;

    // ── Customer ──
    y = sectionHeader(doc, "CUSTOMER DETAILS", y, accent);
    y = tableRow(doc, "Name", item.customer_name, y);
    y = tableRow(doc, "Phone", item.customer_phone, y);
    y = tableRow(doc, "Email", item.customer_email || "—", y);
    y += 10;

    // ── Racquet ──
    y = sectionHeader(doc, "RACQUET DETAILS", y, accent);
    y = tableRow(doc, "Brand", item.brand, y);
    y = tableRow(doc, "Model", item.model, y);
    y = tableRow(doc, "Head Size", item.head_size ? item.head_size + " sq in" : "—", y);
    y = tableRow(doc, "Weight", item.weight ? item.weight + "g" : "—", y);
    y = tableRow(doc, "Grip Size", item.grip_size || "—", y);
    y = tableRow(doc, "Condition", item.condition, y);
    y += 10;

    // ── Strings ──
    y = sectionHeader(doc, "STRING DETAILS", y, accent);
    y = tableRow(doc, "String Brand", item.string_brand || "—", y);
    y = tableRow(doc, "String Model", item.string_model || "—", y);
    y = tableRow(doc, "String Type", item.string_type || "—", y);
    y = tableRow(doc, "Tension", item.string_tension ? item.string_tension + " lbs" : "—", y);
    y += 10;

    // ── Price ──
    y = sectionHeader(doc, "PRICING", y, accent);
    doc.rect(50, y, W, 40).fill("#f8f8f8");
    doc.fill(dark).fontSize(12).font("Helvetica").text("Expected Selling Price", 70, y + 12);
    doc.fill(accent).fontSize(18).font("Helvetica-Bold").text(`$${Number(item.expected_price).toFixed(2)}`, 300, y + 9, { width: 230, align: "right" });
    y += 50;

    if (item.notes) {
      y = sectionHeader(doc, "NOTES", y, accent);
      doc.fill(gray).fontSize(10).font("Helvetica").text(item.notes, 70, y, { width: W - 40 });
      y += doc.heightOfString(item.notes, { width: W - 40 }) + 15;
    }

    // ── Photo ──
    if (item.photo_path) {
      const absPhoto = path.join(__dirname, item.photo_path);
      if (fs.existsSync(absPhoto)) {
        if (y > 580) { doc.addPage(); y = 50; }
        y = sectionHeader(doc, "RACQUET PHOTO", y, accent);
        try {
          doc.image(absPhoto, 120, y, { fit: [350, 250] });
          y += 260;
        } catch (e) { /* skip if image can't load */ }
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
app.get("/api/stats", (req, res) => {
  const total = db.exec("SELECT COUNT(*) as c FROM racquets")[0]?.values[0][0] || 0;
  const available = db.exec("SELECT COUNT(*) as c FROM racquets WHERE status='Available'")[0]?.values[0][0] || 0;
  const sold = db.exec("SELECT COUNT(*) as c FROM racquets WHERE status='Sold'")[0]?.values[0][0] || 0;
  const totalValue = db.exec("SELECT COALESCE(SUM(expected_price),0) FROM racquets WHERE status='Available'")[0]?.values[0][0] || 0;
  res.json({ total, available, sold, totalValue });
});

// ─── Helpers ───
function rowToObj(result) {
  if (!result || !result.length || !result[0].values.length) return null;
  const cols = result[0].columns;
  const vals = result[0].values[0];
  const obj = {};
  cols.forEach((c, i) => (obj[c] = vals[i]));
  return obj;
}

function rowsToArray(result) {
  if (!result || !result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map((vals) => {
    const obj = {};
    cols.forEach((c, i) => (obj[c] = vals[i]));
    return obj;
  });
}

function formatDatePDF(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
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
  app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║   🎾 Leisure Sports Inventory Manager     ║`);
    console.log(`  ║   Running at: http://localhost:${PORT}       ║`);
    console.log(`  ║   Open this URL in your browser           ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });
});
