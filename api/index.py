import os
import sys

# Ensure root directory is on Python path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(CURRENT_DIR)

if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from app import app

class VercelPathMiddleware:
    """Ensures PATH_INFO matches the actual client requested URL on Vercel."""
    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        path_info = environ.get("PATH_INFO", "")
        # Vercel rewrites might pass /api/index instead of the requested path
        if path_info in ("/api/index", "/api/index.py", "/api", ""):
            matched = (
                environ.get("HTTP_X_MATCHED_PATH")
                or environ.get("HTTP_X_FORWARDED_URI")
                or environ.get("HTTP_X_NOW_ROUTE_MATCHES")
            )
            if matched and matched not in ("/api/index", "/api/index.py"):
                environ["PATH_INFO"] = matched
            else:
                environ["PATH_INFO"] = "/"
        return self.wsgi_app(environ, start_response)

app.wsgi_app = VercelPathMiddleware(app.wsgi_app)
