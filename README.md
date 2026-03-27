# 🎾 Leisure Sports - Racquet Inventory Manager

A standalone inventory app for **Leisure Sports** Tennis Pro Shop (est. 1978), 400 Orchard Road #04-22 Singapore.  
Manage pre-owned tennis racquets — intake, track, look up, and sell.

## Features

- **Intake Form** — Record customer details, racquet specs (brand, model, strings, condition), take photos, set price
- **Auto Inventory Code** — Each racquet gets a unique code (e.g. `TRS-K4F2-X9B`) to stick on the racquet
- **PDF Receipts** — Generate professional PDF with all racquet details, QR code, and photo. Print or email to customer
- **WhatsApp Integration** — One-click sends racquet details to customer via WhatsApp
- **Lookup** — Buyer reads code off racquet → you type it in → see everything instantly
- **Inventory Dashboard** — Browse all stock, filter by status, search by brand/model/customer
- **Mark as Sold** — Track what's available vs sold
- **Local Database** — SQLite database stored locally, no cloud needed

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (version 16 or newer)

### Setup

1. **Download/copy** this entire `tennisrack` folder to your computer

2. **Open terminal** (Command Prompt on Windows, Terminal on Mac) and navigate to the folder:
   ```bash
   cd path/to/tennisrack
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Start the app:**
   ```bash
   npm start
   ```

5. **Open browser** and go to:
   ```
   http://localhost:3000
   ```

That's it! The app is running.

### Using on your phone

Since the app runs on your local computer, you can access it from your phone too (great for taking racquet photos):

1. Find your computer's local IP address:
   - **Windows:** Open Command Prompt → type `ipconfig` → look for "IPv4 Address" (e.g. `192.168.1.100`)
   - **Mac:** System Preferences → Network → look for IP address

2. On your phone browser, go to: `http://YOUR_IP:3000`
   (e.g. `http://192.168.1.100:3000`)

Both devices must be on the same WiFi network.

## File Structure

```
tennisrack/
├── server.js          # Backend server (Express + SQLite + PDF generation)
├── package.json       # Dependencies
├── public/
│   └── index.html     # Frontend (single-page app)
├── uploads/           # Racquet photos (auto-created)
├── pdf/               # Generated PDFs (auto-created)
└── tennisrack.db      # SQLite database (auto-created on first run)
```

## How It Works

### For Sellers (customer walks in to sell a racquet):
1. Go to **＋ Intake** tab
2. Fill in customer name, phone
3. Select racquet brand → models auto-populate
4. Add string details, condition, price
5. Take a photo with your phone camera
6. Submit → get inventory code
7. **Print PDF** receipt or **WhatsApp** it to customer
8. Write/stick the inventory code on the racquet

### For Buyers (customer wants to buy a racquet):
1. Customer reads the inventory code on the racquet
2. Go to **🔍 Lookup** tab
3. Type the code → see all details, photo, price
4. When sold, click **Mark as Sold**

## Data Backup

Your database is stored in `tennisrack.db`. To back up:
- Simply copy the `tennisrack.db` file somewhere safe
- Also back up the `uploads/` folder (racquet photos)

## Troubleshooting

- **Port already in use?** Run with a different port: `PORT=3001 npm start`
- **Can't access from phone?** Make sure both devices are on same WiFi and firewall allows port 3000
- **Photos not saving?** Make sure the `uploads/` folder exists and is writable

## License

MIT — Free to use and modify.
