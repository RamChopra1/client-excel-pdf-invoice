# InvoiceVault v2

Multi-client invoice management system for Greenbank Wholesale.

## Architecture

```
invoicevault-v2/
├── node-backend/        ← Express server (port 3000)
│   ├── server.js
│   ├── models/          ← MongoDB schemas
│   ├── routes/          ← API routes
│   ├── middleware/       ← Auth
│   └── public/          ← Frontend HTML
└── python-parser/       ← Flask PDF parser (port 5001)
    ├── parser.py
    └── requirements.txt
```

## Local Setup

### 1. Python Parser

```bash
cd python-parser
pip install -r requirements.txt
python parser.py
# Runs on http://localhost:5001
```

### 2. Node Backend

```bash
cd node-backend
npm install
cp .env.example .env
# Edit .env — add your MongoDB URI
npm start
# Runs on http://localhost:3000
```

### 3. Create first admin account

After starting, go to `http://localhost:3000/login.html` and sign up.
Then in MongoDB Atlas, manually set your user's `role` to `"admin"`.

## Deployment

### Python Parser → Render (free tier)
- Runtime: Python 3
- Build: `pip install -r requirements.txt`
- Start: `gunicorn parser:app`
- Set `PORT` env var

### Node Backend → Render
- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- Set env vars: `MONGODB_URI`, `JWT_SECRET`, `PYTHON_PARSER_URL` (your Python service URL)

## Features

- ✅ Multi-client with separate data per account
- ✅ Admin can see all clients and all invoices
- ✅ Server-side Python PDF parsing (coordinate-based, accurate)
- ✅ Upload single or multiple PDFs
- ✅ Duplicate invoice detection
- ✅ Export to Excel — correct Greenbank sheet structure
- ✅ Edit any invoice manually
- ✅ Dashboard with charts
- ✅ Monthly breakdown
- ✅ Client revenue breakdown
- ✅ Admin user management
