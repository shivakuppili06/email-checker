# MailCheck — Bulk Email Deliverability & Verification Tool

[![Live Demo](https://img.shields.io/badge/Demo-Live%20on%20Vercel-success?style=flat&logo=vercel)](http://email-checker-henna.vercel.app/)
[![GitHub Repo](https://img.shields.io/badge/GitHub-Repository-blue?style=flat&logo=github)](https://github.com/shivakuppili06/email-checker)
[![Python Version](https://img.shields.io/badge/Python-3.9%2B-blue?logo=python)](https://python.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A fast, privacy-focused bulk email verification web application built with Python (Flask) and a modern JavaScript client. It evaluates recipient address deliverability in real-time across a multi-stage validation pipeline without ever sending an email.

---

## 🔗 Project Links

- **Live Application:** [http://email-checker-henna.vercel.app/](http://email-checker-henna.vercel.app/)
- **GitHub Repository:** [https://github.com/shivakuppili06/email-checker](https://github.com/shivakuppili06/email-checker)

---

## 🚀 Key Features

- **Strict Non-Intrusive SMTP Probing:** Handshakes negotiate through `HELO`, `MAIL FROM`, and `RCPT TO`, and cleanly terminate before the `DATA` directive. **Zero emails are ever sent or queued.**
- **Deterministic 7-Stage Pipeline:**
  1. **RFC 5322 Syntax Checking:** Verifies structural compliance and mailbox encoding rules.
  2. **Disposable Mailbox Interception:** Detects temporary throwaway providers (*e.g., Mailinator, TempMail, GuerrillaMail*).
  3. **Role Account Classification:** Identifies non-personal aliases (*e.g., admin@, support@, sales@, billing@*).
  4. **Typo Suggestions:** Fuzzy-matches misconfigured domain names against popular public providers (*e.g., `gmial.com` $\rightarrow$ `gmail.com`*).
  5. **DNS MX Record Resolution:** Resolves active Mail Exchange servers with RFC-compliant A/AAAA fallback.
  6. **Catch-All Detection:** Probes a randomized non-existent local part to identify servers that accept all incoming traffic.
  7. **Safe SMTP Handshake & Greylisting Retry:** Connects to the primary MX server to verify mailbox existence, pausing and retrying once upon temporary `4xx` responses.
- **Modern Responsive Dashboard:**
  - Real-time KPI summary cards (*Deliverable, Undeliverable, Risky, Total Checked*).
  - Search filter and status tabs (*All, Deliverable, Undeliverable, Risky*).
  - Drag-and-drop CSV / TXT list importer.
  - One-click sample list loader.
  - Domain-level deliverability breakdown table.
  - Dark / Light mode toggle.
  - CSV export with formula injection protection (*guards against `=`, `+`, `-`, `@`*).
  - Shareable docket permalinks.

---

## 📁 Project Structure

```
email-checker/
├── api/
│   └── index.py            # Vercel serverless WSGI entrypoint with path middleware
├── public/                 # Static assets served by Vercel Edge CDN
│   └── static/
│       ├── app.js
│       └── style.css
├── static/                 # Static assets served by Flask in development
│   ├── app.js              # Client controller, file parser, and live filters
│   └── style.css           # Modern SaaS stylesheet (Inter & JetBrains Mono)
├── templates/
│   ├── _nav.html           # Shared navigation header
│   └── index.html          # Main application dashboard
├── app.py                  # Core Flask backend & verification engine
├── tests.py                # Automated test suite (13 unit tests)
├── requirements.txt        # Production dependencies
├── vercel.json             # Vercel deployment configuration
├── Procfile                # Gunicorn deployment entrypoint (Heroku/Render)
└── README.md               # Documentation
```

---

## 💻 Local Installation & Setup

### Prerequisites
- Python 3.9 or higher
- Git

### 1. Clone the repository
```bash
git clone https://github.com/shivakuppili06/email-checker.git
cd email-checker
```

### 2. Create and activate a virtual environment
```bash
# On Windows (PowerShell):
python -m venv venv
.\venv\Scripts\Activate.ps1

# On macOS / Linux:
python3 -m venv venv
source venv/bin/activate
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Run automated tests
```bash
python -m pytest tests.py -v
```

### 5. Start the local server
```bash
python app.py
```
Open your browser and navigate to:
```
http://localhost:5000
```

---

## 🔌 REST API Specification

### 1. `POST /api/check`
Submit one or more email addresses for verification.

**Request:**
```bash
curl -X POST http://localhost:5000/api/check \
  -H "Content-Type: application/json" \
  -d '{"emails": "alex@gmail.com\ninvalid@@syntax\nsupport@mailinator.com"}'
```

**Response (200 OK):**
```json
{
  "id": "e4a19b8f",
  "summary": {
    "total": 3,
    "likely": 1,
    "unlikely": 2,
    "unknown": 0
  },
  "results": [
    {
      "email": "alex@gmail.com",
      "verdict": "LIKELY",
      "confidence": 85,
      "reasons": ["Mail server accepted recipient envelope during live SMTP handshake."],
      "suggestion": null,
      "is_role_account": false,
      "is_disposable": false,
      "is_catch_all": false,
      "mx_found": true
    }
  ]
}
```

### 2. `GET /api/results/<session_id>`
Retrieve stored session results:
```bash
curl http://localhost:5000/api/results/e4a19b8f
```

### 3. `POST /api/export`
Generate and download a sanitized CSV file:
```bash
curl -X POST http://localhost:5000/api/export \
  -H "Content-Type: application/json" \
  -d '{"results": [...]}' \
  --output verified_emails.csv
```

---

## 🛡️ Privacy & Safety Notice

MailCheck strictly halts all SMTP probing prior to the `DATA` command. No message payload is ever assembled, queued, or dispatched. Mailbox servers see only an envelope recipient inquiry and an immediate `QUIT`.
