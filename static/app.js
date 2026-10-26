// Postal Inspection Bureau Client Application
(function () {
  "use strict";

  // Elements
  const checkBtn = document.getElementById("checkBtn");
  const exportBtn = document.getElementById("exportBtn");
  const shareBtn = document.getElementById("shareBtn");
  const statusEl = document.getElementById("status");
  const resultsEl = document.getElementById("results");
  const summaryEl = document.getElementById("summary");
  const domainSummaryEl = document.getElementById("domainSummary");
  const domainCountEl = document.getElementById("domainCount");
  const fileInput = document.getElementById("fileInput");
  const fileNameHint = document.getElementById("fileName");
  const emailsTextarea = document.getElementById("emails");
  const themeToggle = document.getElementById("themeToggle");

  let lastResults = [];
  let currentSessionId = null;
  let isChecking = false;

  // Clear verdict mapping for stamp badges
  const VERDICT_MAP = {
    LIKELY: "DELIVERED",
    UNLIKELY: "RETURNED",
    UNKNOWN: "UNVERIFIED",
  };

  // --- 1. Theme Management with safe fallback ---
  function initTheme() {
    try {
      const saved = localStorage.getItem("postal_theme");
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
        localStorage.setItem("postal_theme", next);
      } catch (e) {
        // Storage restricted or unavailable
      }
    });
  }

  initTheme();

  // --- 2. Reliable CSV / TXT Parser ---
  function parseFileText(text, isCsv) {
    if (!text || typeof text !== "string") return [];
    const lines = text.split(/\r?\n/);
    const extracted = [];

    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (isCsv) {
        // Parse CSV first column respecting simple quotes
        let firstCol = "";
        if (line.startsWith('"')) {
          const nextQuote = line.indexOf('"', 1);
          if (nextQuote !== -1) {
            firstCol = line.substring(1, nextQuote).trim();
          } else {
            firstCol = line.split(",")[0].replace(/^["']|["']$/g, "").trim();
          }
        } else {
          firstCol = line.split(",")[0].replace(/^["']|["']$/g, "").trim();
        }

        // Filter out header row if it contains 'email'
        if (firstCol && !firstCol.toLowerCase().startsWith("email")) {
          extracted.push(firstCol);
        }
      } else {
        // Line-by-line format for .txt
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
      updateStatus("Invalid file format. Please upload or drop a .csv or .txt manifest.", true);
      if (fileInput) fileInput.value = "";
      return;
    }

    if (fileNameHint) {
      fileNameHint.textContent = `Dossier: ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      updateStatus("Failed to read the uploaded document file.", true);
    };
    reader.onload = (event) => {
      try {
        const content = event.target.result;
        const parsed = parseFileText(content, isCsv);

        if (parsed.length > 0) {
          if (emailsTextarea) emailsTextarea.value = parsed.join("\n");
          updateStatus(`Loaded ${parsed.length} manifest entry(ies) from ${file.name}. Ready to inspect.`);
        } else {
          updateStatus("No readable entries found in the uploaded file.", true);
        }
      } catch (err) {
        updateStatus("Error parsing uploaded document.", true);
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

  if (emailsTextarea) {
    ["dragenter", "dragover"].forEach((eventName) => {
      emailsTextarea.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        emailsTextarea.classList.add("drag-hover");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      emailsTextarea.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        emailsTextarea.classList.remove("drag-hover");
      });
    });

    emailsTextarea.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      const file = dt && dt.files && dt.files[0];
      if (file) {
        handleFile(file);
      }
    });
  }

  // --- 3. Status Display Helper ---
  function updateStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = isError ? "var(--stamp-red)" : "var(--ink-muted)";
  }

  // --- 4. Verification Execution ---
  if (checkBtn) {
    checkBtn.addEventListener("click", async () => {
      if (isChecking) return;
      const text = emailsTextarea ? emailsTextarea.value.trim() : "";

      if (!text) {
        updateStatus("Please input at least one recipient address.", true);
        if (emailsTextarea) emailsTextarea.focus();
        return;
      }

      setLoadingState(true);
      updateStatus("Conducting 7-stage postal deliverability audit...");

      try {
        const response = await fetch("/api/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails: text }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Server responded with status ${response.status}`);
        }

        const data = await response.json();
        lastResults = Array.isArray(data.results) ? data.results : [];
        currentSessionId = data.id || null;

        displayData(data);
        updateStatus(`Inspection complete: ${data.summary.total} address(es) evaluated.`);
      } catch (err) {
        updateStatus(`Inspection interrupted: ${err.message || "Network error"}`, true);
      } finally {
        setLoadingState(false);
      }
    });
  }

  function setLoadingState(loading) {
    isChecking = loading;
    if (checkBtn) {
      checkBtn.disabled = loading;
      checkBtn.innerHTML = loading
        ? '<span>⏳</span> INSPECTING...'
        : 'EXECUTE INSPECTION';
    }
  }

  // --- 5. Export CSV ---
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

        if (!res.ok) throw new Error("Server failed to generate export CSV");

        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = blobUrl;
        a.download = "postal_inspection_dossier.csv";
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
          exportBtn.disabled = false;
        }, 100);
      } catch (e) {
        exportBtn.disabled = false;
        updateStatus("Export failed. Please check network connection.", true);
      }
    });
  }

  // --- 6. Share Docket Link ---
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      if (!currentSessionId) return;
      const permalink = `${window.location.origin}/results/${encodeURIComponent(currentSessionId)}`;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(permalink);
          const orig = shareBtn.innerHTML;
          shareBtn.innerHTML = "<span>✓</span> LINK COPIED";
          setTimeout(() => {
            shareBtn.innerHTML = orig;
          }, 2000);
          return;
        } catch (e) {
          // Fall through to prompt
        }
      }
      prompt("Copy docket permalink:", permalink);
    });
  }

  // --- 7. Data Display Pipeline ---
  function displayData(data) {
    renderSummary(data.summary);
    renderDomainSummary(data.results);
    renderResults(data.results);

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

  // --- 8. Domain Breakdown Table ---
  function renderDomainSummary(results) {
    if (!domainSummaryEl) return;
    if (!results || results.length === 0) {
      domainSummaryEl.innerHTML = `<div class="empty-docket-hint">Execute an inspection to populate domain routing and catch-all metrics.</div>`;
      if (domainCountEl) domainCountEl.textContent = "0 Domains";
      const elDomains = document.getElementById("sDomains");
      if (elDomains) elDomains.textContent = "0";
      return;
    }

    const domainMap = {};
    for (const r of results) {
      const email = String(r.email || "");
      const atIdx = email.indexOf("@");
      const domain = atIdx !== -1 ? email.substring(atIdx + 1).toLowerCase() : "(invalid syntax)";

      if (!domainMap[domain]) {
        domainMap[domain] = {
          domain,
          total: 0,
          delivered: 0,
          returned: 0,
          unverified: 0,
          isCatchAll: false,
        };
      }

      domainMap[domain].total += 1;
      const stamp = VERDICT_MAP[r.verdict] || "UNVERIFIED";
      if (stamp === "DELIVERED") domainMap[domain].delivered += 1;
      else if (stamp === "RETURNED") domainMap[domain].returned += 1;
      else domainMap[domain].unverified += 1;

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
      <table class="domain-table" aria-label="Domain breakdown summary table">
        <thead>
          <tr>
            <th scope="col">Domain Host</th>
            <th scope="col">Count</th>
            <th scope="col">Audit Status</th>
            <th scope="col">Catch-All Policy</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const d of list) {
      html += `
        <tr>
          <td class="domain-entry-name">${escapeHtml(d.domain)}</td>
          <td><strong>${d.total}</strong></td>
          <td>
            <span class="domain-stat-pill p-delivered" title="Likely deliverable">${d.delivered} DELIVERED</span>
            <span class="domain-stat-pill p-returned" title="Likely undeliverable">${d.returned} RETURNED</span>
            <span class="domain-stat-pill p-unverified" title="Unable to verify">${d.unverified} UNVERIFIED</span>
          </td>
          <td>
            ${d.isCatchAll
              ? '<span class="domain-catchall-stamp" title="Accepts all mailboxes; individual validity cannot be proven">CATCH-ALL HOST</span>'
              : '<span class="domain-standard-text">Standard</span>'}
          </td>
        </tr>
      `;
    }

    html += `</tbody></table>`;
    domainSummaryEl.innerHTML = html;
  }

  // --- 9. Individual Results Cards ---
  function renderResults(results) {
    if (!resultsEl) return;
    if (!results || results.length === 0) {
      resultsEl.innerHTML = `
        <div class="empty-state-card">
          <span class="empty-stamp">AWAITING MANIFEST</span>
          <p>Recipient records will populate here in real-time with authentic ink stamp verdicts, confidence grades, and diagnostic evidence.</p>
        </div>
      `;
      return;
    }

    let resultsHtml = results.map((r) => {
      const stamp = VERDICT_MAP[r.verdict] || "UNVERIFIED";
      const tags = [];
      if (r.is_role_account) tags.push("ROLE INBOX");
      if (r.is_disposable) tags.push("DISPOSABLE DOMAIN");
      if (r.is_catch_all === true) tags.push("CATCH-ALL SERVER");
      if (r.suggestion) tags.push(`TYPO CORRECTION: ${r.suggestion}`);

      let mxStatusClass = "mx-unresolved";
      let mxStatusText = "UNRESOLVED";
      if (r.mx_found === true) {
        mxStatusClass = "mx-active";
        mxStatusText = "MX: ACTIVE";
      } else if (r.mx_found === false) {
        mxStatusClass = "mx-none";
        mxStatusText = "MX: NONE";
      }

      const reasons = Array.isArray(r.reasons) ? r.reasons : [];

      return `
        <article class="result-card verdict-${stamp}" tabindex="0" aria-label="Inspection record for ${escapeHtml(r.email)}">
          <div class="result-header">
            <span class="result-email">${escapeHtml(r.email)}</span>
            <span class="verdict-stamp ${stamp}" role="status">${stamp}</span>
          </div>
          <div class="result-chip-row">
            <span class="stat-chip chip-confidence">CONFIDENCE ${Number(r.confidence || 0)}%</span>
            <span class="stat-chip chip-mx ${mxStatusClass}">${mxStatusText}</span>
          </div>
          ${reasons.length > 0 ? `
            <ul class="result-reasons">
              ${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
            </ul>
          ` : ""}
          ${tags.length > 0 ? `
            <div class="result-tags">
              ${tags.map((t) => `<span class="stamp-tag">${escapeHtml(t)}</span>`).join("")}
            </div>
          ` : ""}
        </article>
      `;
    }).join("");

    resultsHtml += `
      <div class="dossier-trailer">
        <span class="trailer-mark">END OF DISPATCH AUDIT // DIVISION 25</span>
      </div>
    `;

    resultsEl.innerHTML = resultsHtml;
  }

  // --- 10. Sanitizer Utility ---
  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- 11. Initial Session Loader (Permalinks) ---
  async function checkInitialSession() {
    const sessionId = document.body && document.body.dataset && document.body.dataset.sessionId;
    if (!sessionId) return;

    updateStatus(`Retrieving archived docket ${sessionId}...`);
    try {
      const res = await fetch(`/api/results/${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        updateStatus("Archived docket has expired or was not found.", true);
        return;
      }
      const data = await res.json();
      lastResults = Array.isArray(data.results) ? data.results : [];
      currentSessionId = data.id || sessionId;

      if (emailsTextarea && lastResults.length > 0) {
        emailsTextarea.value = lastResults.map((r) => r.email).join("\n");
      }
      displayData(data);
      updateStatus(`Viewing archived inspection docket: ${sessionId}`);
    } catch (e) {
      updateStatus("Failed to communicate with archive store.", true);
    }
  }

  checkInitialSession();
})();
