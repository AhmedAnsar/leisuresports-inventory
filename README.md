# 🎾 Leisure Sports - Racquet Inventory Manager

Inventory app for **Leisure Sports** Tennis Pro Shop (est. 1978), 400 Orchard Road #04-22 Singapore.
Manage pre-owned tennis racquets — intake, track, look up, and sell.

## Features

- **Intake Form** — Customer details, racquet specs, photo capture, pricing
- **Auto Inventory Code** — Unique code (e.g. `LS-K4F2-X9B`) to stick on racquet
- **PDF Receipts** — Professional PDF with QR code, all details, and photo
- **WhatsApp** — One-click message to customer with racquet details
- **Lookup** — Type inventory code → see everything instantly
- **Dashboard** — Browse stock, filter, search, mark as sold
- **Dual Mode** — Runs locally with SQLite OR in the cloud with PostgreSQL

---

## Option 1: Run Locally

### Prerequisites
- [Node.js](https://nodejs.org/) v18+

### Steps
```bash
cd tennisrack
npm install
npm start
```
Open **http://localhost:3000** — done!

Access from your phone (same WiFi): `http://YOUR_COMPUTER_IP:3000`

---

## Option 2: Deploy to Railway (Cloud)

This makes the app accessible from anywhere — phone, iPad, any browser.

### Step 1: Push to GitHub

Create a GitHub repo and push the code:

```bash
cd tennisrack
git init
git add .
git commit -m "Leisure Sports Inventory App"
```

Go to [github.com/new](https://github.com/new), create a new repo (e.g. `leisuresports-inventory`), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/leisuresports-inventory.git
git branch -M main
git push -u origin main
```

### Step 2: Create Railway Project

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **"New Project"**
3. Choose **"Deploy from GitHub repo"**
4. Select your `leisuresports-inventory` repo
5. Railway will auto-detect Node.js and start building

### Step 3: Add PostgreSQL Database

1. In your Railway project, click **"+ New"**
2. Select **"Database" → "Add PostgreSQL"**
3. Wait for it to provision (takes ~30 seconds)

### Step 4: Connect Database to App

1. Click on your app service (not the database)
2. Go to **"Variables"** tab
3. Click **"New Variable"**
4. Name: `DATABASE_URL`
5. Value: Click the **"Add Reference"** → select `DATABASE_URL` from the PostgreSQL service
6. Railway will auto-fill it with something like `${{Postgres.DATABASE_URL}}`

### Step 5: Add a Volume (for photo storage)

1. Click on your app service
2. Go to **"Volumes"** section (under Settings)
3. Click **"+ Add Volume"**
4. Mount path: `/data`
5. This gives persistent storage for uploaded photos

### Step 6: Add Volume Environment Variable

1. Go to **"Variables"** tab of your app service
2. Add: `RAILWAY_VOLUME_MOUNT_PATH` = `/data`

### Step 7: Generate Public URL

1. Go to **"Settings"** tab of your app service
2. Under **"Networking"**, click **"Generate Domain"**
3. You'll get a URL like `leisuresports-inventory-production.up.railway.app`

### Step 8: Open the App!

Visit your Railway URL from any device — phone, iPad, desktop.
Bookmark it on your phone home screen for quick access.

---

## File Structure

```
tennisrack/
├── server.js          # Backend (Express + SQLite/PostgreSQL + PDF)
├── package.json       # Dependencies
├── railway.json       # Railway deployment config
├── .gitignore         # Git ignore rules
├── public/
│   └── index.html     # Frontend (single-page app)
├── uploads/           # Racquet photos (local mode)
├── pdf/               # Generated PDFs (local mode)
└── tennisrack.db      # SQLite database (local mode only)
```

## How It Works

### Seller walks in:
1. **＋ Intake** → fill customer + racquet details → snap photo → submit
2. Get inventory code → print PDF or WhatsApp to customer
3. Stick code on racquet

### Buyer walks in:
1. Customer reads code off racquet
2. **🔍 Lookup** → type code → see details + photo + price
3. **Mark as Sold** when purchased

## Backup

**Local:** Copy `tennisrack.db` + `uploads/` folder
**Railway:** Database is managed by Railway (auto-backed up). Use Railway's backup feature for extra safety.

## Troubleshooting

- **Port in use locally?** `PORT=3001 npm start`
- **Railway build fails?** Check build logs in Railway dashboard
- **Photos missing after deploy?** Make sure you added the Volume (Step 5)
- **Database not connecting?** Verify `DATABASE_URL` variable references PostgreSQL correctly

## License

MIT
