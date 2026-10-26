// MailCheck — Client Application
(function () {
  "use strict";

  // Core DOM Elements
  const checkBtn = document.getElementById("checkBtn");
  const exportBtn = document.getElementById("exportBtn");
  const shareBtn = document.getElementById("shareBtn");
  const sampleBtn = document.getElementById("sampleBtn");
  const clearBtn = document.getElementById("clearBtn");
  const statusEl = document.getElementById("status");
  const statusDot = document.getElementById("statusDot");
  const resultsEl = document.getElementById("results");
  const domainSummaryEl = document.getElementById("domainSummary");
  const domainCountEl = document.getElementById("domainCount");
  const fileInput = document.getElementById("fileInput");
  const fileHintBar = document.getElementById("fileHintBar");
  const fileNameHint = document.getElementById("fileName");
  const removeFileBtn = document.getElementById("removeFileBtn");
  const emailsTextarea = document.getElementById("emails");
  const emailCountBadge = document.getElementById("emailCountBadge");
  const themeToggle = document.getElementById("themeToggle");
  const dropZone = document.getElementById("dropZone");
  const searchFilter = document.getElementById("searchFilter");
  const filterTabs = document.querySelectorAll(".filter-tab");

  // State
  let lastResults = [];
  let currentSessionId = null;
  let isChecking = false;
  let activeFilter = "ALL";
  let activeSearchQuery = "";

  // Verdict Configuration
  const VERDICT_CONFIG = {
    LIKELY: {
      label: "Deliverable",
      badgeClass: "badge-valid",
      iconSvg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    },
    UNLIKELY: {
      label: "Undeliverable",
      badgeClass: "badge-invalid",
      iconSvg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    },
    UNKNOWN: {
      label: "Risky",
      badgeClass: "badge-risky",
      iconSvg: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
    },
  };

  // --- 1. Theme Management ---
  function initTheme() {
    try {
      const saved = localStorage.getItem("mailcheck_theme") || localStorage.getItem("postal_theme");
      if (saved === "dark" || saved === "light") {
        document.documentElement.setAttribute("data-theme", saved);
      } else {
        const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
      }
    } catch (e) {
      document.documentElement.setAttribute("data-theme", "light");
    }
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("mailcheck_theme", next);
      } catch (e) {
        // Ignored
      }
    });
  }

  initTheme();

  // --- 2. Live Email Counter ---
  function updateEmailCount() {
    if (!emailsTextarea || !emailCountBadge) return;
    const text = emailsTextarea.value.trim();
    if (!text) {
      emailCountBadge.textContent = "0 emails";
      return;
    }
    const count = text.split(/[\s,;]+/).filter(Boolean).length;
    emailCountBadge.textContent = `${count} email${count === 1 ? "" : "s"}`;
  }

  if (emailsTextarea) {
    emailsTextarea.addEventListener("input", updateEmailCount);
    updateEmailCount();

    // Ctrl+Enter or Cmd+Enter shortcut
    emailsTextarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (checkBtn && !isChecking) {
          checkBtn.click();
        }
      }
    });
  }

  // --- 3. Sample List Button ---
  if (sampleBtn) {
    sampleBtn.addEventListener("click", () => {
      const sampleList = [
        "alex.taylor@gmail.com",
        "invalid@@broken..com",
        "contact@mailinator.com",
        "support@gmial.com",
        "admin@github.com",
        "hello@stripe.com",
      ].join("\n");

      if (emailsTextarea) {
        emailsTextarea.value = sampleList;
        updateEmailCount();
        emailsTextarea.focus();
        updateStatus("Sample list loaded. Click 'Verify Emails' to inspect.", "ready");
      }
    });
  }

  // --- 4. Clear Button ---
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (emailsTextarea) {
        emailsTextarea.value = "";
        updateEmailCount();
        emailsTextarea.focus();
      }
      resetResults();
      if (fileInput) fileInput.value = "";
      if (fileHintBar) fileHintBar.style.display = "none";
      updateStatus("Ready to verify", "ready");
    });
  }

  function resetResults() {
    lastResults = [];
    currentSessionId = null;
    renderSummary({ total: 0, likely: 0, unlikely: 0, unknown: 0, domains: 0 });
    renderDomainSummary([]);
    renderResults([]);
    updateTabCounts([]);
    if (exportBtn) exportBtn.disabled = true;
    if (shareBtn) shareBtn.disabled = true;
  }

  // --- 5. File Parser (CSV & TXT) ---
  function parseFileText(text, isCsv) {
    if (!text || typeof text !== "string") return [];
    const lines = text.split(/\r?\n/);
    const extracted = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (isCsv) {
        let firstCol = "";
        if (line.startsWith('"')) {
          const nextQuote = line.indexOf('"', 1);
          firstCol = (nextQuote !== -1)
            ? line.substring(1, nextQuote).trim()
            : line.split(",")[0].replace(/^["']|["']$/g, "").trim();
        } else {
          firstCol = line.split(",")[0].replace(/^["']|["']$/g, "").trim();
        }

        if (firstCol && !firstCol.toLowerCase().startsWith("email")) {
          extracted.push(firstCol);
        }
      } else {
        extracted.push(line);
      }
    }
    return extracted;
  }

  function handleFile(file) {
    if (!file) return;

    const isCsv = file.name.toLowerCase().endsWith(".csv");
    const isTxt = file.name.toLowerCase().endsWith(".txt");

    if (!isCsv && !isTxt) {
      updateStatus("Please upload a .csv or .txt file.", "error");
      if (fileInput) fileInput.value = "";
      return;
    }

    if (fileNameHint && fileHintBar) {
      fileNameHint.textContent = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
      fileHintBar.style.display = "flex";
    }

    const reader = new FileReader();
    reader.onerror = () => {
      updateStatus("Failed to read the file.", "error");
    };
    reader.onload = (event) => {
      try {
        const content = event.target.result;
        const parsed = parseFileText(content, isCsv);

        if (parsed.length > 0) {
          if (emailsTextarea) {
            emailsTextarea.value = parsed.join("\n");
            updateEmailCount();
          }
          updateStatus(`Loaded ${parsed.length} address(es) from ${file.name}.`, "ready");
        } else {
          updateStatus("No valid email addresses found in file.", "error");
        }
      } catch (err) {
        updateStatus("Error parsing uploaded file.", "error");
      }
    };
    reader.readAsText(file);
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      handleFile(file);
    });
  }

  if (removeFileBtn) {
    removeFileBtn.addEventListener("click", () => {
      if (fileInput) fileInput.value = "";
      if (fileHintBar) fileHintBar.style.display = "none";
    });
  }

  // Drag and Drop
  if (dropZone) {
    ["dragenter", "dragover"].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add("drag-over");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove("drag-over");
      });
    });

    dropZone.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      const file = dt && dt.files && dt.files[0];
      if (file) {
        handleFile(file);
      }
    });
  }

  // --- 6. Status Display Helper ---
  function updateStatus(message, state = "ready") {
    if (statusEl) statusEl.textContent = message;
    if (statusDot) {
      statusDot.className = "status-indicator " + state;
    }
  }

  // --- 7. Verification Execution ---
  if (checkBtn) {
    checkBtn.addEventListener("click", async () => {
      if (isChecking) return;
      const text = emailsTextarea ? emailsTextarea.value.trim() : "";

      if (!text) {
        updateStatus("Please enter at least one email address.", "error");
        if (emailsTextarea) emailsTextarea.focus();
        return;
      }

      setLoadingState(true);
      updateStatus("Verifying mailboxes and DNS records...", "loading");

      try {
        const response = await fetch("/api/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails: text }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Server returned status ${response.status}`);
        }

        const data = await response.json();
        lastResults = Array.isArray(data.results) ? data.results : [];
        currentSessionId = data.id || null;

        displayData(data);
        updateStatus(`Verification complete: ${data.summary.total} email(s) checked.`, "ready");
      } catch (err) {
        updateStatus(`Verification error: ${err.message || "Network error"}`, "error");
      } finally {
        setLoadingState(false);
      }
    });
  }

  function setLoadingState(loading) {
    isChecking = loading;
    if (checkBtn) {
      checkBtn.disabled = loading;
      const spinner = checkBtn.querySelector(".btn-spinner");
      const label = checkBtn.querySelector(".btn-label");
      const kbd = checkBtn.querySelector(".btn-kbd");

      if (spinner) spinner.style.display = loading ? "inline-block" : "none";
      if (label) label.textContent = loading ? "Verifying..." : "Verify Emails";
      if (kbd) kbd.style.display = loading ? "none" : "inline-block";
    }
  }

  // --- 8. Export CSV ---
  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      if (!lastResults || lastResults.length === 0) return;

      try {
        exportBtn.disabled = true;
        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ results: lastResults }),
        });

        if (!res.ok) throw new Error("Failed to generate export file.");

        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = blobUrl;
        a.download = "verified_emails.csv";
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
          exportBtn.disabled = false;
        }, 150);
      } catch (e) {
        exportBtn.disabled = false;
        updateStatus("Export failed. Please check network connection.", "error");
      }
    });
  }

  // --- 9. Share Link ---
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      if (!currentSessionId) return;
      const permalink = `${window.location.origin}/results/${encodeURIComponent(currentSessionId)}`;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(permalink);
          const orig = shareBtn.innerHTML;
          shareBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span>Copied!</span>
          `;
          setTimeout(() => {
            shareBtn.innerHTML = orig;
          }, 2000);
          return;
        } catch (e) {
          // Fall through
        }
      }
      prompt("Shareable link:", permalink);
    });
  }

  // --- 10. Filter Tabs & Search ---
  filterTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      filterTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeFilter = tab.getAttribute("data-filter") || "ALL";
      applyFilters();
    });
  });

  if (searchFilter) {
    searchFilter.addEventListener("input", (e) => {
      activeSearchQuery = e.target.value.toLowerCase().trim();
      applyFilters();
    });
  }

  function applyFilters() {
    if (!lastResults || lastResults.length === 0) {
      renderResults([]);
      return;
    }

    const filtered = lastResults.filter((r) => {
      const matchFilter = (activeFilter === "ALL") || (r.verdict === activeFilter);
      const matchSearch = !activeSearchQuery || String(r.email || "").toLowerCase().includes(activeSearchQuery);
      return matchFilter && matchSearch;
    });

    renderResults(filtered);
  }

  function updateTabCounts(results) {
    const total = results.length;
    const likely = results.filter((r) => r.verdict === "LIKELY").length;
    const unlikely = results.filter((r) => r.verdict === "UNLIKELY").length;
    const unknown = results.filter((r) => r.verdict === "UNKNOWN").length;

    const elAll = document.getElementById("tabCountAll");
    const elLikely = document.getElementById("tabCountDeliverable");
    const elUnlikely = document.getElementById("tabCountUndeliverable");
    const elRisky = document.getElementById("tabCountRisky");

    if (elAll) elAll.textContent = total;
    if (elLikely) elLikely.textContent = likely;
    if (elUnlikely) elUnlikely.textContent = unlikely;
    if (elRisky) elRisky.textContent = unknown;
  }

  // --- 11. Data Display Pipeline ---
  function displayData(data) {
    renderSummary(data.summary);
    renderDomainSummary(data.results);
    updateTabCounts(data.results);
    applyFilters();

    const hasResults = Array.isArray(data.results) && data.results.length > 0;
    if (exportBtn) exportBtn.disabled = !hasResults;
    if (shareBtn) shareBtn.disabled = !hasResults || !data.id;
  }

  function renderSummary(s) {
    if (!s) return;
    const elLikely = document.getElementById("sLikely");
    const elUnlikely = document.getElementById("sUnlikely");
    const elUnknown = document.getElementById("sUnknown");
    const elTotal = document.getElementById("sTotal");
    const elDomains = document.getElementById("sDomains");

    if (elLikely) elLikely.textContent = s.likely != null ? s.likely : 0;
    if (elUnlikely) elUnlikely.textContent = s.unlikely != null ? s.unlikely : 0;
    if (elUnknown) elUnknown.textContent = s.unknown != null ? s.unknown : 0;
    if (elTotal) elTotal.textContent = s.total != null ? s.total : 0;
    if (elDomains && s.domains != null) elDomains.textContent = s.domains;
  }

  // --- 12. Domain Summary Table ---
  function renderDomainSummary(results) {
    if (!domainSummaryEl) return;
    if (!results || results.length === 0) {
      domainSummaryEl.innerHTML = `<div class="empty-subtle">Domain metrics will populate after running an inspection.</div>`;
      if (domainCountEl) domainCountEl.textContent = "0 Domains";
      const elDomains = document.getElementById("sDomains");
      if (elDomains) elDomains.textContent = "0";
      return;
    }

    const domainMap = {};
    for (const r of results) {
      const email = String(r.email || "");
      const atIdx = email.indexOf("@");
      const domain = atIdx !== -1 ? email.substring(atIdx + 1).toLowerCase() : "(invalid format)";

      if (!domainMap[domain]) {
        domainMap[domain] = {
          domain,
          total: 0,
          likely: 0,
          unlikely: 0,
          unknown: 0,
          isCatchAll: false,
        };
      }

      domainMap[domain].total += 1;
      if (r.verdict === "LIKELY") domainMap[domain].likely += 1;
      else if (r.verdict === "UNLIKELY") domainMap[domain].unlikely += 1;
      else domainMap[domain].unknown += 1;

      if (r.is_catch_all === true) {
        domainMap[domain].isCatchAll = true;
      }
    }

    const list = Object.values(domainMap).sort((a, b) => b.total - a.total);
    if (domainCountEl) {
      domainCountEl.textContent = `${list.length} Domain${list.length === 1 ? "" : "s"}`;
    }
    const elDomains = document.getElementById("sDomains");
    if (elDomains) {
      elDomains.textContent = String(list.length);
    }

    let html = `
      <table class="domain-table">
        <thead>
          <tr>
            <th>Domain Host</th>
            <th>Emails</th>
            <th>Deliverability</th>
            <th>Catch-All</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const d of list) {
      html += `
        <tr>
          <td class="domain-name">${escapeHtml(d.domain)}</td>
          <td><strong>${d.total}</strong></td>
          <td>
            <span class="pill-tag ${d.likely > 0 ? "mx-active" : ""}">${d.likely} Valid</span>
            <span class="pill-tag ${d.unlikely > 0 ? "mx-none" : ""}">${d.unlikely} Invalid</span>
            <span class="pill-tag ${d.unknown > 0 ? "tag-warning" : ""}">${d.unknown} Risky</span>
          </td>
          <td>
            ${d.isCatchAll
              ? '<span class="pill-tag tag-warning">Catch-all detected</span>'
              : '<span class="pill-tag">Standard</span>'}
          </td>
        </tr>
      `;
    }

    html += `</tbody></table>`;
    domainSummaryEl.innerHTML = html;
  }

  // --- 13. Individual Results Feed ---
  function renderResults(results) {
    if (!resultsEl) return;

    if (!results || results.length === 0) {
      if (lastResults.length > 0) {
        resultsEl.innerHTML = `
          <div class="empty-state">
            <h3 class="empty-title">No matching emails</h3>
            <p class="empty-desc">No records match the current filter or search criteria.</p>
          </div>
        `;
      } else {
        resultsEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon-circle">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h9"></path>
                <polyline points="22,6 12,13 2,6"></polyline>
                <circle cx="18" cy="18" r="3"></circle>
                <polyline points="18 16 18 18 19 19"></polyline>
              </svg>
            </div>
            <h3 class="empty-title">No email checks executed yet</h3>
            <p class="empty-desc">
              Paste recipient addresses on the left or click <strong>Sample list</strong> above to run an instant verification batch.
            </p>
          </div>
        `;
      }
      return;
    }

    const html = results.map((r) => {
      const config = VERDICT_CONFIG[r.verdict] || VERDICT_CONFIG.UNKNOWN;
      const tags = [];

      if (r.mx_found === true) {
        tags.push('<span class="pill-tag mx-active">MX Valid</span>');
      } else if (r.mx_found === false) {
        tags.push('<span class="pill-tag mx-none">No MX Record</span>');
      }

      if (r.confidence != null) {
        tags.push(`<span class="pill-tag">${r.confidence}% confidence</span>`);
      }

      if (r.is_disposable) {
        tags.push('<span class="pill-tag mx-none">Disposable</span>');
      }

      if (r.is_role_account) {
        tags.push('<span class="pill-tag tag-info">Role Account</span>');
      }

      if (r.is_catch_all === true) {
        tags.push('<span class="pill-tag tag-warning">Catch-All Host</span>');
      }

      if (r.suggestion) {
        tags.push(`<span class="pill-tag tag-warning">Did you mean ${escapeHtml(r.suggestion)}?</span>`);
      }

      const reasons = Array.isArray(r.reasons) ? r.reasons : [];

      return `
        <article class="result-item">
          <div class="result-main">
            <span class="result-email">${escapeHtml(r.email)}</span>
            <span class="badge ${config.badgeClass}">
              ${config.iconSvg}
              <span>${config.label}</span>
            </span>
          </div>

          <div class="result-meta">
            ${tags.join("")}
          </div>

          ${reasons.length > 0 ? `
            <ul class="result-reasons">
              ${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
            </ul>
          ` : ""}
        </article>
      `;
    }).join("");

    resultsEl.innerHTML = html;
  }

  // --- 14. HTML Escaping Helper ---
  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- 15. Initial Session Loader (Permalinks) ---
  async function checkInitialSession() {
    const sessionId = document.body && document.body.dataset && document.body.dataset.sessionId;
    if (!sessionId) return;

    updateStatus(`Retrieving archived docket ${sessionId}...`, "loading");
    try {
      const res = await fetch(`/api/results/${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        updateStatus("Archived record has expired or was not found.", "error");
        return;
      }
      const data = await res.json();
      lastResults = Array.isArray(data.results) ? data.results : [];
      currentSessionId = data.id || sessionId;

      if (emailsTextarea && lastResults.length > 0) {
        emailsTextarea.value = lastResults.map((r) => r.email).join("\n");
        updateEmailCount();
      }
      displayData(data);
      updateStatus(`Viewing saved verification batch: ${sessionId}`, "ready");
    } catch (e) {
      updateStatus("Failed to load saved docket.", "error");
    }
  }

  checkInitialSession();
})();
