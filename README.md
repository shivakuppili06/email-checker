# ✉️ Email Deliverability Checker (Postal Inspection Bureau)

A production-ready email deliverability diagnostic application branded as the **Postal Inspection Bureau**. Checks recipient addresses across a deterministic 7-stage pipeline: syntax validation, disposable-mailbox filtration, role-account tagging, typo suggestions, DNS MX resolution (with A/AAAA fallback), catch-all detection, and safe envelope SMTP probing.

Verdicts are rendered with authentic ink-stamp marks (**DELIVERED**, **RETURNED**, **UNVERIFIED**) backed by a 0–100 confidence grade and diagnostic evidence.

---

## Key Features

- **Strict Envelope-Only Probing (Safety Guaranteed):** The SMTP probe opens connection up to `RCPT TO` and terminates cleanly before `DATA`. Zero messages are ever sent or queued.
- **Single-Screen 3-Section Workspace:** 
  1. *Manifest Entry & Control Station:* Textarea input, `.csv`/`.txt` drag-and-drop import, and action stamps.
  2. *Health & Jurisdictions:* Aggregate live stamp counters, domain breakdown table, and catch-all risk flags.
  3. *Inspection Dossier:* Scrollable address audit cards with confidence scores, MX route status, and diagnostic explanations.
- **Greylisting Retry:** Temporary `4xx` responses wait ~2 seconds and retry once before falling back to `UNVERIFIED`.
- **Typo Recovery:** Fuzzy-matches misconfigured domains against popular providers (e.g. `gmial.com` &rarr; `gmail.com`).
- **Shareable Dockets:** Generates unique session IDs with lightweight permalinks (`/results/<id>`).
- **CSV Export with Formula Injection Guard:** Sanitizes cell entries starting with `=`, `+`, `-`, or `@`.
- **Accessibility & Responsive Breakdown:** Full keyboard navigation, visible focus indicators, screen reader labels, reduced-motion support, and responsive breakpoints for desktop (3-pane single-screen), tablet, and mobile.
- **Theme Switcher:** Aged Stationery Paper (Light) and Night Archive (Dark) tones with persistent preference storage.

---

## Project Structure

```
email-checker/
├── app.py                 # Flask backend, validation logic & API endpoints
├── tests.py               # Automated unit and integration test suite
├── Procfile               # Production gunicorn entrypoint
├── requirements.txt       # Python dependencies (Flask, dnspython, gunicorn)
├── README.md              # Documentation & deployment guide
├── templates/
│   ├── _nav.html          # Shared navigation bar with paper hairline rule
│   ├── index.html         # Main 3-section single-screen workspace
│   ├── how_it_works.html  # 7-stage routing rules procedural guide
│   └── about.html         # Standards, charter, and API specifications
└── static/
    ├── style.css          # Postal Inspection Bureau design system (60-30-10)
    └── app.js             # Client application, CSV parser, and UI controller
```

---

## Local Installation & Running

### Prerequisites
- Python 3.9+ installed on your system.

### Steps

1. Clone or extract the repository:
   ```bash
   cd email-checker
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Run the automated test suite:
   ```bash
   python tests.py
   ```

4. Start the local server:
   ```bash
   python app.py
   ```

5. Open your browser and navigate to:
   ```
   http://localhost:5000
   ```

---

## REST API Specification

### 1. `POST /api/check`
Submit email addresses as a delimited string or JSON array.

**Request:**
```bash
curl -X POST http://localhost:5000/api/check \
  -H "Content-Type: application/json" \
  -d '{"emails": "director@company.org\nbad@@syntax\noffice@mailinator.com"}'
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
      "email": "director@company.org",
      "verdict": "LIKELY",
      "confidence": 85,
      "reasons": ["Mail server accepted recipient envelope during live SMTP handshake."],
      "suggestion": null,
      "is_role_account": false,
      "is_disposable": false,
      "is_catch_all": false,
      "mx_found": true
    },
    {
      "email": "bad@@syntax",
      "verdict": "UNLIKELY",
      "confidence": 95,
      "reasons": ["Invalid email syntax (does not match RFC-5322 specifications)."],
      "suggestion": null,
      "is_role_account": false,
      "is_disposable": false,
      "is_catch_all": null,
      "mx_found": null
    },
    {
      "email": "office@mailinator.com",
      "verdict": "UNLIKELY",
      "confidence": 85,
      "reasons": [
        "Role-based address (e.g. info@, admin@) — functional inbox, not personal.",
        "Domain is a known disposable or temporary mail provider."
      ],
      "suggestion": null,
      "is_role_account": true,
      "is_disposable": true,
      "is_catch_all": null,
      "mx_found": null
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
Export arbitrary or verified results to a sanitized CSV file:
```bash
curl -X POST http://localhost:5000/api/export \
  -H "Content-Type: application/json" \
  -d '{"results": [...]}' \
  --output dossier.csv
```

---

## Production Deployment (e.g., Render, Railway, VPS)

### Production Start Command
```bash
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

### Port 25 Notice on Cloud Hosts
Most free-tier cloud platforms (Render, Railway, PythonAnywhere, AWS EC2 default) block outbound TCP connections on **port 25** to prevent spam relaying.
- **DNS and Local Rules (Stages 1–5):** Syntax, disposable checking, role account identification, typo suggestion, and DNS MX lookups run unaffected.
- **Live SMTP Probing (Stage 6–7):** In environments with blocked port 25, the handshake returns inconclusive and records receive an honest `UNVERIFIED` verdict.
- To enable full SMTP probing in production, deploy to a VPS (e.g. DigitalOcean, Linode, Hetzner) or request port 25 unblocking from your hosting provider.
