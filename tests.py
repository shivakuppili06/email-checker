import unittest
import json
import sqlite3
import time
from app import app, check_single_email, sanitize_csv_field, _DNS_CACHE, save_session, load_session, DB_PATH

class EmailCheckerTestCase(unittest.TestCase):
    def setUp(self):
        app.config['TESTING'] = True
        self.client = app.test_client()

    def test_routes_status(self):
        for route in ['/']:
            res = self.client.get(route)
            self.assertEqual(res.status_code, 200, f"Route {route} failed")

    def test_syntax_validation(self):
        res = check_single_email("invalid@@format..com")
        self.assertEqual(res.verdict, "UNLIKELY")
        self.assertGreaterEqual(res.confidence, 90)

    def test_disposable_domain(self):
        res = check_single_email("officer@mailinator.com")
        self.assertEqual(res.verdict, "UNLIKELY")
        self.assertTrue(res.is_disposable)

    def test_role_account_tagging(self):
        res = check_single_email("admin@google.com")
        self.assertTrue(res.is_role_account)

    def test_typo_suggestion(self):
        res = check_single_email("clerk@gmial.com")
        self.assertEqual(res.suggestion, "gmail.com")

    def test_api_check_valid_and_summary(self):
        payload = {"emails": "test@gmail.com, broken@@syntax, info@mailinator.com"}
        res = self.client.post('/api/check', json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertIn("id", data)
        self.assertIn("results", data)
        self.assertEqual(data["summary"]["total"], 3)
        self.assertEqual(data["summary"]["likely"] + data["summary"]["unlikely"] + data["summary"]["unknown"], 3)

    def test_space_separated_input(self):
        # Space-separated addresses on a single line (with multiple spaces/tabs)
        payload = {"emails": "alpha@example.com   beta@example.com\tgamma@example.com"}
        res = self.client.post('/api/check', json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["summary"]["total"], 3)
        emails = [r["email"] for r in data["results"]]
        self.assertEqual(emails, ["alpha@example.com", "beta@example.com", "gamma@example.com"])

    def test_api_check_empty_or_malformed(self):
        res1 = self.client.post('/api/check', json={"emails": ""})
        self.assertEqual(res1.status_code, 400)

        res2 = self.client.post('/api/check', data="not json", content_type="text/plain")
        self.assertEqual(res2.status_code, 415)

    def test_session_retrieval_and_permalink(self):
        payload = {"emails": "sample@gmail.com"}
        post_res = self.client.post('/api/check', json=payload)
        session_id = post_res.get_json()["id"]

        get_res = self.client.get(f'/api/results/{session_id}')
        self.assertEqual(get_res.status_code, 200)
        self.assertEqual(get_res.get_json()["id"], session_id)

        # Web page with session
        web_res = self.client.get(f'/results/{session_id}')
        self.assertEqual(web_res.status_code, 200)
        self.assertIn(f'data-session-id="{session_id}"'.encode(), web_res.data)

    def test_sqlite_sessions_multi_worker(self):
        # Simulates multiple workers/processes accessing the SQLite store independently
        worker1_session_id = "w1_test_session"
        sample_payload = {
            "id": worker1_session_id,
            "results": [{"email": "worker@test.com", "verdict": "LIKELY"}],
            "summary": {"total": 1, "likely": 1, "unlikely": 0, "unknown": 0},
            "created_at": time.time(),
        }

        # Worker 1 writes via save_session
        save_session(worker1_session_id, sample_payload)

        # Worker 2 reads from a completely fresh, separate sqlite3 connection
        conn_worker2 = sqlite3.connect(DB_PATH, timeout=5.0)
        cursor = conn_worker2.cursor()
        cursor.execute("SELECT data FROM sessions WHERE id = ?", (worker1_session_id,))
        row = cursor.fetchone()
        conn_worker2.close()

        self.assertIsNotNone(row, "Session should persist in SQLite across independent connections")
        read_payload = json.loads(row[0])
        self.assertEqual(read_payload["id"], worker1_session_id)
        self.assertEqual(read_payload["results"][0]["email"], "worker@test.com")

        # Worker 3 (Flask HTTP client) fetches it via API
        api_res = self.client.get(f'/api/results/{worker1_session_id}')
        self.assertEqual(api_res.status_code, 200)
        self.assertEqual(api_res.get_json()["id"], worker1_session_id)

    def test_session_not_found(self):
        get_res = self.client.get('/api/results/nonexistent_id')
        self.assertEqual(get_res.status_code, 404)

    def test_csv_injection_sanitization(self):
        self.assertEqual(sanitize_csv_field("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0")
        self.assertEqual(sanitize_csv_field("+1234"), "'+1234")
        self.assertEqual(sanitize_csv_field("@malicious"), "'@malicious")
        self.assertEqual(sanitize_csv_field("normal@test.com"), "normal@test.com")

    def test_export_endpoint(self):
        sample_results = [{
            "email": "user@example.com",
            "verdict": "UNKNOWN",
            "confidence": 55,
            "reasons": ["Test reason"],
            "suggestion": None,
            "is_role_account": False,
            "is_disposable": False,
            "is_catch_all": None,
            "mx_found": True
        }]
        res = self.client.post('/api/export', json={"results": sample_results})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["Content-Type"], "text/csv; charset=utf-8")
        self.assertIn(b"user@example.com", res.data)

if __name__ == '__main__':
    unittest.main()
