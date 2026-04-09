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

// ─── Auth Configuration ───
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "LS2025!";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Public routes — no auth needed
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/pdf", express.static(PDF_DIR));
app.get("/shop", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "shop.html"));
});
app.get("/shop.html", (req, res) => res.redirect("/shop"));
app.get("/login", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Login API
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (password === LOGIN_PASSWORD) {
    const token = Buffer.from("ls_auth_" + Date.now()).toString("base64");
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Auth check for admin API routes
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ") && auth.length > 20) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

// Public API routes (no auth)
// These are defined later: /api/public/*, /health, /api/racquets/:code/pdf, /api/racquets/:code/qr

// Serve admin page (index.html) — the page itself handles auth via JS
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
app.post("/api/racquets", requireAuth, upload.single("photo"), async (req, res) => {
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
app.get("/api/racquets", requireAuth, async (req, res) => {
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
app.get("/api/racquets/lookup/:code", requireAuth, async (req, res) => {
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
app.get("/api/racquets/search-phone", requireAuth, async (req, res) => {
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
app.patch("/api/racquets/:code/status", requireAuth, async (req, res) => {
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

// Update photo
app.post("/api/racquets/:code/photo", requireAuth, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

    const code = req.params.code.toUpperCase();

    // Delete old photo if exists
    const item = await db.get(
      "SELECT photo_path FROM racquets WHERE inventory_code = ?",
      [code]
    );
    if (item && item.photo_path) {
      const oldPhoto = IS_RAILWAY
        ? path.join(RAILWAY_VOLUME, item.photo_path.replace(/^\//, ""))
        : path.join(__dirname, item.photo_path);
      if (fs.existsSync(oldPhoto)) {
        try { fs.unlinkSync(oldPhoto); } catch (e) {}
      }
    }

    // Update with new photo
    const newPath = `/uploads/${req.file.filename}`;
    await db.run(
      "UPDATE racquets SET photo_path = ? WHERE inventory_code = ?",
      [newPath, code]
    );

    res.json({ success: true, photo_path: newPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete
app.delete("/api/racquets/:code", requireAuth, async (req, res) => {
  try {
    // Get photo path before deleting
    const item = await db.get(
      "SELECT photo_path FROM racquets WHERE inventory_code = ?",
      [req.params.code]
    );

    // Delete from database
    await db.run("DELETE FROM racquets WHERE inventory_code = ?", [
      req.params.code,
    ]);

    // Delete photo file if exists
    if (item && item.photo_path) {
      const absPhoto = IS_RAILWAY
        ? path.join(RAILWAY_VOLUME, item.photo_path.replace(/^\//, ""))
        : path.join(__dirname, item.photo_path);
      if (fs.existsSync(absPhoto)) {
        try { fs.unlinkSync(absPhoto); } catch (e) {}
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Password-protected admin delete
app.post("/api/racquets/:code/admin-delete", requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== DELETE_PASSWORD) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const item = await db.get(
      "SELECT photo_path FROM racquets WHERE inventory_code = ?",
      [req.params.code]
    );
    if (!item) return res.status(404).json({ error: "Not found" });

    await db.run("DELETE FROM racquets WHERE inventory_code = ?", [
      req.params.code,
    ]);

    if (item.photo_path) {
      const absPhoto = IS_RAILWAY
        ? path.join(RAILWAY_VOLUME, item.photo_path.replace(/^\//, ""))
        : path.join(__dirname, item.photo_path);
      if (fs.existsSync(absPhoto)) {
        try { fs.unlinkSync(absPhoto); } catch (e) {}
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── QR Code for tag printing ───
app.get("/api/racquets/:code/qr", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const shopBaseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`);
    const qrUrl = `${shopBaseUrl}/shop?code=${code}`;
    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 300,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    res.json({ qr: qrDataUrl, code: code, url: qrUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tag PNG Image ───
app.get("/api/racquets/:code/tag.png", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    // Get price from database
    const item = await db.get(
      "SELECT expected_price FROM racquets WHERE inventory_code = ?",
      [code]
    );
    const price = item ? "S$" + Number(item.expected_price).toFixed(0) : "";

    // Generate a simple SVG with inventory code and price
    // Using basic SVG — no external fonts, just system defaults
    const width = 600;
    const height = 300;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="white"/>
      <rect x="10" y="10" width="${width-20}" height="${height-20}" fill="none" stroke="black" stroke-width="4" rx="8"/>
      <text x="${width/2}" y="120" font-size="72" font-weight="bold" fill="black" text-anchor="middle" font-family="sans-serif">${code}</text>
      <line x1="60" y1="160" x2="${width-60}" y2="160" stroke="black" stroke-width="2"/>
      <text x="${width/2}" y="240" font-size="80" font-weight="bold" fill="black" text-anchor="middle" font-family="sans-serif">${price}</text>
    </svg>`;

    const sharp = require("sharp");
    const png = await sharp(Buffer.from(svg)).png().toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="tag-${code}.png"`);
    res.send(png);
  } catch (err) {
    console.error("Tag error:", err);
    res.status(500).json({ error: "Tag generation failed: " + err.message });
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

    // Generate QR code linking to public shop page
    const shopBaseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`);
    const qrUrl = `${shopBaseUrl}/shop?code=${item.inventory_code}`;
    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 120,
      margin: 1,
    });
    const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

    const doc = new PDFDocument({ size: "A4", margin: 50 });

    // Stream directly to response — no file saved on server
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${item.inventory_code}.pdf"`);
    doc.pipe(res);

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
  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// ─── Admin: Reset all data ───
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "LS1978reset!";
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || "LSdelete!";

app.post("/api/admin/reset", requireAuth, async (req, res) => {
  try {
    const { confirm, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Invalid password" });
    }
    if (confirm !== "DELETE_ALL_DATA") {
      return res.status(400).json({ error: "Send { confirm: 'DELETE_ALL_DATA', password: 'your_password' } to proceed" });
    }

    // Delete all racquet records
    await db.run("DELETE FROM racquets");

    // Reset sequence for PostgreSQL
    if (IS_RAILWAY) {
      try { await db.run("ALTER SEQUENCE racquets_id_seq RESTART WITH 1"); } catch (e) {}
    }

    // Delete all uploaded photos
    if (fs.existsSync(UPLOADS_DIR)) {
      const files = fs.readdirSync(UPLOADS_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(UPLOADS_DIR, file));
      }
    }

    // Delete all generated PDFs
    if (fs.existsSync(PDF_DIR)) {
      const files = fs.readdirSync(PDF_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(PDF_DIR, file));
      }
    }

    res.json({ success: true, message: "All data, photos, and PDFs have been deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats ───
app.get("/api/stats", requireAuth, async (req, res) => {
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

// ─── Database Backup Download ───
app.get("/api/admin/backup", requireAuth, async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM racquets ORDER BY id ASC");
    const backup = {
      export_date: new Date().toISOString(),
      app: "Leisure Sports Inventory",
      total_records: rows.length,
      racquets: rows,
    };
    const filename = `leisuresports-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Storage Info (check volume) ───
app.get("/api/admin/storage", requireAuth, async (req, res) => {
  try {
    const info = {
      is_railway: IS_RAILWAY,
      uploads_dir: UPLOADS_DIR,
      volume_path: IS_RAILWAY ? RAILWAY_VOLUME : "N/A (local mode)",
      uploads: [],
    };

    if (fs.existsSync(UPLOADS_DIR)) {
      const files = fs.readdirSync(UPLOADS_DIR);
      info.uploads = files.map((f) => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, f));
        return {
          name: f,
          size_kb: Math.round(stat.size / 1024),
          created: stat.birthtime,
        };
      });
      info.total_files = files.length;
      info.total_size_mb = (
        info.uploads.reduce((sum, f) => sum + f.size_kb, 0) / 1024
      ).toFixed(2);
    } else {
      info.uploads_dir_exists = false;
    }

    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public Storefront API (no customer details) ───
app.get("/api/public/racquets", async (req, res) => {
  try {
    const search = req.query.search || "";
    let sql;
    const params = [];

    if (IS_RAILWAY) {
      sql = "SELECT inventory_code, brand, model, head_size, grip_size, expected_price, photo_path, date_added FROM racquets WHERE status = 'Available'";
      if (search) {
        sql += ` AND (inventory_code ILIKE $1 OR brand ILIKE $2 OR model ILIKE $3)`;
        const s = `%${search}%`;
        params.push(s, s, s);
      }
    } else {
      sql = "SELECT inventory_code, brand, model, head_size, grip_size, expected_price, photo_path, date_added FROM racquets WHERE status = 'Available'";
      if (search) {
        sql += ` AND (inventory_code LIKE ? OR brand LIKE ? OR model LIKE ?)`;
        const s = `%${search}%`;
        params.push(s, s, s);
      }
    }
    sql += " ORDER BY id DESC";

    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/public/racquets/:code", async (req, res) => {
  try {
    const row = await db.get(
      "SELECT inventory_code, brand, model, head_size, grip_size, expected_price, photo_path, date_added FROM racquets WHERE inventory_code = ? AND status = 'Available'",
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
