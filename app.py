"""
Postal Inspection Bureau — Email Deliverability Pipeline
--------------------------------------------------------
Provides best-effort verification of recipient email addresses.
Audits syntax, disposable providers, role mailboxes, lexical typos,
DNS MX records (with A/AAAA fallback), catch-all behavior, and safe
envelope-level SMTP probing (with retry for 4xx greylisting).

Safety Guarantee:
  Probing strictly aborts before the SMTP DATA command. Zero messages
  are ever sent, queued, or dispatched.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
import difflib
import io
import os
import random
import re
import socket
import string
import smtplib
import threading
import time
from typing import Optional
import uuid

import dns.resolver
from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__)

# RFC-5322-compliant pattern covering valid recipient syntax
EMAIL_RE = re.compile(
    r"^(?P<local>[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+)"
    r"@"
    r"(?P<domain>[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$"
)

# Common departmental / organizational mailbox prefixes
ROLE_LOCAL_PARTS = {
    "admin", "administrator", "info", "support", "sales", "contact",
    "noreply", "no-reply", "postmaster", "webmaster", "help", "billing",
    "marketing", "office", "hello", "team", "abuse", "security",
}

# Curated disposable/temporary email domains
DISPOSABLE_DOMAINS = {
    "mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com",
    "temp-mail.org", "yopmail.com", "trashmail.com", "getnada.com",
    "dispostable.com", "fakeinbox.com", "sharklasers.com", "maildrop.cc",
    "throwawaymail.com", "mintemail.com", "mohmal.com", "moakt.com",
    "tempinbox.com", "emailondeck.com", "33mail.com", "spamgourmet.com",
}

# Reference set for typographical error fuzzy matching
POPULAR_DOMAINS = [
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
    "aol.com", "live.com", "protonmail.com", "gmx.com", "zoho.com",
    "rediffmail.com", "yandex.com", "msn.com",
]

SMTP_TIMEOUT = 5
DNS_TIMEOUT = 5
MAX_EMAILS_PER_REQUEST = 200

# Thread-safe in-memory cache for DNS lookups (with TTL)
_DNS_CACHE: dict[str, tuple[float, Optional[list[tuple[int, str]]]]] = {}
_DNS_CACHE_LOCK = threading.Lock()
DNS_CACHE_TTL = 300.0  # 5 minutes

# SQLite-backed session storage for shareable dockets (FIFO-capped, multi-worker safe)
DB_PATH = os.environ.get("SESSIONS_DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "sessions.db"))
MAX_SAVED_SESSIONS = 1000
import json
import sqlite3


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db() -> None:
    conn = get_db_connection()
    try:
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);")
    finally:
        conn.close()


init_db()


def save_session(session_id: str, payload: dict) -> None:
    created_at = float(payload.get("created_at", time.time()))
    data_json = json.dumps(payload)
    conn = get_db_connection()
    try:
        with conn:
            conn.execute(
                "INSERT OR REPLACE INTO sessions (id, data, created_at) VALUES (?, ?, ?);",
                (session_id, data_json, created_at),
            )
            # Enforce FIFO cap by evicting oldest sessions if count exceeds MAX_SAVED_SESSIONS
            cursor = conn.execute("SELECT COUNT(*) FROM sessions;")
            count = cursor.fetchone()[0]
            if count > MAX_SAVED_SESSIONS:
                excess = count - MAX_SAVED_SESSIONS
                conn.execute(
                    "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions ORDER BY created_at ASC LIMIT ?);",
                    (excess,),
                )
    finally:
        conn.close()


def load_session(session_id: str) -> Optional[dict]:
    conn = get_db_connection()
    try:
        cursor = conn.execute("SELECT data FROM sessions WHERE id = ?;", (session_id,))
        row = cursor.fetchone()
        if row:
            try:
                return json.loads(row[0])
            except Exception:
                return None
    finally:
        conn.close()
    return None


@dataclass
class CheckResult:
    email: str
    verdict: str = "UNKNOWN"          # LIKELY | UNLIKELY | UNKNOWN
    confidence: int = 0               # 0-100
    reasons: list[str] = field(default_factory=list)
    suggestion: Optional[str] = None
    is_role_account: bool = False
    is_disposable: bool = False
    is_catch_all: Optional[bool] = None
    mx_found: Optional[bool] = None

    def to_dict(self) -> dict:
        return {
            "email": self.email,
            "verdict": self.verdict,
            "confidence": self.confidence,
            "reasons": self.reasons,
            "suggestion": self.suggestion,
            "is_role_account": self.is_role_account,
            "is_disposable": self.is_disposable,
            "is_catch_all": self.is_catch_all,
            "mx_found": self.mx_found,
        }


def suggest_domain(domain: str) -> Optional[str]:
    """Provides typo suggestions against common free mail providers."""
    domain = domain.lower()
    if domain in POPULAR_DOMAINS:
        return None
    matches = difflib.get_close_matches(domain, POPULAR_DOMAINS, n=1, cutoff=0.78)
    return matches[0] if matches else None


def get_mx_records(domain: str) -> Optional[list[tuple[int, str]]]:
    """
    Resolves MX records for a domain with caching.
    Returns:
      list of (preference, hostname) if found,
      [] if NXDOMAIN or no MX configured,
      None if the query failed due to a transient network/timeout error.
    """
    now = time.time()
    with _DNS_CACHE_LOCK:
        if domain in _DNS_CACHE:
            ts, records = _DNS_CACHE[domain]
            if now - ts < DNS_CACHE_TTL:
                return records

    resolver = dns.resolver.Resolver()
    resolver.lifetime = DNS_TIMEOUT
    resolver.timeout = DNS_TIMEOUT

    try:
        answers = resolver.resolve(domain, "MX")
        records = sorted(
            [(int(r.preference), str(r.exchange).rstrip(".")) for r in answers],
            key=lambda x: x[0],
        )
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        # Fallback to direct A / AAAA lookup as per RFC 5321 section 5.1
        try:
            resolver.resolve(domain, "A")
            records = [(0, domain)]
        except Exception:
            records = []
    except (dns.resolver.Timeout, dns.resolver.NoNameservers, Exception):
        records = None

    with _DNS_CACHE_LOCK:
        _DNS_CACHE[domain] = (now, records)
    return records


def random_local_part(n: int = 18) -> str:
    return "nonexistent-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def _single_smtp_rcpt(mx_host: str, mail_from: str, rcpt_to: str) -> Optional[int]:
    """Issues a clean SMTP envelope check and disconnects before DATA."""
    try:
        with smtplib.SMTP(timeout=SMTP_TIMEOUT) as smtp:
            smtp.connect(mx_host, 25)
            smtp.helo("checker.postal.local")
            smtp.mail(mail_from)
            code, _ = smtp.rcpt(rcpt_to)
            smtp.quit()
            return int(code)
    except (socket.timeout, socket.error, smtplib.SMTPException, OSError):
        return None


def smtp_probe(mx_host: str, mail_from: str, rcpt_to: str) -> Optional[bool]:
    """
    Best-effort SMTP envelope recipient check.
    Returns:
      True  -> Accepted (2xx)
      False -> Hard failure / Rejected (5xx)
      None  -> Greylisted (4xx) after retry, timeout, or blocked outbound port 25
    """
    code = _single_smtp_rcpt(mx_host, mail_from, rcpt_to)
    if code is not None:
        if 200 <= code < 300:
            return True
        if 500 <= code < 600:
            return False
        # Greylisting / temporary rate-limit: pause and retry once
        if 400 <= code < 500:
            time.sleep(2.0)
            retry_code = _single_smtp_rcpt(mx_host, mail_from, rcpt_to)
            if retry_code is not None:
                if 200 <= retry_code < 300:
                    return True
                if 500 <= retry_code < 600:
                    return False
    return None


def check_single_email(raw: str) -> CheckResult:
    email = raw.strip()
    result = CheckResult(email=email)

    m = EMAIL_RE.match(email)
    if not m:
        result.verdict = "UNLIKELY"
        result.confidence = 95
        result.reasons.append("Invalid email syntax (does not match RFC-5322 specifications).")
        return result

    local, domain = m.group("local"), m.group("domain").lower()

    if local.lower() in ROLE_LOCAL_PARTS:
        result.is_role_account = True
        result.reasons.append("Role-based address (e.g. info@, admin@) — functional inbox, not personal.")

    if domain in DISPOSABLE_DOMAINS:
        result.is_disposable = True
        result.verdict = "UNLIKELY"
        result.confidence = 85
        result.reasons.append("Domain is a known disposable or temporary mail provider.")
        return result

    suggestion = suggest_domain(domain)
    if suggestion:
        result.suggestion = suggestion
        result.reasons.append(f"Domain looks like a possible typo of '{suggestion}'.")

    mx_records = get_mx_records(domain)
    if mx_records is None:
        result.verdict = "UNKNOWN"
        result.confidence = 20
        result.reasons.append("DNS lookup failed or timed out — could not resolve destination mail server.")
        return result

    if len(mx_records) == 0:
        result.mx_found = False
        result.verdict = "UNLIKELY"
        result.confidence = 90
        result.reasons.append("Domain has no Mail Exchange (MX) or address records configured.")
        return result

    result.mx_found = True
    best_mx = mx_records[0][1]

    # Catch-all check: probe a randomized mailbox that should not exist
    probe_sender = f"probe@{socket.getfqdn() or 'postal.local'}"
    catch_all_accept = smtp_probe(best_mx, probe_sender, f"{random_local_part()}@{domain}")

    if catch_all_accept is True:
        result.is_catch_all = True
        result.verdict = "UNKNOWN"
        result.confidence = 35
        result.reasons.append(
            "Destination server accepts all incoming addresses (catch-all configuration) — "
            "individual mailbox existence cannot be confirmed without dispatch."
        )
        return result
    elif catch_all_accept is False:
        result.is_catch_all = False
    else:
        result.is_catch_all = None  # Inconclusive (e.g., outbound port 25 blocked)

    real_probe = smtp_probe(best_mx, probe_sender, email)
    if real_probe is True:
        result.verdict = "LIKELY"
        result.confidence = 85
        result.reasons.append("Mail server accepted recipient envelope during live SMTP handshake.")
    elif real_probe is False:
        result.verdict = "UNLIKELY"
        result.confidence = 90
        result.reasons.append("Mail server rejected recipient envelope during live SMTP handshake.")
    else:
        result.verdict = "UNKNOWN"
        result.confidence = 55
        result.reasons.append(
            "Domain and mail server are valid, but mailbox existence could not be confirmed "
            "(destination may greylist, or outbound port 25 is restricted by host environment)."
        )

    return result


def sanitize_csv_field(val: object) -> str:
    """Guards against CSV formula injection (starts with =, +, -, @, tab, cr)."""
    text = str(val or "")
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{text}"
    return text


# --- Web Page Routes ---
@app.route("/")
def index():
    return render_template("index.html")







@app.route("/results/<session_id>")
def view_results(session_id):
    """Renders the dashboard with preloaded archived session docket."""
    # Ensure session_id format is safe alphanumeric
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(session_id))[:32]
    return render_template("index.html", session_id=safe_id)


# --- REST API Endpoints ---
@app.route("/api/check", methods=["POST"])
def api_check():
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 415

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body format"}), 400

    raw_input = data.get("emails", "")
    if isinstance(raw_input, str):
        candidates = [e.strip() for e in re.split(r"[\s,;]+", raw_input) if e.strip()]
    elif isinstance(raw_input, list):
        candidates = [str(e).strip() for e in raw_input if str(e).strip()]
    else:
        return jsonify({"error": "'emails' must be a string or array of strings"}), 400

    if not candidates:
        return jsonify({"error": "No email addresses provided"}), 400

    # Deduplicate while preserving order, cap at MAX_EMAILS_PER_REQUEST
    candidates = list(dict.fromkeys(candidates))[:MAX_EMAILS_PER_REQUEST]

    results: list[dict] = []
    for addr in candidates:
        r = check_single_email(addr)
        results.append(r.to_dict())

    summary = {
        "total": len(results),
        "likely": sum(1 for r in results if r["verdict"] == "LIKELY"),
        "unlikely": sum(1 for r in results if r["verdict"] == "UNLIKELY"),
        "unknown": sum(1 for r in results if r["verdict"] == "UNKNOWN"),
    }

    session_id = uuid.uuid4().hex[:8]
    payload = {
        "id": session_id,
        "results": results,
        "summary": summary,
        "created_at": time.time(),
    }

    save_session(session_id, payload)

    return jsonify(payload)


@app.route("/api/results/<session_id>", methods=["GET"])
def get_session_results(session_id):
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(session_id))[:32]
    session_data = load_session(safe_id)

    if not session_data:
        return jsonify({
            "error": "Inspection record not found or expired from session cache"
        }), 404

    return jsonify(session_data)


@app.route("/api/export", methods=["POST"])
def api_export():
    """Exports results to CSV with formula injection protection."""
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 415

    data = request.get_json(silent=True) or {}
    results = data.get("results", [])

    if not isinstance(results, list):
        return jsonify({"error": "'results' must be a list"}), 400

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "Email",
        "Verdict",
        "Confidence_Percent",
        "Reasons",
        "Suggestion",
        "Is_Role_Account",
        "Is_Disposable",
        "Is_Catch_All",
        "MX_Found",
    ])

    for r in results:
        if not isinstance(r, dict):
            continue
        reasons_list = r.get("reasons", [])
        if isinstance(reasons_list, list):
            reasons_str = " | ".join(str(x) for x in reasons_list)
        else:
            reasons_str = str(reasons_list or "")

        writer.writerow([
            sanitize_csv_field(r.get("email")),
            sanitize_csv_field(r.get("verdict")),
            sanitize_csv_field(r.get("confidence")),
            sanitize_csv_field(reasons_str),
            sanitize_csv_field(r.get("suggestion") or ""),
            sanitize_csv_field(r.get("is_role_account")),
            sanitize_csv_field(r.get("is_disposable")),
            sanitize_csv_field(r.get("is_catch_all")),
            sanitize_csv_field(r.get("mx_found")),
        ])

    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=postal_inspection_dossier.csv"},
    )


if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "0") in ("1", "true", "True")
    app.run(host="0.0.0.0", port=5000, debug=debug_mode)
