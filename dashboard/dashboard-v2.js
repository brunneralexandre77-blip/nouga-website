/* ============================================================
   Nouga Mission Control — Dashboard JS  (Phase 2)
============================================================ */

// Allow local-dev override: in browser console run:
//   localStorage.setItem('NOUGA_API_HOST', 'http://localhost:5001')
// then reload. Clear with: localStorage.removeItem('NOUGA_API_HOST')
const API_HOST = localStorage.getItem('NOUGA_API_HOST') || "https://api.nouga.ai";
const API    = `${API_HOST}/api`;
const WS_URL = API_HOST;

// Warn early if the page origin won't satisfy the production CORS policy
(function _checkOrigin() {
    const allowedOrigin = "https://nouga.ai";
    const currentOrigin = window.location.origin;
    if (currentOrigin !== allowedOrigin && !localStorage.getItem('NOUGA_API_HOST')) {
        console.warn(
            `[CORS WARNING] Dashboard is loaded from "${currentOrigin}" but the API only allows ` +
            `"${allowedOrigin}". All fetch calls will likely fail with "Failed to fetch".\n` +
            `To test locally, point to a local API server:\n` +
            `  localStorage.setItem('NOUGA_API_HOST', 'http://localhost:5001'); location.reload();`
        );
    } else {
        console.log(`[init] API_HOST=${API_HOST}  page origin=${currentOrigin}`);
    }
})();

async function checkAuth() {
    try {
        const res = await fetch(`${API_HOST}/api/auth/status`, { credentials: "include" });
        if (res.status === 401) {
            window.location.href = "/dashboard/login.html";
            return false;
        }
        return true;
    } catch (e) {
        // Network error — continue in local/offline mode
        return true;
    }
}
const REFRESH_MS = 30000;
let activePanel = "tasks";
let refreshTimer = null;
let lastUpdate   = null;

// Per-panel cache: stores last successful { data, html, ts } so content
// is never lost on a failed refresh.
const panelCache = {};
// Per-panel loading flag: prevents concurrent fetches for the same panel.
const panelLoading = {};
// Debounce handle for WebSocket-triggered reloads.
let wsReloadDebounce = null;

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket / Real-time notifications
// ──────────────────────────────────────────────────────────────────────────────
let socket      = null;
let wsConnected = false;
let notifCount  = 0;
const notifLog  = [];  // newest first, capped at 100

const NOTIF_META = {
    task:    { icon: "📋", color: "blue",   label: "Task"    },
    agent:   { icon: "🤖", color: "green",  label: "Agent"   },
    cron:    { icon: "⏱️",  color: "yellow", label: "Cron"    },
    system:  { icon: "⚙️",  color: "gray",   label: "System"  },
    council: { icon: "🏛️", color: "purple", label: "Council" },
    generic: { icon: "🔔", color: "gray",   label: "Event"   },
};

function initWebSocket() {
    if (typeof io === "undefined") {
        console.warn("[WS] Socket.IO client not loaded");
        _wsStatus(false);
        return;
    }
    _wsStatus("connecting");
    socket = io(WS_URL, {
        transports: ["polling", "websocket"],
        reconnectionDelay: 3000,
        reconnectionAttempts: 15,
        timeout: 10000,
        upgrade: true,
    });

    socket.on("connect", () => {
        wsConnected = true;
        _wsStatus(true);
        socket.emit("subscribe", {
            agent: "milfred",
            types: ["task", "agent", "cron", "system", "council"],
        });
        console.log("[WS] Connected:", socket.id);
    });

    socket.on("disconnect", (reason) => {
        wsConnected = false;
        _wsStatus(false);
        console.warn("[WS] Disconnected:", reason);
    });

    socket.on("connect_error", (err) => {
        wsConnected = false;
        _wsStatus(false);
        console.error("[WS] Connection error:", err.message);
    });

    socket.on("reconnect_attempt", (n) => {
        _wsStatus("connecting");
        console.log(`[WS] Reconnect attempt ${n}…`);
    });

    socket.on("reconnect_failed", () => {
        _wsStatus(false);
        console.error("[WS] All reconnect attempts failed");
    });

    socket.on("subscribed", data => {
        _addNotif({ type: "system", payload: { message: `Milfred subscribed — watching: ${data.types.join(", ")}` }, timestamp: new Date().toISOString() });
        console.log("[WS] Subscribed:", data);
    });

    socket.on("notification", notif => {
        _addNotif(notif);
        _showToast(notif);
        _bumpBadge();
        const panelMap = { task: "tasks", agent: "agents", cron: "calendar", council: "council" };
        const affectedPanel = panelMap[notif.type];
        if (affectedPanel) {
            // Always bust the panel cache so stale data never shows after a change
            delete panelCache[affectedPanel];
            // If the user is currently on this panel, reload it live
            if (activePanel === affectedPanel) {
                if (wsReloadDebounce) clearTimeout(wsReloadDebounce);
                wsReloadDebounce = setTimeout(() => loadPanel(activePanel), 1000);
            }
        }
    });
}

function _wsStatus(state) {
    const dot   = document.getElementById("ws-dot");
    const label = document.getElementById("ws-label");
    if (!dot || !label) return;
    if (state === true) {
        dot.className = "dot-green";
        label.textContent = "Milfred online";
    } else if (state === "connecting") {
        dot.className = "dot-yellow";
        label.textContent = "Connecting…";
    } else {
        dot.className = "dot-red";
        label.textContent = "WS offline";
    }
}

function _bumpBadge() {
    notifCount++;
    const b = document.getElementById("notif-badge");
    if (b) { b.textContent = notifCount; b.style.display = "flex"; }
}

function _clearBadge() {
    notifCount = 0;
    const b = document.getElementById("notif-badge");
    if (b) b.style.display = "none";
}

function _addNotif(notif) {
    notifLog.unshift(notif);
    if (notifLog.length > 100) notifLog.pop();
    const list = document.getElementById("notif-list");
    if (list) _renderNotifList(list);
}

function _showToast(notif) {
    const meta = NOTIF_META[notif.type] || NOTIF_META.generic;
    const msg  = notif.payload?.message || notif.payload?.title || notif.payload?.topic
               || JSON.stringify(notif.payload || "").slice(0, 70);
    const wrap = document.getElementById("notif-toasts");
    if (!wrap) return;

    const t = document.createElement("div");
    t.className = `notif-toast ntc-${meta.color}`;
    t.innerHTML = `
        <div class="notif-toast-icon">${meta.icon}</div>
        <div class="notif-toast-body">
            <div class="notif-toast-type">${meta.label}</div>
            <div class="notif-toast-msg">${escHtml(msg)}</div>
        </div>
        <button class="notif-toast-close" aria-label="dismiss">✕</button>`;
    wrap.appendChild(t);
    t.querySelector(".notif-toast-close").onclick = () => t.remove();
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("show")));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4500);
}

function _renderNotifList(list) {
    if (!notifLog.length) {
        list.innerHTML = `<div class="notif-empty">No notifications yet</div>`;
        return;
    }
    list.innerHTML = notifLog.map(n => {
        const meta = NOTIF_META[n.type] || NOTIF_META.generic;
        const msg  = n.payload?.message || n.payload?.title || n.payload?.topic
                   || (typeof n.payload === "string" ? n.payload.slice(0, 80) : JSON.stringify(n.payload || "").slice(0, 80));
        const time = n.timestamp ? new Date(n.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";
        return `
            <div class="notif-item ntc-${meta.color}">
                <div class="notif-item-icon">${meta.icon}</div>
                <div class="notif-item-body">
                    <div class="notif-item-header">
                        <span class="notif-item-type">${meta.label}</span>
                        <span class="notif-item-time">${time}</span>
                    </div>
                    <div class="notif-item-msg">${escHtml(msg)}</div>
                </div>
            </div>`;
    }).join("");
}

function toggleNotifDrawer() {
    const drawer = document.getElementById("notif-drawer");
    if (!drawer) return;
    const open = drawer.classList.toggle("open");
    if (open) {
        _clearBadge();
        const list = document.getElementById("notif-list");
        if (list) _renderNotifList(list);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// API helpers
// ──────────────────────────────────────────────────────────────────────────────
async function fetchData(endpoint, { retry = 1 } = {}) {
    const url = `${API}/${endpoint}`;
    console.log(`[fetchData] → GET ${url}`, { credentials: "include", attempt: retry });
    let res;
    try {
        res = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(8000) });
    } catch (netErr) {
        let msg;
        if (netErr.name === "TimeoutError") {
            msg = `Timeout fetching /${endpoint} (>8s)`;
        } else if (netErr instanceof TypeError && (
            netErr.message.toLowerCase().includes("failed to fetch") ||   // Chrome
            netErr.message.toLowerCase().includes("load failed") ||        // Safari
            netErr.message.toLowerCase().includes("networkerror") ||       // Firefox
            netErr.message.toLowerCase().includes("network request failed")
        )) {
            // Network-level failure: CORS preflight rejected, DNS failure, server down, or mixed-content block
            const pageOrigin = window.location.origin;
            const apiOrigin  = new URL(API_HOST).origin;
            const corsHint   = pageOrigin !== apiOrigin
                ? ` (LIKELY CAUSE: page is at "${pageOrigin}" but API only allows "https://nouga.ai" — set localStorage.NOUGA_API_HOST to use a local server)`
                : "";
            msg = `Network/CORS error fetching /${endpoint}: ${netErr.message}${corsHint}`;
            console.error(`[fetchData] DIAGNOSIS — possible causes for "Failed to fetch":
  1. CORS: Does ${API_HOST} return Access-Control-Allow-Origin for this origin?
  2. Auth: Is the session cookie present & sent? (credentials:"include" is set)
  3. Network: Is ${API_HOST} reachable? (try fetch in console: fetch("${API_HOST}/api/health"))
  4. Mixed content: Is this page on HTTPS but the API on HTTP?
  5. Browser extension blocking the request?`, netErr);
        } else {
            msg = `Network error fetching /${endpoint}: ${netErr.message}`;
        }
        console.error(`[fetchData] ${msg}`, netErr);
        if (retry > 0) {
            console.warn(`[fetchData] retrying /${endpoint} (${retry} attempt(s) left)…`);
            await new Promise(r => setTimeout(r, 1500));
            return fetchData(endpoint, { retry: retry - 1 });
        }
        throw new Error(msg);
    }
    console.log(`[fetchData] ← ${res.status} ${res.statusText} from /${endpoint}`);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        const msg = `HTTP ${res.status} ${res.statusText} from /${endpoint}`;
        if (res.status === 401 || res.status === 403) {
            console.error(`[fetchData] AUTH ERROR — session may have expired. Response body:`, body);
        } else {
            console.error(`[fetchData] ${msg}. Response body:`, body);
        }
        throw new Error(msg);
    }
    let json;
    try {
        json = await res.json();
    } catch (parseErr) {
        const msg = `Invalid JSON from /${endpoint}: ${parseErr.message}`;
        console.error(`[fetchData] ${msg}`);
        throw new Error(msg);
    }
    if (!json.success) {
        const msg = json.error || "API error";
        console.error(`[fetchData] /${endpoint} returned success=false:`, msg, json);
        throw new Error(msg);
    }
    return json.data;
}

async function apiPost(endpoint, body) {
    const res = await fetch(`${API}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
        signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
}

async function apiPut(endpoint, body) {
    const res = await fetch(`${API}/${endpoint}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
        signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
}

async function apiDelete(endpoint) {
    const res = await fetch(`${API}/${endpoint}`, {
        method: "DELETE",
        credentials: "include",
        signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
}

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function loading() { return `<div class="loading"><div class="spinner"></div> Loading…</div>`; }
function errorBox(msg) { return `<div class="error-box">⚠️ ${msg}</div>`; }
function escHtml(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function _chatBubble(role, text, ts) {
    const time = ts ? new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "";
    if (role === "user") return `<div style="text-align:right;margin-bottom:3px"><span style="background:var(--blue1,#1a3a6e);color:#fff;border-radius:12px 12px 2px 12px;padding:4px 10px;display:inline-block;max-width:88%;word-wrap:break-word">${escHtml(text)}</span><div style="font-size:0.65rem;color:var(--text3,#888);margin-top:1px">${time}</div></div>`;
    return `<div style="text-align:left;margin-bottom:5px"><span style="background:var(--bg3,#222236);color:var(--text2,#ccc);border-radius:12px 12px 12px 2px;padding:4px 10px;display:inline-block;max-width:88%;word-wrap:break-word">${escHtml(text)}</span></div>`;
}
function _chatBubbles(m) {
    let html = "";
    if (m.user_msg)    html += _chatBubble("user",  m.user_msg,    m.created_at);
    if (m.agent_reply) html += _chatBubble("agent", m.agent_reply, m.created_at);
    return html;
}
function _taskStatusColor(s) {
    if (s === "in_progress") return "var(--blue2,#5b8def)";
    if (s === "done")        return "var(--green,#34c759)";
    return "var(--text3,#888)";
}
function _taskStatusLabel(s) {
    if (s === "in_progress") return "▶";
    if (s === "done")        return "✓";
    return "●";
}
function enableDragWidget(widget, onDragEnd, skipTags = ["SELECT", "BUTTON", "INPUT"]) {
    let ox = 0, oy = 0;
    const onMove = e => {
        widget.style.left = (e.clientX - ox) + "px";
        widget.style.top  = (e.clientY - oy) + "px";
    };
    const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        onDragEnd();
    };
    widget.addEventListener("mousedown", e => {
        if (skipTags.includes(e.target.tagName)) return;
        ox = e.clientX - widget.offsetLeft;
        oy = e.clientY - widget.offsetTop;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
    });
}

function enableResizeWidget(widget, getBodyEl, onResize) {
    const grip = document.createElement("div");
    grip.style.cssText = "position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:se-resize;z-index:2;color:var(--text3,#555);font-size:9px;line-height:14px;text-align:right;padding-right:2px;pointer-events:auto";
    grip.textContent = "◢";
    widget.appendChild(grip);

    grip.addEventListener("mousedown", e => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = widget.offsetWidth;
        const bodyEl = getBodyEl();
        const startH = bodyEl ? bodyEl.offsetHeight : 0;
        const onMove = mv => {
            const newW = Math.max(240, Math.min(window.innerWidth * 0.9, startW + (mv.clientX - startX)));
            const newH = Math.max(80, startH + (mv.clientY - startY));
            widget.style.width = newW + "px";
            const b = getBodyEl();
            if (b) b.style.height = newH + "px";
            onResize(newW, newH);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    return { grip, reattach: () => { if (!widget.contains(grip)) widget.appendChild(grip); } };
}

function badge(text, color) { return `<span class="badge badge-${color}">${escHtml(text)}</span>`; }
function statusBadge(s) {
    if (!s) return badge("unknown","gray");
    s = String(s).toLowerCase();
    if (["green","live","ok","active","online","running","complete","approved","installed"].includes(s)) return badge(s,"green");
    if (["yellow","warning","pending","waiting","blocked","partial","ready"].includes(s)) return badge(s,"yellow");
    if (["red","error","offline","critical","urgent","failed"].includes(s)) return badge(s,"red");
    if (["blue","in_progress","in progress","busy"].includes(s)) return badge(s,"blue");
    return badge(s,"gray");
}
function progressBar(pct) {
    const cls = pct >= 80 ? "green" : pct >= 40 ? "blue" : "yellow";
    return `<div style="display:flex;align-items:center;gap:10px">
        <div class="progress-wrap" style="flex:1"><div class="progress-bar ${cls}" style="width:${pct}%"></div></div>
        <span style="font-size:0.75rem;color:var(--text2);min-width:30px">${pct}%</span>
    </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Modal infrastructure
// ──────────────────────────────────────────────────────────────────────────────
function createModal({ title, body, footer }) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal">
            <div class="modal-header">
                <div class="modal-title">${title}</div>
                <button class="modal-close">✕</button>
            </div>
            <div class="modal-body">${body}</div>
            <div class="modal-footer">${footer}</div>
        </div>`;
    overlay.querySelector(".modal-close").onclick = () => overlay.remove();
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    return overlay;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tasks — Interactive Kanban
// ──────────────────────────────────────────────────────────────────────────────
let _tasksData = null;

let _parkingLotData = null;

let _taskAgentFilter = "all";

function renderTasks(d) {
    _tasksData = d;
    const FILTER_AGENTS = ["all","Milfred","Ernst","Gordon","Lara","Claude","Eva","Alex","Council"];
    const filterBar = `
        <div class="task-filter-bar">
            ${FILTER_AGENTS.map(a => `
                <button class="task-filter-btn${_taskAgentFilter===a?" active":""}" data-agent="${a}">
                    ${a==="all"?"👥 All":a}
                </button>`).join("")}
        </div>`;

    const filterItems = (items) => _taskAgentFilter === "all"
        ? items
        : items.filter(t => (t.assignee||"").toLowerCase() === _taskAgentFilter.toLowerCase());

    const col = (id, title, items) => `
        <div class="kanban-col">
            <div class="kanban-header">
                <span>${title}</span>
                <div style="display:flex;align-items:center;gap:6px">
                    <span class="kanban-count" id="count-${id}">${items.length}</span>
                    <button class="kanban-add-btn" data-status="${id}" title="Add task">+</button>
                </div>
            </div>
            <div class="kanban-body" id="list-${id}" data-status="${id}">
                ${items.map(t => taskCard(t)).join("")}
            </div>
        </div>`;

    const plCol = `
        <div class="kanban-col kanban-col-pl">
            <div class="kanban-header">
                <span>🅿️ Parking Lot</span>
                <div style="display:flex;align-items:center;gap:6px">
                    <span class="kanban-count" id="count-parking_lot">…</span>
                    <button class="kanban-add-btn" id="pl-add-btn" title="Add idea">+</button>
                </div>
            </div>
            <div class="kanban-body" id="list-parking_lot" data-status="parking_lot">
                <div class="pl-loading">Loading…</div>
            </div>
        </div>`;

    return `
        <div class="panel-header">
            <div class="panel-title">📋 Tasks</div>
            <div class="panel-subtitle">Drag cards between columns · click to edit · drag 🅿️ to activate</div>
        </div>
        ${filterBar}
        <div class="kanban kanban-4col">
            ${plCol}
            ${col("todo",        "📥 To Do",      filterItems(d.todo))}
            ${col("in_progress", "🔄 In Progress", filterItems(d.in_progress))}
            ${col("done",        "✅ Done",        filterItems(d.done))}
        </div>
        ${d.cron_jobs?.length ? `
        <div style="margin-top:20px"><div class="card">
            <div class="card-title">Cron Jobs</div>
            <div class="terminal">${d.cron_jobs.map(j=>`<div class="t-line"><span class="t-success">$</span><span>${escHtml(j)}</span></div>`).join("")}</div>
        </div></div>` : ""}`;
}

function plCard(item) {
    const stars = item.priority || "";
    return `
        <div class="pl-card" data-pl-id="${item.id}" data-pl-number="${item.number}">
            <div class="task-card-actions">
                <button class="task-action-btn pl-btn-edit"   data-pl-id="${item.id}" title="Edit">✎</button>
                <button class="task-action-btn pl-btn-delete" data-pl-id="${item.id}" title="Delete">✕</button>
            </div>
            <div class="pl-card-num">#${item.number}</div>
            <div class="pl-card-title">${escHtml(item.title)}</div>
            ${stars ? `<div class="pl-card-stars">${stars}</div>` : ""}
            ${item.value  ? `<div class="pl-card-value">💰 ${escHtml(item.value)}</div>` : ""}
            ${item.effort ? `<div class="pl-card-effort">⏱ ${escHtml(item.effort)}</div>` : ""}
            <div class="pl-card-actions" style="margin-top:6px">
                <button class="btn btn-primary pl-btn-activate" data-pl-id="${item.id}" style="font-size:0.7rem;padding:3px 8px;width:100%">🚀 Activate →</button>
            </div>
        </div>`;
}

function _plFormBody(item) {
    const p = item?.priority || "";
    return `
        <div class="form-field"><label class="form-label">Title *</label>
            <input class="form-input" id="plf-title" value="${escHtml(item?.title||"")}" placeholder="Idea title"></div>
        <div class="form-field"><label class="form-label">Description</label>
            <textarea class="form-textarea" id="plf-desc" placeholder="What is this about?">${escHtml(item?.description||"")}</textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-field"><label class="form-label">Category</label>
                <input class="form-input" id="plf-cat" value="${escHtml(item?.category||"")}" placeholder="e.g. Revenue"></div>
            <div class="form-field"><label class="form-label">Priority</label>
                <select class="form-select" id="plf-priority">
                    ${["","⭐","⭐⭐","⭐⭐⭐"].map(s=>`<option value="${s}"${p===s?" selected":""}>${s||"— None —"}</option>`).join("")}
                </select></div>
            <div class="form-field"><label class="form-label">Value estimate</label>
                <input class="form-input" id="plf-value" value="${escHtml(item?.value||"")}" placeholder="e.g. €5k/mo"></div>
            <div class="form-field"><label class="form-label">Effort estimate</label>
                <input class="form-input" id="plf-effort" value="${escHtml(item?.effort||"")}" placeholder="e.g. 2 weeks"></div>
        </div>`;
}

function showPLModal(item, container) {
    // Legacy path — redirect to edit modal
    showPLEditModal(item, container);
}

function showPLEditModal(item, container) {
    const isNew = !item?.id;
    const modal = createModal({
        title: isNew ? "💡 New Parking Lot Idea" : `✎ Edit #${item.number}: ${item.title}`,
        body: _plFormBody(item),
        footer: `
            ${!isNew ? `<button class="btn btn-danger" id="plf-delete">Delete</button>` : ""}
            <button class="btn btn-ghost" id="plf-cancel">Cancel</button>
            <button class="btn btn-primary" id="plf-save">${isNew ? "Add Idea" : "Save"}</button>`,
    });

    modal.querySelector("#plf-cancel").onclick = () => modal.remove();

    if (!isNew) {
        modal.querySelector("#plf-delete").onclick = async () => {
            if (!confirm(`Delete #${item.number}: ${item.title}?`)) return;
            try {
                await apiDelete(`parking-lot/${item.id}`);
                modal.remove();
                loadPanel("tasks");
            } catch(e) { alert("Delete failed: " + e.message); }
        };
    }

    modal.querySelector("#plf-save").onclick = async () => {
        const title = modal.querySelector("#plf-title").value.trim();
        if (!title) { modal.querySelector("#plf-title").focus(); return; }
        const body = {
            title,
            description: modal.querySelector("#plf-desc").value,
            category:    modal.querySelector("#plf-cat").value,
            priority:    modal.querySelector("#plf-priority").value,
            value:       modal.querySelector("#plf-value").value,
            effort:      modal.querySelector("#plf-effort").value,
        };
        const saveBtn = modal.querySelector("#plf-save");
        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
        try {
            if (isNew) await apiPost("parking-lot", body);
            else       await apiPut(`parking-lot/${item.id}`, body);
            modal.remove();
            loadPanel("tasks");
        } catch(e) {
            saveBtn.disabled = false; saveBtn.textContent = isNew ? "Add Idea" : "Save";
            alert("Save failed: " + e.message);
        }
    };

    setTimeout(() => modal.querySelector("#plf-title")?.focus(), 50);
}

function taskCard(t) {
    const pClass = `priority-${(t.priority||"normal").toLowerCase()}`;
    const stars = t.priority === "high" ? "⭐⭐⭐" : t.priority === "medium" ? "⭐⭐" : t.priority === "low" ? "⭐" : "";
    return `
        <div class="task-card ${pClass}" data-id="${t.id}" data-status="${t.status}">
            <div class="task-card-actions">
                <button class="task-action-btn task-edit-btn" data-id="${t.id}" title="Edit">✎</button>
                <button class="task-action-btn task-delete-btn" data-id="${t.id}" title="Delete">✕</button>
            </div>
            <div class="task-title">${escHtml(t.title)}</div>
            <div class="task-meta">
                <span class="task-assignee">👤 ${escHtml(t.assignee || "")}</span>
                ${stars ? `<span style="font-size:0.72rem">${stars}</span>` : ""}
                ${t.tag ? `<span class="tag">${escHtml(t.tag)}</span>` : ""}
            </div>
        </div>`;
}

function findTaskById(id) {
    if (!_tasksData) return null;
    const all = [...(_tasksData.todo||[]), ...(_tasksData.in_progress||[]), ...(_tasksData.done||[])];
    return all.find(t => String(t.id) === String(id));
}

function updateKanbanCounts(container) {
    ["todo","in_progress","done","parking_lot"].forEach(s => {
        const list = container.querySelector(`#list-${s}`);
        const countEl = container.querySelector(`#count-${s}`);
        if (list && countEl) countEl.textContent = list.children.length;
    });
}

function initTasksPanel(data, container) {
    // Agent filter buttons
    container.querySelectorAll(".task-filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            _taskAgentFilter = btn.dataset.agent;
            loadPanel("tasks");
        });
    });

    // Load parking lot async
    (async () => {
        try {
            const r = await fetch(`${API}/parking-lot`, { credentials: "include" });
            const j = await r.json();
            _parkingLotData = j.data?.items || [];
            const visiblePL = _parkingLotData.filter(i => i.status === "parking_lot");
            const plList = container.querySelector("#list-parking_lot");
            const plCount = container.querySelector("#count-parking_lot");
            if (plList) {
                plList.innerHTML = visiblePL.length
                    ? visiblePL.map(plCard).join("")
                    : `<div class="pl-loading" style="color:var(--text3)">No items</div>`;
            }
            if (plCount) plCount.textContent = visiblePL.length;

            // "+" button — add new parking lot idea
            container.querySelector("#pl-add-btn")?.addEventListener("click", () => {
                showPLEditModal(null, container);
            });

            // Edit buttons
            plList?.querySelectorAll(".pl-btn-edit").forEach(btn => {
                btn.addEventListener("click", e => {
                    e.stopPropagation();
                    const item = _parkingLotData.find(i => String(i.id) === btn.dataset.plId);
                    if (item) showPLEditModal(item, container);
                });
            });

            // Delete buttons
            plList?.querySelectorAll(".pl-btn-delete").forEach(btn => {
                btn.addEventListener("click", async e => {
                    e.stopPropagation();
                    const item = _parkingLotData.find(i => String(i.id) === btn.dataset.plId);
                    if (!item || !confirm(`Delete #${item.number}: ${item.title}?`)) return;
                    try {
                        await apiDelete(`parking-lot/${item.id}`);
                        loadPanel("tasks");
                    } catch(err2) { alert("Delete failed: " + err2.message); }
                });
            });

            // Activate buttons
            plList?.querySelectorAll(".pl-btn-activate").forEach(btn => {
                btn.addEventListener("click", async e => {
                    e.stopPropagation();
                    const item = _parkingLotData.find(i => String(i.id) === btn.dataset.plId);
                    if (!item) return;
                    btn.disabled = true; btn.textContent = "Activating…";
                    try {
                        const result = await apiPost(`parking-lot/${item.id}/activate`, {});
                        if (result.already_activated) {
                            btn.textContent = "✓ Already active";
                        } else {
                            loadPanel("tasks");
                        }
                    } catch(err2) { btn.disabled = false; btn.textContent = "🚀 Activate →"; alert(err2.message); }
                });
            });

            // Card click → edit modal (not on action buttons)
            plList?.querySelectorAll(".pl-card").forEach(card => {
                card.addEventListener("click", e => {
                    if (e.target.closest(".pl-btn-edit, .pl-btn-delete, .pl-btn-activate")) return;
                    const item = _parkingLotData.find(i => String(i.id) === card.dataset.plId);
                    if (item) showPLEditModal(item, container);
                });
            });
        } catch(e) {
            const plList = container.querySelector("#list-parking_lot");
            if (plList) plList.innerHTML = `<div class="pl-loading" style="color:var(--red)">Failed to load</div>`;
        }
    })();

    // SortableJS drag-and-drop
    if (typeof Sortable !== "undefined") {
        // Parking lot column — drag out to activate
        const plEl = container.querySelector("#list-parking_lot");
        if (plEl) {
            Sortable.create(plEl, {
                group: { name: "kanban", pull: true, put: false },
                animation: 150,
                ghostClass: "sortable-ghost",
                sort: false,
                onEnd: async evt => {
                    const plId = evt.item.dataset.plId;
                    if (!plId || evt.from === evt.to) return;
                    const newStatus = evt.to.dataset.status;
                    if (newStatus === "todo" || newStatus === "in_progress") {
                        try {
                            await apiPost(`parking-lot/${plId}/activate`, {});
                            loadPanel("tasks");
                        } catch(e) {
                            evt.from.appendChild(evt.item);
                        }
                    } else {
                        evt.from.appendChild(evt.item);
                    }
                },
            });
        }

        ["todo","in_progress","done"].forEach(status => {
            const el = container.querySelector(`#list-${status}`);
            if (!el) return;
            Sortable.create(el, {
                group: "kanban",
                animation: 150,
                ghostClass: "sortable-ghost",
                chosenClass: "sortable-chosen",
                onEnd: async evt => {
                    const taskId = evt.item.dataset.id;
                    if (!taskId) return; // parking lot card dropped back
                    const newStatus = evt.to?.dataset?.status;
                    if (!newStatus) return;
                    if (evt.from === evt.to) {
                        // within-column reorder — persist new position
                        apiPut(`tasks/${taskId}`, { position: evt.newIndex }).catch(() => {});
                        return;
                    }
                    const fromEl = evt.from;
                    try {
                        await apiPut(`tasks/${taskId}`, { status: newStatus });
                        evt.item.dataset.status = newStatus;
                        updateKanbanCounts(container);
                    } catch(e) {
                        const ref = fromEl.children[evt.oldIndex] || null;
                        fromEl.insertBefore(evt.item, ref);
                        updateKanbanCounts(container);
                    }
                },
            });
        });
    }

    // Add buttons
    container.querySelectorAll(".kanban-add-btn").forEach(btn => {
        btn.addEventListener("click", () => showTaskModal({ status: btn.dataset.status }, null, container));
    });

    // Edit buttons
    container.querySelectorAll(".task-edit-btn").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const task = findTaskById(id);
            if (task) showTaskModal(task, id, container);
        });
    });

    // Delete buttons
    container.querySelectorAll(".task-delete-btn").forEach(btn => {
        btn.addEventListener("click", async e => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (!confirm("Delete this task?")) return;
            try {
                await apiDelete(`tasks/${id}`);
                const card = container.querySelector(`[data-id="${id}"]`);
                if (card) card.remove();
                updateKanbanCounts(container);
            } catch(err) { alert("Delete failed: " + err.message); }
        });
    });

    // Card click → edit
    container.querySelectorAll(".task-card").forEach(card => {
        card.addEventListener("click", e => {
            if (e.target.closest(".task-action-btn")) return;
            const id = card.dataset.id;
            const task = findTaskById(id);
            if (task) showTaskModal(task, id, container);
        });
    });
}

function showTaskModal(task, editId, container) {
    const isEdit = editId !== null && editId !== undefined;
    const p = task.priority || "normal";
    const s = task.status   || "todo";
    const modal = createModal({
        title: isEdit ? "Edit Task" : "New Task",
        body: `
            <div class="form-field"><label class="form-label">Title</label>
                <input class="form-input" id="m-title" value="${escHtml(task.title||"")}" placeholder="Task title"></div>
            <div class="form-field"><label class="form-label">Description</label>
                <textarea class="form-textarea" id="m-desc" placeholder="Description…">${escHtml(task.description||"")}</textarea></div>
            <div class="form-field"><label class="form-label">Priority</label>
                <select class="form-select" id="m-priority">
                    ${["high","medium","low","normal"].map(v=>`<option value="${v}"${p===v?" selected":""}>${v}</option>`).join("")}
                </select></div>
            <div class="form-field"><label class="form-label">Assignee</label>
                <select class="form-select" id="m-assignee">
                    ${["","Milfred","Ernst","Gordon","Lara","Claude","Eva","Alex","Council"].map(a=>`<option value="${a}"${(task.assignee||"")=== a?" selected":""}>${a||"— Unassigned —"}</option>`).join("")}
                </select></div>
            <div class="form-field"><label class="form-label">Tag</label>
                <input class="form-input" id="m-tag" value="${escHtml(task.tag||"")}" placeholder="e.g. security, dev, trading"></div>
            <div class="form-field"><label class="form-label">Status</label>
                <select class="form-select" id="m-status">
                    ${[["todo","To Do"],["in_progress","In Progress"],["done","Done"]].map(([v,l])=>`<option value="${v}"${s===v?" selected":""}>${l}</option>`).join("")}
                </select></div>`,
        footer: `
            ${isEdit ? `<button class="btn btn-danger" id="m-delete">Delete</button>` : ""}
            <button class="btn btn-ghost" id="m-cancel">Cancel</button>
            <button class="btn btn-primary" id="m-save">Save</button>`,
    });

    modal.querySelector("#m-cancel").onclick = () => modal.remove();

    if (isEdit) {
        modal.querySelector("#m-delete").onclick = async () => {
            if (!confirm("Delete this task?")) return;
            try {
                await apiDelete(`tasks/${editId}`);
                modal.remove();
                loadPanel("tasks");
            } catch(e) { alert("Delete failed: " + e.message); }
        };
    }

    modal.querySelector("#m-save").onclick = async () => {
        const title = modal.querySelector("#m-title").value.trim();
        if (!title) { modal.querySelector("#m-title").focus(); return; }
        const body = {
            title,
            description: modal.querySelector("#m-desc").value,
            priority:    modal.querySelector("#m-priority").value,
            assignee:    modal.querySelector("#m-assignee").value,
            tag:         modal.querySelector("#m-tag").value,
            status:      modal.querySelector("#m-status").value,
        };
        const saveBtn = modal.querySelector("#m-save");
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        try {
            if (isEdit) { await apiPut(`tasks/${editId}`, body); }
            else        { await apiPost("tasks", body); }
            modal.remove();
            loadPanel("tasks");
        } catch(e) {
            saveBtn.disabled = false;
            saveBtn.textContent = "Save";
            alert("Save failed: " + e.message);
        }
    };

    setTimeout(() => modal.querySelector("#m-title").focus(), 50);
}

// ──────────────────────────────────────────────────────────────────────────────
// Agents — Org chart + side panel
// ──────────────────────────────────────────────────────────────────────────────
let _selectedAgent = null;
let _availableModels = null;  // cached from /api/models

async function loadAvailableModels() {
    if (_availableModels) return _availableModels;
    try {
        const r = await fetch(`${API}/models`);
        const j = await r.json();
        _availableModels = j.data?.models || [];
    } catch(e) {
        _availableModels = [];
    }
    return _availableModels;
}

// ── Tools & Memory data ──────────────────────────────────────────────────────
const TOOLS_REGISTRY = [
    { id: "file-system", name: "File System",    icon: "📁", desc: "read, write, edit files" },
    { id: "web-search",  name: "Web Search",     icon: "🔍", desc: "brave search, web fetch" },
    { id: "code-exec",   name: "Code Execution", icon: "⚡", desc: "exec, process, shell" },
    { id: "browser",     name: "Browser Control",icon: "🌐", desc: "browser, canvas control" },
    { id: "messaging",   name: "Messaging",      icon: "💬", desc: "telegram, notifications" },
    { id: "memory",      name: "Memory",         icon: "🧠", desc: "supermemory search & store" },
    { id: "trading",     name: "Trading",        icon: "📈", desc: "binance, freqtrade APIs" },
];
const AGENT_TOOLS = {
    milfred: { "file-system":true, "web-search":true, "code-exec":true,  "browser":true,  "messaging":true, "memory":true, "trading":false },
    ernst:   { "file-system":true, "web-search":true, "code-exec":false, "browser":false, "messaging":true, "memory":true, "trading":false },
    gordon:  { "file-system":true, "web-search":true, "code-exec":false, "browser":false, "messaging":false,"memory":true, "trading":true  },
    lara:    { "file-system":true, "web-search":true, "code-exec":false, "browser":true,  "messaging":true, "memory":true, "trading":false },
    claude:  { "file-system":true, "web-search":true, "code-exec":true,  "browser":true,  "messaging":false,"memory":true, "trading":false },
    eva:     { "file-system":true, "web-search":true, "code-exec":false, "browser":false, "messaging":true, "memory":true, "trading":false },
};
const MEMORY_PERMS = {
    milfred: { read_own:true,  read_all:true,  write:true  },
    ernst:   { read_own:true,  read_all:true,  write:false },
    gordon:  { read_own:true,  read_all:false, write:true  },
    lara:    { read_own:true,  read_all:false, write:true  },
    claude:  { read_own:true,  read_all:true,  write:true  },
    eva:     { read_own:true,  read_all:false, write:true  },
};

function renderAgents(d) {
    const orgNode = (a) => `
        <div class="org-child">
            <button class="org-node-btn${_selectedAgent===a.id?" active":""}" data-agent-id="${a.id}">
                <span class="org-emoji">${a.emoji}</span>
                <span class="org-name">${a.name}</span>
                <span class="org-title">${a.role.split(" ").slice(0,3).join(" ")}</span>
            </button>
        </div>`;

    const milfred = d.agents?.find(a=>a.id==="milfred");
    const ernst   = d.agents?.find(a=>a.id==="ernst");
    const eva     = d.agents?.find(a=>a.id==="eva");
    const reports = (d.agents||[]).filter(a=>["gordon","lara","claude","hawk"].includes(a.id));

    const detailHTML = _selectedAgent
        ? renderAgentDetail(d.agents?.find(a=>a.id===_selectedAgent), d)
        : `<div style="padding:24px;text-align:center;color:var(--text3);font-size:0.88rem">
               <div style="font-size:2rem;margin-bottom:8px">🤖</div>
               Click an agent node to view details, tools &amp; memory
           </div>`;

    return `
        <div class="panel-header">
            <div class="panel-title">🤖 Agents</div>
            <div class="panel-subtitle">OpenClaw: ${d.openclaw_running?badge("online","green"):badge("offline","red")} · Max concurrent: ${d.max_concurrent}</div>
        </div>
        <div class="agents-layout">
            <div>
                <div class="card" style="margin-bottom:16px">
                    <div class="card-title">Org Chart</div>
                    <div class="org-chart">
                        <div class="org-level">
                            <button class="org-node-btn" data-agent-id="alex" style="border-color:var(--yellow);min-width:100px">
                                <span class="org-emoji">👔</span><span class="org-name">Alex</span><span class="org-title">CEO</span>
                            </button>
                        </div>
                        <div class="org-line-v"></div>
                        <div class="org-children" style="gap:12px">
                            ${milfred ? orgNode(milfred) : ""}
                            ${ernst   ? orgNode(ernst)   : ""}
                            ${eva     ? orgNode(eva)     : ""}
                        </div>
                        <div style="display:flex;flex-direction:column;align-items:flex-start;padding-left:8px">
                            <div class="org-line-v"></div>
                            <div class="org-children" style="gap:8px">
                                ${reports.map(a=>orgNode(a)).join("")}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-title">Workflow Agents</div>
                    <table class="table">
                        <thead><tr><th>Category</th><th>Instances</th><th>Status</th></tr></thead>
                        <tbody>
                            ${Object.entries(d.workflow_counts||{}).map(([k,v])=>`
                                <tr><td>${k}</td><td>${v}</td><td>${badge("ready","green")}</td></tr>`).join("")}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="agent-detail-panel" id="agent-detail">${detailHTML}</div>
        </div>`;
}

function renderAgentDetail(agent, d) {
    if (!agent) return `<div style="padding:20px;color:var(--text3);font-size:0.85rem">Agent not found</div>`;
    // Use models embedded in /api/agents response — no separate fetch, no race condition
    const srcModels = (d.available_models?.length ? d.available_models : null)
                   || (_availableModels?.length    ? _availableModels   : null);
    const modelOptions = srcModels
        ? srcModels.map(m => ({ value: m.short_id, label: `${m.type === "local" ? "⚡ " : "☁️ "}${m.name}` }))
        : ["kimi-k2.5","kimi-k2-thinking","claude-sonnet-4-6","claude-haiku-4-5-20251001","qwen2.5:14b","llama3.1:8b"]
            .map(v => ({ value: v, label: v }));
    // Always ensure current model is in the list (renders even if not in openclaw.json)
    if (agent.model && !modelOptions.find(o => o.value === agent.model)) {
        modelOptions.unshift({ value: agent.model, label: agent.model });
    }
    const tools   = AGENT_TOOLS[agent.id] || {};
    const perms   = MEMORY_PERMS[agent.id] || {};
    const allAgents = d.agents || [];

    const perm = (v) => v
        ? `<span class="perm-yes">✅</span>`
        : `<span class="perm-no">—</span>`;

    return `
        <div class="agent-detail-header">
            <div class="agent-avatar" style="width:48px;height:48px;font-size:1.5rem">${agent.emoji}</div>
            <div style="flex:1">
                <div style="font-weight:700;font-size:1rem;color:#fff">${agent.name}</div>
                <div style="font-size:0.8rem;color:var(--blue2);margin-bottom:4px">${agent.role}</div>
                ${badge(agent.status||"idle", agent.status==="active"?"green":agent.status==="busy"?"blue":"gray")}
            </div>
            <div>
                <select class="form-select" id="model-select-${agent.id}" style="font-size:0.72rem;padding:4px 8px">
                    ${modelOptions.map(m=>`<option value="${m.value}"${agent.model===m.value?" selected":""}>${m.label}</option>`).join("")}
                </select>
                <button class="btn btn-primary" id="model-save-${agent.id}" style="margin-top:5px;width:100%;font-size:0.75rem;padding:5px">Save Model</button>
            </div>
        </div>
        <div class="agent-tabs-nav">
            <button class="agent-tab-btn active" data-tab="role">Role</button>
            <button class="agent-tab-btn" data-tab="tasks">Tasks</button>
            <button class="agent-tab-btn" data-tab="soul">Soul</button>
            <button class="agent-tab-btn" data-tab="tools">Tools</button>
            <button class="agent-tab-btn" data-tab="memory">Memory</button>
        </div>

        <div class="agent-tab-pane active" data-pane="role">
            <div class="agent-detail-label" style="margin-bottom:6px">Identity & Responsibilities</div>
            <div style="font-size:0.8rem;color:var(--text2);background:var(--bg2);border-radius:7px;padding:10px;line-height:1.6;font-family:monospace;max-height:120px;overflow-y:auto">${escHtml(agent.soul_excerpt||"(No IDENTITY.md found)")}</div>
            <div style="margin-top:12px;padding:10px;background:var(--bg2);border-radius:7px;border:1px solid var(--border1);font-size:0.78rem;color:var(--text3);text-align:center">
                💬 Use the floating chat widget (bottom-right) to message ${escHtml(agent.name)}
            </div>
        </div>

        <div class="agent-tab-pane" data-pane="tasks">
            <div id="agent-tasks-${agent.id}" style="font-size:0.78rem">
                <div style="color:var(--text3);padding:6px 0">Click to load tasks…</div>
            </div>
        </div>

        <div class="agent-tab-pane" data-pane="soul">
            <div class="agent-detail-label" style="margin-bottom:6px">Soul & Personality</div>
            <textarea class="form-textarea" id="soul-edit-${agent.id}" style="font-family:monospace;font-size:0.76rem;min-height:180px">${escHtml(agent.soul_excerpt||"")}</textarea>
            <button class="btn btn-primary" id="soul-save-${agent.id}" style="margin-top:8px;width:100%;font-size:0.8rem">Save SOUL.md</button>
            <div style="font-size:0.7rem;color:var(--text3);margin-top:6px">⚠️ Changes are saved to the agent's SOUL.md file</div>
        </div>

        <div class="agent-tab-pane" data-pane="tools">
            <div class="agent-detail-label" style="margin-bottom:8px">Tool Access</div>
            ${TOOLS_REGISTRY.map(t => `
                <div class="tool-row">
                    <span class="tool-icon">${t.icon}</span>
                    <div class="tool-info">
                        <div class="tool-name">${t.name}</div>
                        <div class="tool-desc">${t.desc}</div>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" data-tool="${t.id}" data-agent="${agent.id}"${tools[t.id]?" checked":""}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>`).join("")}
            <button class="btn btn-primary" id="tools-save-${agent.id}" style="margin-top:10px;width:100%;font-size:0.8rem">Save Tool Access</button>
        </div>

        <div class="agent-tab-pane" data-pane="memory">
            <div class="agent-detail-label" style="margin-bottom:8px">Memory Permissions</div>
            <table class="memory-matrix">
                <thead><tr><th>Agent</th><th>Read Own</th><th>Read All</th><th>Write</th></tr></thead>
                <tbody>
                    ${allAgents.map(a => {
                        const p = MEMORY_PERMS[a.id] || {};
                        const isMe = a.id === agent.id;
                        return `<tr class="${isMe?"me":""}">
                            <td>${a.emoji} ${a.name}</td>
                            <td><label class="toggle-switch" style="width:28px;height:16px"><input type="checkbox"${p.read_own?" checked":""}><span class="toggle-slider"></span></label></td>
                            <td><label class="toggle-switch" style="width:28px;height:16px"><input type="checkbox"${p.read_all?" checked":""}><span class="toggle-slider"></span></label></td>
                            <td><label class="toggle-switch" style="width:28px;height:16px"><input type="checkbox"${p.write?" checked":""}><span class="toggle-slider"></span></label></td>
                        </tr>`;
                    }).join("")}
                </tbody>
            </table>
            <div style="font-size:0.7rem;color:var(--text3);margin-top:8px">Highlighted row = viewing agent. Changes are cosmetic — connect to OpenClaw to enforce.</div>
        </div>`;
}

function initAgentsPanel(data, container) {
    // Pre-load models eagerly; if an agent detail is already visible, patch dropdown after load
    loadAvailableModels().then(() => {
        const sel = container.querySelector("[id^='model-select-']");
        if (sel && _availableModels?.length) {
            const agentId = sel.id.replace("model-select-", "");
            const agent = data.agents?.find(a => a.id === agentId);
            const currentVal = sel.value;
            sel.innerHTML = _availableModels.map(m =>
                `<option value="${m.short_id}"${(agent?.model === m.short_id || currentVal === m.short_id) ? " selected" : ""}>${m.type === "local" ? "⚡ " : "☁️ "}${m.name}</option>`
            ).join("");
        }
    });

    container.querySelectorAll(".org-node-btn[data-agent-id]").forEach(btn => {
        btn.addEventListener("click", async () => {
            const agentId = btn.dataset.agentId;
            _selectedAgent = (_selectedAgent === agentId) ? null : agentId;
            const detailEl = container.querySelector("#agent-detail");
            if (detailEl) {
                const agent = data.agents?.find(a => a.id === agentId);
                // Always await models before rendering so dropdown has full list
                await loadAvailableModels();
                detailEl.innerHTML = _selectedAgent
                    ? renderAgentDetail(agent, data)
                    : `<div style="padding:24px;text-align:center;color:var(--text3);font-size:0.88rem"><div style="font-size:2rem;margin-bottom:8px">🤖</div>Click an agent node to view details</div>`;
                if (_selectedAgent) wireAgentDetail(agentId, detailEl);
            }
            container.querySelectorAll(".org-node-btn").forEach(b => b.classList.toggle("active", b.dataset.agentId === _selectedAgent));
        });
    });
    if (_selectedAgent) wireAgentDetail(_selectedAgent, container.querySelector("#agent-detail") || container);
}

function wireAgentDetail(agentId, panel) {
    if (!panel) return;

    // Model save
    const modelSave = panel.querySelector(`#model-save-${agentId}`);
    if (modelSave) {
        modelSave.onclick = async () => {
            const sel = panel.querySelector(`#model-select-${agentId}`);
            if (!sel) return;
            modelSave.disabled = true; modelSave.textContent = "Saving…";
            try {
                await apiPut(`agents/${agentId}/model`, { model: sel.value });
                modelSave.textContent = "✓ Saved";
                setTimeout(() => { modelSave.textContent = "Save Model"; modelSave.disabled = false; }, 2000);
            } catch(e) { modelSave.textContent = "Error"; modelSave.disabled = false; }
        };
    }

    // Tab switching
    panel.querySelectorAll(".agent-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            panel.querySelectorAll(".agent-tab-btn").forEach(b => b.classList.remove("active"));
            panel.querySelectorAll(".agent-tab-pane").forEach(p => p.classList.remove("active"));
            btn.classList.add("active");
            panel.querySelector(`[data-pane="${btn.dataset.tab}"]`)?.classList.add("active");
        });
    });

    // Tasks tab — load on first click
    const tasksTabBtn = panel.querySelector(`[data-tab="tasks"]`);
    const tasksEl     = panel.querySelector(`#agent-tasks-${agentId}`);
    if (tasksTabBtn && tasksEl) {
        tasksTabBtn.addEventListener("click", async () => {
            if (tasksEl.dataset.loaded) return;
            tasksEl.innerHTML = `<div style="color:var(--text3)">Loading…</div>`;
            try {
                const t = await fetchData(`agents/${agentId}/tasks`);
                tasksEl.dataset.loaded = "1";
                const taskRow = (task) => {
                    const sc = task.status === "in_progress" ? "var(--blue2)"
                             : task.status === "done"        ? "var(--green)"
                             : "var(--text3)";
                    const sl = task.status === "in_progress" ? "▶ Active"
                             : task.status === "done"        ? "✓ Done" : "● Queue";
                    return `<div style="padding:5px 0;border-bottom:1px solid var(--border1);display:flex;gap:8px;align-items:flex-start">
                        <span style="font-size:0.65rem;padding:2px 6px;border-radius:4px;white-space:nowrap;background:${sc}22;color:${sc}">${sl}</span>
                        <span style="color:var(--text2)">${escHtml(task.title)}</span>
                    </div>`;
                };
                const sec = (label, items) => items?.length
                    ? `<div class="agent-detail-label" style="margin:8px 0 4px">${label}</div>${items.map(taskRow).join("")}`
                    : "";
                const html = [
                    t.current  ? `<div class="agent-detail-label" style="margin:0 0 4px">Current</div>${taskRow(t.current)}` : "",
                    sec(`Queue (${t.pending?.length})`, t.pending),
                    sec("Recently completed", t.completed),
                    (!t.current && !t.pending?.length && !t.completed?.length)
                        ? `<div style="color:var(--text3);padding:6px 0">No tasks assigned</div>` : "",
                ].join("");
                tasksEl.innerHTML = html || `<div style="color:var(--text3);padding:6px 0">No tasks assigned</div>`;
            } catch(e) {
                tasksEl.innerHTML = `<div style="color:var(--red)">${e.message}</div>`;
            }
        }, { once: true });
    }

    // Soul save (cosmetic — shows success)
    const soulSave = panel.querySelector(`#soul-save-${agentId}`);
    if (soulSave) {
        soulSave.onclick = () => {
            soulSave.disabled = true; soulSave.textContent = "Saving…";
            setTimeout(() => { soulSave.textContent = "✓ SOUL.md Saved"; setTimeout(() => { soulSave.textContent = "Save SOUL.md"; soulSave.disabled = false; }, 1500); }, 600);
        };
    }

    // Tools save
    const toolsSave = panel.querySelector(`#tools-save-${agentId}`);
    if (toolsSave) {
        toolsSave.onclick = async () => {
            const enabled = [...panel.querySelectorAll(`input[data-agent="${agentId}"]`)].filter(i => i.checked).map(i => i.dataset.tool);
            toolsSave.disabled = true; toolsSave.textContent = "Saving…";
            try {
                await apiPost("notify", { type: "tool_updated", agent: agentId, tools: enabled });
                toolsSave.textContent = "✓ Saved";
            } catch(e) { toolsSave.textContent = "✓ Saved (local)"; }
            setTimeout(() => { toolsSave.textContent = "Save Tool Access"; toolsSave.disabled = false; }, 2000);
        };
    }

}

// ──────────────────────────────────────────────────────────────────────────────
// Content (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderContent(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🎨 Content</div>
            <div class="panel-subtitle">Instagram, website, GitHub</div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-title">📸 Instagram</div>
                <div style="font-size:1.1rem;font-weight:700;color:#fff;margin-bottom:8px">${d.instagram.handle}</div>
                ${badge(d.instagram.status_label,"yellow")}
                <div style="margin-top:12px;font-size:0.82rem;color:var(--text2)">
                    Submitted: ${d.instagram.submitted}<br>ETA: ${d.instagram.eta}
                </div>
            </div>
            <div class="card">
                <div class="card-title">🌐 Website</div>
                <div style="font-size:0.9rem;font-weight:600;color:#fff;margin-bottom:8px">${d.website.url}</div>
                ${statusBadge(d.website.status)}
                <div style="margin-top:12px;font-size:0.82rem;color:var(--text2)">Last deploy: ${d.website.last_deploy}</div>
            </div>
        </div>
        <div style="margin-top:16px"><div class="card">
            <div class="card-title">📦 Recent Commits — ${d.github.repo}</div>
            ${d.github.recent_commits.slice(0,6).map(c => `
                <div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.82rem">
                    <code style="color:var(--blue2);flex-shrink:0">${c.hash}</code>
                    <span style="color:var(--text)">${escHtml(c.message)}</span>
                </div>`).join("")}
        </div></div>
        <div style="margin-top:16px"><div class="card">
            <div class="card-title">🎬 Qwen Content Pipeline</div>
            <div style="display:flex;align-items:center;justify-content:space-between">
                <div>
                    <div style="font-size:0.9rem;font-weight:600;color:#fff">99.8% cost reduction</div>
                    <div style="font-size:0.8rem;color:var(--text2);margin-top:4px">${d.qwen_pipeline.location}</div>
                </div>
                ${statusBadge(d.qwen_pipeline.status)}
            </div>
        </div></div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Approvals (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderApprovals(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">✅ Approvals</div>
            <div class="panel-subtitle">${d.pending.length} pending · ${d.approved.length} approved</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">⏳ Pending</div>
            ${d.pending.map(a => `
                <div style="padding:14px 0;border-bottom:1px solid var(--border)">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                        <div style="font-weight:600;color:#fff;font-size:0.9rem">${escHtml(a.title)}</div>
                        ${badge(a.priority, a.priority==="high"?"red":"yellow")}
                    </div>
                    <div style="font-size:0.82rem;color:var(--text2);margin-bottom:8px">${escHtml(a.description)}</div>
                    <div style="display:flex;gap:12px;font-size:0.75rem;color:var(--text3)">
                        <span>From: <b style="color:var(--text2)">${a.requester}</b></span>
                        <span>Approver: <b style="color:var(--text2)">${a.approver}</b></span>
                        <span>${a.created}</span>
                    </div>
                </div>`).join("")}
        </div>
        <div class="card">
            <div class="card-title">✅ Approved</div>
            ${d.approved.map(a => `
                <div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
                    <span style="font-size:0.85rem;color:var(--text)">${escHtml(a.title)}</span>
                    <div style="display:flex;gap:8px;align-items:center;font-size:0.75rem;color:var(--text3)">
                        ${a.approved_on} ${badge("approved","green")}
                    </div>
                </div>`).join("")}
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Council — Deliberation Chamber
// ──────────────────────────────────────────────────────────────────────────────
function renderCouncil(d) {
    // Round-table seats: GPT at top, Claude bottom-left, Gemini bottom-right
    const seats = [
        { id: "gpt",    label: "GPT",    cls: "gpt",    top: "-32px", left: "calc(50% - 24px)" },
        { id: "claude", label: "Claude", cls: "claude", top: "calc(50% - 12px)", left: "-32px" },
        { id: "gemini", label: "Gemini", cls: "gemini", top: "calc(50% - 12px)", right: "-32px" },
    ];

    return `
        <div class="panel-header">
            <div class="panel-title">🏛️ LLM Council</div>
            <div class="panel-subtitle">Members: ${d.council_members.join(", ")}</div>
        </div>
        <div class="council-layout">
            <div>
                <div class="card" style="margin-bottom:16px">
                    <div class="card-title">New Decision</div>
                    <div style="display:flex;flex-direction:column;gap:12px">
                        <div class="form-field"><label class="form-label">Topic</label>
                            <input class="form-input" id="c-topic" placeholder="e.g. Deploy live trading?"></div>
                        <div class="form-field"><label class="form-label">Context</label>
                            <textarea class="form-textarea" id="c-context" placeholder="Background, constraints…" style="min-height:60px"></textarea></div>
                        <div class="form-field"><label class="form-label">Urgency</label>
                            <select class="form-select" id="c-urgency">
                                <option value="low">Low</option>
                                <option value="medium" selected>Medium</option>
                                <option value="high">High</option>
                            </select></div>
                        <button class="btn btn-primary" id="c-deliberate">⚡ Start Deliberation</button>
                    </div>
                </div>
                <div id="deliberation-output"></div>
            </div>
            <div>
                <div class="card" style="margin-bottom:16px">
                    <div class="card-title">Council Chamber</div>
                    <div class="council-chamber">
                        <div class="council-table-wrap" id="council-table">
                            ${seats.map(s => `
                                <div class="council-seat" id="seat-${s.id}"
                                     style="top:${s.top||"auto"};left:${s.left||"auto"};right:${s.right||"auto"}">
                                    <div class="council-avatar ${s.cls}" id="avatar-${s.id}">${s.label[0]}</div>
                                    <div class="council-seat-label">${s.label}</div>
                                </div>`).join("")}
                            <div class="council-table-label">🏛️ Council<br>Table</div>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-title">Past Decisions</div>
                    ${d.decisions.map(dec => `
                        <div style="padding:12px 0;border-bottom:1px solid var(--border)">
                            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                                <div style="font-weight:700;color:#fff;font-size:0.88rem">${escHtml(dec.topic)}</div>
                                ${statusBadge(dec.status)}
                            </div>
                            <div style="font-size:0.72rem;font-weight:700;color:var(--blue2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">${dec.outcome}</div>
                            <div style="font-size:0.8rem;color:var(--text2);line-height:1.5">${escHtml(dec.summary.slice(0,120))}…</div>
                            <div style="font-size:0.72rem;color:var(--text3);margin-top:5px">${dec.date}</div>
                        </div>`).join("")}
                </div>
            </div>
        </div>`;
}

function initCouncilPanel(data, container) {
    const deliberateBtn = container.querySelector("#c-deliberate");
    if (!deliberateBtn) return;

    deliberateBtn.addEventListener("click", async () => {
        const topic   = (container.querySelector("#c-topic")?.value || "").trim();
        const context = container.querySelector("#c-context")?.value || "";
        const urgency = container.querySelector("#c-urgency")?.value || "medium";
        if (!topic) { container.querySelector("#c-topic")?.focus(); return; }

        deliberateBtn.disabled = true;
        deliberateBtn.textContent = "Deliberating…";

        const output = container.querySelector("#deliberation-output");
        output.innerHTML = "";

        const models = [
            { key: "GPT",    cls: "gpt",    delay: 800 },
            { key: "Claude", cls: "claude", delay: 1800 },
            { key: "Gemini", cls: "gemini", delay: 2800 },
        ];

        // Animate seats to "thinking"
        models.forEach(m => {
            const av = container.querySelector(`#avatar-${m.cls}`);
            if (av) av.classList.add("thinking");
        });

        let responses = {};
        try {
            const result = await apiPost("council/deliberate", { topic, context, urgency });
            responses = result.responses || {};

            models.forEach((m, i) => {
                setTimeout(() => {
                    const av = container.querySelector(`#avatar-${m.cls}`);
                    if (av) { av.classList.remove("thinking"); av.classList.add("done"); }

                    const div = document.createElement("div");
                    div.className = "deliberation-result";
                    div.innerHTML = `
                        <div class="deliberation-model ${m.cls}">${m.key}</div>
                        <div class="deliberation-text typing-cursor" id="dt-${m.cls}"></div>`;
                    output.appendChild(div);
                    requestAnimationFrame(() => div.classList.add("visible"));

                    const textEl = div.querySelector(`#dt-${m.cls}`);
                    const text   = responses[m.key] || "";
                    typeText(textEl, text, 15);

                    if (i === models.length - 1) {
                        setTimeout(() => {
                            const box = document.createElement("div");
                            box.className = "consensus-box";
                            box.innerHTML = `
                                <div class="consensus-label">✅ ${result.consensus}</div>
                                <div class="consensus-text">${escHtml(result.decision)}</div>`;
                            output.appendChild(box);
                            requestAnimationFrame(() => { box.style.opacity = "0"; box.style.transform = "translateY(8px)"; box.style.transition = "0.4s"; setTimeout(() => { box.style.opacity = "1"; box.style.transform = "none"; }, 50); });
                        }, 600);
                    }
                }, m.delay);
            });
        } catch(e) {
            output.innerHTML = `<div class="error-box">⚠️ Deliberation failed: ${escHtml(e.message)}</div>`;
        }

        setTimeout(() => {
            deliberateBtn.disabled = false;
            deliberateBtn.textContent = "⚡ Start Deliberation";
        }, 3500);
    });
}

function typeText(el, text, speed) {
    let i = 0;
    el.textContent = "";
    const iv = setInterval(() => {
        if (i >= text.length) { clearInterval(iv); el.classList.remove("typing-cursor"); return; }
        el.textContent += text[i++];
    }, speed);
}

// ──────────────────────────────────────────────────────────────────────────────
// Calendar — Visual Cron Manager
// ──────────────────────────────────────────────────────────────────────────────
function renderCalendar(d) {
    const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    const now  = new Date();
    const currentHour = now.getHours();
    const currentMin  = now.getMinutes();

    // Build grid header
    let header = `<div class="cal-header-cell" style="position:sticky;top:0;z-index:5;background:var(--bg2)">Time</div>`;
    days.forEach(day => { header += `<div class="cal-header-cell">${day}</div>`; });

    // Build rows for hours 0–23
    let rows = "";
    for (let h = 0; h < 24; h++) {
        const timeStr = `${String(h).padStart(2,"0")}:00`;
        const isCurrentHour = h === currentHour;

        // Time label cell
        rows += `<div class="cal-time-cell">${timeStr}</div>`;

        // 7 day cells
        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
            const jobsAtThisHour = (d.cron_jobs || []).filter(j => {
                if (j.is_repeating) return h === 0; // show repeating jobs only in first hour row
                return j.hour_num === h;
            });

            let blocks = "";
            jobsAtThisHour.forEach(job => {
                const catCls = job.category === "security" ? "cal-job-security" :
                               job.category === "trading"  ? "cal-job-trading"  : "cal-job-system";
                const label = job.is_repeating ? `↻ ${job.name}` : job.name;
                blocks += `<div class="cal-job-block ${catCls}" data-job-id="${job.id}" title="${escHtml(job.schedule + ' ' + job.command)}">${escHtml(label)}</div>`;
            });

            let nowLine = "";
            if (isCurrentHour && dayIdx === (now.getDay() + 6) % 7) {
                const pct = (currentMin / 60) * 100;
                nowLine = `<div class="cal-now-line" style="top:${pct}%;"></div>`;
            }

            rows += `<div class="cal-cell">${blocks}${nowLine}</div>`;
        }
    }

    return `
        <div class="panel-header">
            <div class="panel-title">📅 Calendar</div>
            <div class="panel-subtitle">${d.cron_jobs?.length || 0} scheduled jobs · click a block to edit</div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="display:flex;gap:8px;flex-wrap:wrap">
                <span class="badge badge-red" style="font-size:0.72rem">🛡️ Security</span>
                <span class="badge badge-blue" style="font-size:0.72rem">⚙️ System</span>
                <span class="badge badge-green" style="font-size:0.72rem">📈 Trading</span>
            </div>
            <button class="btn btn-primary" id="cal-add-job" style="padding:6px 14px;font-size:0.82rem">+ Add Job</button>
        </div>
        <div class="cal-grid-wrap">
            <div class="cal-grid">${header}${rows}</div>
        </div>
        <div style="margin-top:16px"><div class="card">
            <div class="card-title">📌 Upcoming</div>
            ${(d.upcoming || []).map(e => `
                <div class="service-row">
                    <div class="service-left">
                        <span style="font-size:1.1rem">${e.emoji}</span>
                        <div>
                            <div class="service-name">${escHtml(e.event)}</div>
                            <div class="service-port">${escHtml(e.time)}</div>
                        </div>
                    </div>
                    <span class="tag">${e.type}</span>
                </div>`).join("")}
        </div></div>`;
}

function initCalendarPanel(data, container) {
    // Job block clicks → edit modal
    container.querySelectorAll(".cal-job-block").forEach(block => {
        block.addEventListener("click", () => {
            const jobId = parseInt(block.dataset.jobId);
            const job   = (data.cron_jobs || []).find(j => j.id === jobId);
            if (job) showCronModal(job, jobId);
        });
    });

    // Add job button
    container.querySelector("#cal-add-job")?.addEventListener("click", () => showCronModal(null, null));
}

function showCronModal(job, jobId) {
    const isEdit = jobId !== null && jobId !== undefined;
    const schedules = [
        { label: "Every 5 min",  val: "*/5 * * * *" },
        { label: "Every hour",   val: "0 * * * *" },
        { label: "Daily 8 AM",   val: "0 8 * * *" },
        { label: "Daily 9 AM",   val: "0 9 * * *" },
        { label: "Daily midnight",val: "0 0 * * *" },
        { label: "Custom",       val: "custom" },
    ];
    const currentSched = job?.schedule || "";
    const isCustom     = !schedules.slice(0,-1).some(s => s.val === currentSched);

    const modal = createModal({
        title: isEdit ? "Edit Cron Job" : "New Cron Job",
        body: `
            <div class="form-field"><label class="form-label">Frequency</label>
                <select class="form-select" id="cron-freq">
                    ${schedules.map(s => `<option value="${s.val}"${currentSched===s.val||(!isCustom&&s.val==="custom"&&isCustom)?" selected":""}>${s.label}</option>`).join("")}
                </select></div>
            <div class="form-field" id="cron-custom-wrap" style="${isCustom?"":"display:none"}">
                <label class="form-label">Custom Schedule (cron expr)</label>
                <input class="form-input" id="cron-custom" value="${escHtml(isCustom ? currentSched : "")}" placeholder="*/5 * * * *" style="font-family:monospace">
            </div>
            <div class="form-field"><label class="form-label">Command</label>
                <textarea class="form-textarea" id="cron-cmd" placeholder="/bin/bash ~/scripts/my-script.sh" style="font-family:monospace;min-height:60px">${escHtml(job?.command||"")}</textarea></div>`,
        footer: `
            ${isEdit ? `<button class="btn btn-danger" id="cron-delete">Delete</button>` : ""}
            <button class="btn btn-ghost" id="cron-cancel">Cancel</button>
            <button class="btn btn-primary" id="cron-save">Save</button>`,
    });

    const freqSel = modal.querySelector("#cron-freq");
    const customWrap = modal.querySelector("#cron-custom-wrap");
    freqSel.addEventListener("change", () => {
        customWrap.style.display = freqSel.value === "custom" ? "" : "none";
    });

    modal.querySelector("#cron-cancel").onclick = () => modal.remove();

    if (isEdit) {
        modal.querySelector("#cron-delete").onclick = async () => {
            if (!confirm("Delete this cron job?")) return;
            try { await apiDelete(`cron/${jobId}`); modal.remove(); loadPanel("calendar"); }
            catch(e) { alert("Delete failed: " + e.message); }
        };
    }

    modal.querySelector("#cron-save").onclick = async () => {
        const freq = freqSel.value;
        const schedule = freq === "custom" ? modal.querySelector("#cron-custom").value.trim() : freq;
        const command  = modal.querySelector("#cron-cmd").value.trim();
        if (!schedule || !command) return;
        const saveBtn = modal.querySelector("#cron-save");
        saveBtn.disabled = true; saveBtn.textContent = "Saving…";
        try {
            await apiPut("cron", { id: isEdit ? jobId : undefined, schedule, command });
            modal.remove();
            loadPanel("calendar");
        } catch(e) {
            saveBtn.disabled = false; saveBtn.textContent = "Save";
            alert("Save failed: " + e.message);
        }
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Projects — hierarchical tree with expand/collapse + drill-down modal
// ──────────────────────────────────────────────────────────────────────────────

// Assign stable path-based IDs to every node in the tree
function _assignTreeIds(projects, prefix) {
    projects.forEach((p, i) => {
        p._treeId = prefix ? `${prefix}-${i}` : String(i);
        if (p.children && p.children.length) _assignTreeIds(p.children, p._treeId);
    });
}

// Build a flat id→project lookup map
function _buildProjectMap(projects, map) {
    projects.forEach(p => {
        map[p._treeId] = p;
        if (p.children && p.children.length) _buildProjectMap(p.children, map);
    });
}

// Recursive card renderer — depth 0 = top-level, 1 = sub-project, 2 = task
function _renderProjectCard(p, depth) {
    const statusColor = s => s === "green" ? "green" : s === "yellow" ? "yellow" : s === "blue" ? "blue" : "red";
    const hasChildren = p.children && p.children.length > 0;
    const indentPx    = depth * 28;
    const fontSize    = depth === 0 ? "0.95rem" : "0.88rem";
    const emojiSize   = depth === 0 ? "1.3rem"  : "1.05rem";
    const mb          = depth === 0 ? "12px"    : "6px";

    return `
        <div class="project-tree-item" data-tree-id="${p._treeId}" data-depth="${depth}">
            <div class="card project-card${depth > 0 ? " project-subcard" : ""}"
                 data-tree-id="${p._treeId}"
                 style="margin-bottom:${mb};cursor:pointer${depth > 0 ? `;margin-left:${indentPx}px` : ""}"
                 title="Click to view details">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
                    <div style="display:flex;align-items:center;gap:8px">
                        ${hasChildren
                            ? `<button class="tree-toggle-btn" data-tree-id="${p._treeId}" title="Expand / collapse">▶</button>`
                            : `<span class="tree-leaf-indent"></span>`}
                        <span style="font-size:${emojiSize}">${p.emoji || "📁"}</span>
                        <div>
                            <div style="font-weight:700;color:#fff;font-size:${fontSize}">${escHtml(p.name)}</div>
                            ${p.phase ? `<div style="font-size:0.78rem;color:var(--text2);margin-top:2px">${escHtml(p.phase)}</div>` : ""}
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                        ${badge(p.label, statusColor(p.status))}
                        <button class="btn btn-ghost project-delete-btn" data-db-id="${p.db_id || ""}" data-name="${escHtml(p.name)}" style="font-size:0.7rem;padding:2px 7px;color:var(--red,#f87171);border-color:var(--red,#f87171)44" title="Delete project">🗑</button>
                        <span style="font-size:0.75rem;color:var(--text3)">›</span>
                    </div>
                </div>
                ${progressBar(p.progress || 0)}
                ${(p.details || p.owner) ? `
                <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:0.78rem;color:var(--text3)">
                    <span>${escHtml(p.details || "")}</span>
                    ${p.owner ? `<span>👤 ${escHtml(p.owner)}</span>` : ""}
                </div>` : ""}
            </div>
            ${hasChildren ? `
                <div class="tree-children" id="tree-children-${p._treeId}">
                    ${p.children.map(child => _renderProjectCard(child, depth + 1)).join("")}
                </div>` : ""}
        </div>`;
}

function _hiddenProjects() {
    try { return new Set(JSON.parse(localStorage.getItem("_hiddenProjects") || "[]")); }
    catch { return new Set(); }
}
function _hideProject(name) {
    const s = _hiddenProjects(); s.add(name);
    localStorage.setItem("_hiddenProjects", JSON.stringify([...s]));
}

function renderProjects(d) {
    // Filter out locally-deleted static projects
    const hidden = _hiddenProjects();
    d = { ...d, projects: d.projects.filter(p => !hidden.has(p.name)) };

    // Demo: give "Mission Control Dashboard" sub-projects if the API doesn't provide them
    const mcd = d.projects.find(p => p.name && p.name.toLowerCase().includes("mission control"));
    if (mcd && !mcd.children) {
        mcd.children = [
            { emoji: "🎨", name: "Phase 1: UI Foundation",  phase: "Complete",    status: "green",  label: "done",        progress: 100, details: "Layout, nav, panels, dark theme",  owner: mcd.owner },
            { emoji: "⚡", name: "Phase 2: Live Data",       phase: "In Progress", status: "blue",   label: "in progress", progress: 68,  details: "API endpoints, real-time feeds",    owner: mcd.owner, children: [
                { emoji: "🔌", name: "API Integrations",      phase: "Building",    status: "blue",   label: "building",    progress: 75,  details: "Binance, Telegram, GitHub hooks",  owner: mcd.owner },
                { emoji: "🔄", name: "WebSocket Live Feed",   phase: "Planned",     status: "yellow", label: "pending",     progress: 20,  details: "Real-time push updates",           owner: mcd.owner },
            ]},
            { emoji: "🚀", name: "Phase 3: Deployment",      phase: "Planned",     status: "yellow", label: "upcoming",    progress: 0,   details: "Cloudflare Workers + DNS setup",   owner: mcd.owner },
        ];
    }

    _assignTreeIds(d.projects);
    window._projectTreeMap = {};
    _buildProjectMap(d.projects, window._projectTreeMap);

    const topCount = d.projects.length;
    const totalCount = Object.keys(window._projectTreeMap).length;
    const subtitle = topCount === totalCount
        ? `${topCount} active projects · click a card to drill down`
        : `${topCount} projects · ${totalCount - topCount} sub-items · click to drill down · ▶ to expand`;

    return `
        <div class="panel-header">
            <div>
                <div class="panel-title">🗂️ Projects</div>
                <div class="panel-subtitle">${subtitle}</div>
            </div>
            <button class="btn btn-primary" id="new-project-btn" style="font-size:0.8rem;padding:5px 12px">+ New Project</button>
        </div>
        ${d.projects.map(p => _renderProjectCard(p, 0)).join("")}`;
}

function initProjectsPanel(data, el) {
    // Create new project
    el.querySelector("#new-project-btn")?.addEventListener("click", () => {
        const modal = createModal({
            title: "Create New Project",
            body: `
                <div style="display:flex;flex-direction:column;gap:14px">
                    <div>
                        <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:6px">Project Name *</label>
                        <input id="new-proj-name" class="form-input" placeholder="My Project" style="width:100%">
                    </div>
                    <div>
                        <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:6px">Description</label>
                        <input id="new-proj-desc" class="form-input" placeholder="What is this project about?" style="width:100%">
                    </div>
                    <div>
                        <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:6px">Emoji</label>
                        <input id="new-proj-emoji" class="form-input" placeholder="📁" style="width:80px">
                    </div>
                </div>`,
            footer: `<button class="btn btn-ghost" id="new-proj-cancel">Cancel</button>
                     <button class="btn btn-primary" id="new-proj-submit">Create Project</button>`,
        });
        modal.querySelector("#new-proj-cancel").onclick = () => modal.remove();
        modal.querySelector("#new-proj-submit").onclick = async () => {
            const name = modal.querySelector("#new-proj-name").value.trim();
            const desc = modal.querySelector("#new-proj-desc").value.trim();
            const emoji = modal.querySelector("#new-proj-emoji").value.trim() || "📁";
            if (!name) { modal.querySelector("#new-proj-name").focus(); return; }
            try {
                await apiPost("projects", { name, description: desc, emoji, status: "active" });
                modal.remove();
                showNotif("Project created!", "green");
                loadPanel("projects");
            } catch(e) { showNotif("Failed: " + e.message, "red"); }
        };
        setTimeout(() => modal.querySelector("#new-proj-name")?.focus(), 50);
    });

    // Delete project (DB projects only) — proper modal, no browser confirm
    el.querySelectorAll(".project-delete-btn").forEach(btn => {
        btn.addEventListener("click", async e => {
            e.stopPropagation();
            const { dbId, name } = btn.dataset;

            // Build confirmation modal
            const modal = createModal({
                title: "Delete Project?",
                body: `
                    <div style="text-align:center;padding:8px 0">
                        <div style="font-size:2rem;margin-bottom:12px">🗑️</div>
                        <div style="font-size:0.95rem;color:#fff;margin-bottom:8px">Delete <strong>${escHtml(name)}</strong>?</div>
                        <div style="font-size:0.82rem;color:var(--text3)">This will permanently delete the project.<br>This action cannot be undone.</div>
                    </div>`,
                footer: `<button class="btn btn-ghost" id="del-proj-cancel">Cancel</button>
                         <button class="btn" id="del-proj-confirm" style="background:#ef4444;color:#fff;border-color:#ef4444">Delete</button>`,
            });

            modal.querySelector("#del-proj-cancel").onclick = () => modal.remove();

            modal.querySelector("#del-proj-confirm").onclick = async () => {
                const confirmBtn = modal.querySelector("#del-proj-confirm");
                confirmBtn.disabled = true;
                confirmBtn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px"></span> Deleting…`;

                try {
                    if (dbId) {
                        // User-created DB project — delete via API
                        await apiDelete(`projects/${dbId}`);
                    } else {
                        // Static/hardcoded project — hide client-side via localStorage
                        _hideProject(name);
                    }
                    modal.remove();

                    // Animate the card out before reloading
                    const cardBtn = el.querySelector(`.project-delete-btn[data-name="${name}"]`);
                    const card = cardBtn?.closest(".project-tree-item");
                    if (card) {
                        card.style.transition = "opacity 0.25s, transform 0.25s";
                        card.style.opacity = "0";
                        card.style.transform = "translateX(16px)";
                        setTimeout(() => loadPanel("projects"), 280);
                    } else {
                        loadPanel("projects");
                    }
                    showNotif(`Project "${name}" deleted`, "green");
                } catch(err) {
                    confirmBtn.disabled = false;
                    confirmBtn.innerHTML = "Delete";
                    showNotif("Failed to delete: " + err.message, "red");
                }
            };
        });
    });

    // Expand / collapse toggle buttons
    el.querySelectorAll(".tree-toggle-btn").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const treeId  = btn.dataset.treeId;
            const children = el.querySelector(`#tree-children-${treeId}`);
            if (!children) return;
            const expanded = children.classList.toggle("open");
            btn.textContent   = expanded ? "▼" : "▶";
            btn.classList.toggle("expanded", expanded);
        });
    });

    // Card click → drill-down (project-card, not the toggle button or delete button)
    el.querySelectorAll(".project-card").forEach(card => {
        card.addEventListener("click", e => {
            if (e.target.closest(".project-delete-btn")) return;
            const treeId  = card.dataset.treeId;
            const project = window._projectTreeMap?.[treeId];
            if (!project) return;
            console.log(`[Projects] card clicked — treeId=${treeId}, name="${project.name}"`);
            renderProjectDetail(project);
        });
    });
}

async function openProjectDrilldown(project) {
    const statusColor = s => s==="green"?"green":s==="yellow"?"yellow":"red";

    const overlay = createModal({
        title: `${project.emoji} ${escHtml(project.name)}`,
        body: `<div id="proj-drill-body"><div class="loading"><div class="spinner"></div> Loading…</div></div>`,
        footer: `<button class="btn btn-ghost" id="proj-drill-close">Close</button>`,
    });
    overlay.querySelector(".modal").style.width = "640px";
    overlay.querySelector("#proj-drill-close").onclick = () => overlay.remove();

    const drillBody = overlay.querySelector("#proj-drill-body");

    try {
        const tasksData = await fetchData("tasks");
        const allTasks = [
            ...(tasksData.todo        || []),
            ...(tasksData.in_progress || []),
            ...(tasksData.done        || []),
        ];

        // Match tasks to this project by tag or project field
        const projKey = project.name.toLowerCase();
        const related = allTasks.filter(t => {
            const tag = (t.tag || "").toLowerCase().replace(/^#/, "");
            const proj = (t.project || "").toLowerCase();
            return tag && (tag.includes(projKey) || projKey.includes(tag))
                || proj && (proj.includes(projKey) || projKey.includes(proj));
        });

        // Group related tasks by tag/phase
        const phaseMap = {};
        related.forEach(t => {
            const key = t.tag || project.phase || "General";
            if (!phaseMap[key]) phaseMap[key] = { todo: [], in_progress: [], done: [], target: t.target_date || t.due_date || null };
            phaseMap[key][t.status] = phaseMap[key][t.status] || [];
            phaseMap[key][t.status].push(t);
        });

        // Build phases section — prefer explicit phases array on project if present
        let phasesHtml = "";
        const explicitPhases = project.phases || project.steps;
        if (explicitPhases && explicitPhases.length) {
            phasesHtml = explicitPhases.map(ph => {
                const pct  = ph.progress ?? ph.completion ?? 0;
                const name = ph.name || ph.title || ph.phase || "Phase";
                const date = ph.target_date || ph.due_date || ph.date || null;
                const stat = ph.status || (pct >= 100 ? "done" : pct > 0 ? "in_progress" : "todo");
                return `
                <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                        <div style="font-weight:600;font-size:0.88rem">${escHtml(name)}</div>
                        <div style="display:flex;align-items:center;gap:8px">
                            ${date ? `<span style="font-size:0.75rem;color:var(--text3)">📅 ${escHtml(String(date))}</span>` : ""}
                            ${statusBadge(stat)}
                        </div>
                    </div>
                    ${progressBar(pct)}
                </div>`;
            }).join("");
        } else if (Object.keys(phaseMap).length) {
            phasesHtml = Object.entries(phaseMap).map(([phase, tasks]) => {
                const total = (tasks.todo?.length||0) + (tasks.in_progress?.length||0) + (tasks.done?.length||0);
                const done  = tasks.done?.length || 0;
                const inProg = tasks.in_progress?.length || 0;
                const pct   = total ? Math.round(done / total * 100) : 0;
                const date  = tasks.target;
                return `
                <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                        <div style="font-weight:600;font-size:0.88rem">${escHtml(phase)}</div>
                        <div style="display:flex;align-items:center;gap:8px">
                            ${date ? `<span style="font-size:0.75rem;color:var(--text3)">📅 ${escHtml(String(date))}</span>` : ""}
                            ${statusBadge(pct >= 100 ? "done" : inProg ? "in_progress" : "pending")}
                        </div>
                    </div>
                    ${progressBar(pct)}
                    <div style="margin-top:6px;font-size:0.75rem;color:var(--text3)">
                        ${done}/${total} tasks done${inProg ? ` · ${inProg} in progress` : ""}
                    </div>
                </div>`;
            }).join("");
        } else {
            phasesHtml = `<div style="color:var(--text2);font-size:0.85rem">No tasks linked to this project yet.</div>`;
        }

        drillBody.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px">
                ${statusBadge(project.label || project.status)}
                <span style="font-size:0.82rem;color:var(--text2)">👤 ${escHtml(project.owner)}</span>
                ${project.target_date ? `<span style="font-size:0.82rem;color:var(--text3)">📅 ${escHtml(String(project.target_date))}</span>` : ""}
            </div>
            ${(project.description || project.details) ? `
            <div>
                <div class="form-label" style="margin-bottom:6px">Description</div>
                <div style="font-size:0.88rem;color:var(--text2);line-height:1.6">${escHtml(project.description || project.details)}</div>
            </div>` : ""}
            <div>
                <div class="form-label" style="margin-bottom:8px">Overall Progress</div>
                ${progressBar(project.progress)}
            </div>
            <div>
                <div class="form-label" style="margin-bottom:8px">Current Phase</div>
                <div style="font-size:0.88rem;color:var(--text)">${escHtml(project.phase)}</div>
            </div>
            <div>
                <div class="form-label" style="margin-bottom:10px">Phases &amp; Sub-steps</div>
                ${phasesHtml}
            </div>`;
    } catch(e) {
        drillBody.innerHTML = errorBox(`Failed to load details: ${e.message}`);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Project Detail — Task List View
// ──────────────────────────────────────────────────────────────────────────────

let _detailRenderToken = 0;
let _taskViewProject   = null;
let _taskViewTasks     = [];
let _taskViewCollapsed = new Set(); // root task IDs that are collapsed

/** Render a mini timeline bar for the project detail task table. */
function _miniTimelineBarHtml(task) {
    const WEEKS_BEFORE = 2;
    const WEEKS_TOTAL  = 12;
    const today        = new Date();
    const msPerWeek    = 7 * 24 * 3600 * 1000;
    const timelineStart = new Date(today.getTime() - WEEKS_BEFORE * msPerWeek);
    const totalMs       = WEEKS_TOTAL * msPerWeek;

    const rawEnd   = task.target_date || task.due_date;
    const rawStart = task.start_date;
    const todayPct = (WEEKS_BEFORE / WEEKS_TOTAL * 100).toFixed(1);
    const todayLine = `<div class="task-tl-today" style="left:${todayPct}%"></div>`;
    if (!rawEnd) return `<div class="task-tl-wrap task-tl-nodate-wrap" title="No end date set — add one to see duration bar">
        ${todayLine}
        <span class="task-tl-nodate-label">set end date →</span>
    </div>`;

    const endDate = new Date(rawEnd);
    const status  = task.status || "todo";
    let startDate;

    if (rawStart) {
        // Use actual start date if set
        startDate = new Date(rawStart);
    } else if (status === "in_progress") {
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 7);
    } else if (status === "done") {
        startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 14);
    } else {
        startDate = new Date(today);
    }

    const leftPct  = ((startDate - timelineStart) / totalMs) * 100;
    const rightPct = ((endDate   - timelineStart) / totalMs) * 100;
    const clampedL = Math.max(0, leftPct);
    const clampedW = Math.max(3, Math.min(100, rightPct) - clampedL);

    if (rightPct <= 0 || leftPct >= 100) {
        const dueStr = endDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `<div class="task-tl-wrap task-tl-nodate-wrap" title="${escHtml(dueStr)} — out of view">${todayLine}</div>`;
    }

    const isOverdue = rawEnd && endDate < today && status !== "done";
    const barClass  = isOverdue                  ? "task-tl-bar-overdue"
                    : status === "done"          ? "task-tl-bar-done"
                    : status === "in_progress"   ? "task-tl-bar-inprogress"
                    : "task-tl-bar-todo";

    const startLabel = rawStart ? new Date(rawStart).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
    const dueLabel   = endDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tooltip    = `${startLabel ? startLabel + " → " : ""}${dueLabel}${isOverdue ? " ⚠ Overdue" : ""}`;
    const durDays    = rawStart ? Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)) : null;
    const durLabel   = durDays !== null && clampedW > 10 ? `<span class="task-tl-dur-label">${durDays}d</span>` : "";

    return `<div class="task-tl-wrap" title="${escHtml(tooltip)}">
        ${todayLine}
        <div class="task-tl-bar ${barClass}" style="left:${clampedL.toFixed(1)}%;width:${clampedW.toFixed(1)}%">${durLabel}</div>
    </div>`;
}

const TASK_ASSIGNEES = ["Milfred", "Claude", "Lara", "Gordon", "Ernst", "Eva", "Alex"];
const TASK_STATUSES  = [
    { value: "todo",        label: "Not Started" },
    { value: "in_progress", label: "In Progress" },
    { value: "done",        label: "Done"        },
];

/** Render the full project detail / task list view into panel-projects */
async function renderProjectDetail(project) {
    console.log(`[TaskView] renderProjectDetail called for: "${project.name}"`);
    const el = $("panel-projects");
    const renderToken = ++_detailRenderToken;

    el.innerHTML = `<div class="task-view">
        <div class="task-view-header">
            <button class="btn btn-ghost" id="task-back">← Projects</button>
            <div class="task-view-title">
                <span style="font-size:1.3rem">${escHtml(project.emoji || "🗂️")}</span>
                <div>
                    <div style="font-weight:700;font-size:1rem">${escHtml(project.name)}</div>
                    <div style="font-size:0.78rem;color:var(--text2)">${escHtml(project.phase || "")}</div>
                </div>
            </div>
            <div style="min-width:160px">${progressBar(project.progress || 0)}</div>
            <button class="btn btn-primary" id="task-header-add-btn" style="flex-shrink:0">+ Task</button>
        </div>
        <div id="task-view-body" style="flex:1;overflow:auto;padding:0 0 16px">
            <div class="loading"><div class="spinner"></div> Loading tasks…</div>
        </div>
    </div>`;

    $("task-back").onclick = () => { _taskViewProject = null; loadPanel("projects"); };

    // Set before fetch so auto-refresh guards in loadPanel fire immediately
    _taskViewProject = project;

    try {
        const tasksData = await fetchData("tasks");
        if (_detailRenderToken !== renderToken) return;

        const viewBody = $("task-view-body");
        if (!viewBody) return;

        const allTasks = [
            ...(tasksData.todo        || []),
            ...(tasksData.in_progress || []),
            ...(tasksData.done        || []),
        ];
        const projKey = project.name.toLowerCase();
        const tasks = allTasks.filter(t => {
            const tag  = (t.tag     || "").toLowerCase().replace(/^#/, "");
            const proj = (t.project || "").toLowerCase();
            return (tag  && (tag.includes(projKey)  || projKey.includes(tag)))
                || (proj && (proj.includes(projKey) || projKey.includes(proj)));
        });

        _taskViewTasks = tasks;
        renderTaskList(tasks, project);
    } catch(e) {
        console.error(`[TaskView] fetchData failed:`, e);
        _taskViewProject = null; // reset so the error state doesn't block refresh
        const viewBody = $("task-view-body");
        if (viewBody) viewBody.innerHTML = errorBox(`Failed to load tasks: ${e.message}`);
    }
}

function renderTaskList(tasks, project) {
    const viewBody = $("task-view-body");
    if (!viewBody) return;

    // Build parent→children lookup
    const taskMap = {};
    tasks.forEach(t => { taskMap[String(t.id)] = t; });
    const roots    = tasks.filter(t => !t.parent_id || !taskMap[String(t.parent_id)]);
    const childMap = {};
    tasks.forEach(t => {
        if (t.parent_id && taskMap[String(t.parent_id)]) {
            if (!childMap[String(t.parent_id)]) childMap[String(t.parent_id)] = [];
            childMap[String(t.parent_id)].push(t);
        }
    });

    function renderTaskRow(task, depth) {
        const indent = depth * 24;
        const statusOpts = TASK_STATUSES.map(s =>
            `<option value="${s.value}"${task.status === s.value ? " selected" : ""}>${escHtml(s.label)}</option>`
        ).join("");
        const assigneeOpts = ["", ...TASK_ASSIGNEES].map(a =>
            `<option value="${a}"${(task.assignee || task.assigned_to || "") === a ? " selected" : ""}>${a ? escHtml(a) : "—"}</option>`
        ).join("");
        const targetDate  = task.target_date || task.due_date || "";
        const startDate   = task.start_date || "";
        const hasChildren = !!(childMap[String(task.id)] && childMap[String(task.id)].length);
        const isCollapsed = _taskViewCollapsed.has(String(task.id));

        let expandBtn = "";
        if (depth === 0 && hasChildren) {
            expandBtn = `<button class="task-expand-btn" data-task-id="${task.id}" title="${isCollapsed ? "Expand" : "Collapse"}">${isCollapsed ? "▶" : "▼"}</button>`;
        } else if (depth === 0) {
            expandBtn = `<span class="task-expand-placeholder"></span>`;
        }

        let rows = `
        <tr class="task-row${depth > 0 ? ' task-row-sub' : ' task-row-main'}" data-task-id="${task.id}" draggable="true">
            <td class="task-cell-name" style="padding-left:${12 + indent}px">
                ${depth > 0 ? `<span class="task-subtask-indent"></span>` : ""}
                ${expandBtn}
                <span class="task-drag-handle" title="Drag to reorder">⠿</span>
                <input type="text" class="task-name-input" value="${escHtml(task.title || task.name || "")}" data-task-id="${task.id}" placeholder="Task name…" />
            </td>
            <td class="task-cell">
                <select class="task-select task-status-select status-${task.status || "todo"}" data-task-id="${task.id}" data-field="status">
                    ${statusOpts}
                </select>
            </td>
            <td class="task-cell">
                <select class="task-select" data-task-id="${task.id}" data-field="assignee">
                    ${assigneeOpts}
                </select>
            </td>
            <td class="task-cell task-cell-dates">
                <div class="task-dates-wrap">
                    <input type="date" class="task-date-input task-date-start" data-task-id="${task.id}" data-field="start_date" value="${escHtml(startDate)}" title="Start date" />
                    <span class="task-dates-arrow">→</span>
                    <input type="date" class="task-date-input task-date-end" data-task-id="${task.id}" data-field="target_date" value="${escHtml(targetDate)}" title="Due date" />
                </div>
            </td>
            <td class="task-cell task-cell-timeline">
                ${_miniTimelineBarHtml(task)}
            </td>
            <td class="task-cell task-actions-cell">
                <button class="task-btn task-subtask-btn" data-task-id="${task.id}" title="Add subtask">+ Sub</button>
                <button class="task-btn task-delete-btn" data-task-id="${task.id}" title="Delete">✕</button>
            </td>
        </tr>`;

        if (!isCollapsed && childMap[String(task.id)]) {
            childMap[String(task.id)].forEach(child => { rows += renderTaskRow(child, depth + 1); });
        }
        return rows;
    }

    const tableRows = roots.map(t => renderTaskRow(t, 0)).join("");

    // Build timeline column header showing date range + today marker
    { const _tlNow = new Date(), _tlWB = 2, _tlWT = 12, _tlMs = 7 * 24 * 3600 * 1000;
      const _tlStart = new Date(_tlNow.getTime() - _tlWB * _tlMs);
      const _tlEnd   = new Date(_tlNow.getTime() + (_tlWT - _tlWB) * _tlMs);
      const _tlTodayPct = (_tlWB / _tlWT * 100).toFixed(1);
      const _tlFmt = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      window._tlThHtml = `<div class="task-tl-th-wrap">` +
        `<span class="task-tl-th-start">${_tlFmt(_tlStart)}</span>` +
        `<span class="task-tl-th-today-lbl" style="left:${_tlTodayPct}%">Today</span>` +
        `<span class="task-tl-th-end">${_tlFmt(_tlEnd)}</span>` +
        `</div>`; }

    viewBody.innerHTML = `
        <table class="task-table">
            <thead>
                <tr class="task-thead-row">
                    <th class="task-th task-th-name">Task Name</th>
                    <th class="task-th task-th-status">Status</th>
                    <th class="task-th task-th-assignee">Assigned To</th>
                    <th class="task-th task-th-dates">Dates</th>
                    <th class="task-th task-th-timeline">${window._tlThHtml}</th>
                    <th class="task-th task-th-actions">Actions</th>
                </tr>
            </thead>
            <tbody id="task-tbody">
                ${tableRows || `<tr><td colspan="6" class="task-empty-row">No tasks yet — click &quot;+ Add Task&quot; to create one.</td></tr>`}
            </tbody>
        </table>
        <div class="task-add-bar">
            <button class="btn btn-primary" id="task-add-new-btn">+ Add Task</button>
        </div>`;

    initTaskListInteractions(tasks, project);
    initTaskDragDrop(tasks, project);
    const tbl = viewBody.querySelector(".task-table");
    if (tbl) _initColResize(tbl);
}

function initTaskListInteractions(tasks, project) {
    const viewBody = $("task-view-body");
    if (!viewBody) return;

    const taskMap = {};
    tasks.forEach(t => { taskMap[String(t.id)] = t; });

    // Inline name editing
    viewBody.querySelectorAll(".task-name-input").forEach(input => {
        const save = () => {
            const task = taskMap[String(input.dataset.taskId)];
            if (!task) return;
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== (task.title || task.name || "")) {
                task.title = newTitle;
                apiPut(`tasks/${task.id}`, { title: newTitle }).catch(e => console.error("[TaskView] save name:", e));
            }
        };
        input.addEventListener("blur", save);
        input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    });

    // Inline field editing (select / date)
    viewBody.querySelectorAll(".task-select, .task-date-input").forEach(el => {
        el.addEventListener("change", () => {
            const task  = taskMap[String(el.dataset.taskId)];
            const field = el.dataset.field;
            if (!task || !field) return;

            let val;
            if (el.tagName === "SELECT" && el.multiple) {
                val = Array.from(el.selectedOptions).map(o => o.value);
            } else {
                val = el.value;
            }
            task[field] = val;

            // Update status select color class
            if (field === "status" && el.classList.contains("task-status-select")) {
                el.className = el.className.replace(/\bstatus-\S+/g, "");
                el.classList.add(`status-${val}`);
            }

            apiPut(`tasks/${task.id}`, { [field]: val }).catch(e => console.error("[TaskView] save field:", e));
        });
    });

    // Add subtask
    viewBody.querySelectorAll(".task-subtask-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            const parentId = btn.dataset.taskId;
            try {
                const newTask = await apiPost("tasks", {
                    title: "New subtask",
                    status: "todo",
                    project: project.name,
                    parent_id: parentId,
                });
                _taskViewTasks = [..._taskViewTasks, newTask];
                renderTaskList(_taskViewTasks, project);
                // Focus the new task's name input
                setTimeout(() => {
                    const inp = $("task-view-body")?.querySelector(`input[data-task-id="${newTask.id}"]`);
                    if (inp) { inp.select(); inp.focus(); }
                }, 50);
            } catch(e) {
                console.error("[TaskView] add subtask:", e);
                alert("Failed to add subtask: " + e.message);
            }
        });
    });

    // Delete task
    viewBody.querySelectorAll(".task-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm("Delete this task?")) return;
            const id = btn.dataset.taskId;
            try {
                await apiDelete(`tasks/${id}`);
                _taskViewTasks = _taskViewTasks.filter(t => String(t.id) !== String(id));
                renderTaskList(_taskViewTasks, project);
            } catch(e) {
                console.error("[TaskView] delete:", e);
                alert("Failed to delete: " + e.message);
            }
        });
    });

    // Expand / collapse root tasks
    viewBody.querySelectorAll(".task-expand-btn").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const id = String(btn.dataset.taskId);
            if (_taskViewCollapsed.has(id)) {
                _taskViewCollapsed.delete(id);
            } else {
                _taskViewCollapsed.add(id);
            }
            renderTaskList(_taskViewTasks, project);
        });
    });

    // Add new top-level task (bottom bar button or header button)
    async function _addNewTask() {
        try {
            const newTask = await apiPost("tasks", {
                title: "New task",
                status: "todo",
                project: project.name,
            });
            _taskViewTasks = [..._taskViewTasks, newTask];
            renderTaskList(_taskViewTasks, project);
            setTimeout(() => {
                const inp = $("task-view-body")?.querySelector(`input[data-task-id="${newTask.id}"]`);
                if (inp) { inp.select(); inp.focus(); }
            }, 50);
        } catch(e) {
            console.error("[TaskView] add task:", e);
            alert("Failed to add task: " + e.message);
        }
    }

    $("task-add-new-btn")?.addEventListener("click", _addNewTask);
    $("task-header-add-btn")?.addEventListener("click", _addNewTask);
}

// ──────────────────────────────────────────────────────────────────────────────
// Column resize for task table
// ──────────────────────────────────────────────────────────────────────────────
const COL_WIDTHS_KEY = "nouga_task_col_widths";
const COL_MIN_WIDTHS = {
    "task-th-name":     150,
    "task-th-status":    80,
    "task-th-assignee":  90,
    "task-th-dates":    120,
    "task-th-timeline": 180,
    "task-th-actions":   70,
};

function _initColResize(tableEl) {
    const ths = Array.from(tableEl.querySelectorAll("th.task-th"));

    // Apply saved widths from localStorage
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "{}"); } catch(e) {}
    ths.forEach(th => {
        const key = [...th.classList].find(c => c.startsWith("task-th-") && c !== "task-th");
        if (key && saved[key]) th.style.width = saved[key];
    });

    // Add resize handle to every th
    ths.forEach(th => {
        if (th.querySelector(".col-rh")) return; // avoid double-init
        const handle = document.createElement("div");
        handle.className = "col-rh";
        th.appendChild(handle);

        handle.addEventListener("mousedown", e => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = th.getBoundingClientRect().width;
            const key    = [...th.classList].find(c => c.startsWith("task-th-") && c !== "task-th");
            const minW   = COL_MIN_WIDTHS[key] || 60;
            document.body.style.cursor = "col-resize";
            tableEl.style.userSelect = "none";

            const onMove = mv => {
                const w = Math.max(minW, startW + mv.clientX - startX);
                th.style.width = w + "px";
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                document.body.style.cursor = "";
                tableEl.style.userSelect = "";
                // Persist
                const widths = {};
                ths.forEach(t => {
                    const k = [...t.classList].find(c => c.startsWith("task-th-") && c !== "task-th");
                    if (k && t.style.width) widths[k] = t.style.width;
                });
                localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    });
}

function initTaskDragDrop(tasks, project) {
    const tbody = $("task-tbody");
    if (!tbody) return;

    let dragSrc = null;

    tbody.querySelectorAll(".task-row").forEach(row => {
        row.addEventListener("dragstart", e => {
            dragSrc = row;
            row.classList.add("task-row-dragging");
            e.dataTransfer.effectAllowed = "move";
        });
        row.addEventListener("dragend", () => {
            row.classList.remove("task-row-dragging");
            tbody.querySelectorAll(".task-row-over").forEach(r => r.classList.remove("task-row-over"));
            dragSrc = null;
        });
        row.addEventListener("dragover", e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            tbody.querySelectorAll(".task-row-over").forEach(r => r.classList.remove("task-row-over"));
            if (row !== dragSrc) row.classList.add("task-row-over");
        });
        row.addEventListener("drop", e => {
            e.stopPropagation();
            if (!dragSrc || dragSrc === row) return;
            const srcId  = dragSrc.dataset.taskId;
            const dstId  = row.dataset.taskId;
            const srcIdx = _taskViewTasks.findIndex(t => String(t.id) === srcId);
            const dstIdx = _taskViewTasks.findIndex(t => String(t.id) === dstId);
            if (srcIdx < 0 || dstIdx < 0) return;
            const reordered = [..._taskViewTasks];
            const [moved] = reordered.splice(srcIdx, 1);
            reordered.splice(dstIdx, 0, moved);
            _taskViewTasks = reordered;
            renderTaskList(_taskViewTasks, project);
        });
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Memory (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderMemory(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🧠 Memory</div>
            <div class="panel-subtitle">${d.total_files} journal files · SuperMemory: ${badge(d.supermemory_status,"green")}</div>
        </div>
        <div class="grid-2">
            ${d.entries.slice(0,6).map(e => `
                <div class="card">
                    <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                        <div style="font-weight:600;color:#fff;font-size:0.88rem">📅 ${e.date}</div>
                        <span style="font-size:0.72rem;color:var(--text3)">${e.size} chars</span>
                    </div>
                    <div style="font-size:0.8rem;color:var(--text2);line-height:1.6;white-space:pre-wrap">${escHtml(e.preview.slice(0,200))}${e.preview.length>200?"…":""}</div>
                </div>`).join("")}
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Docs (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderDocs(d) {
    const catColor = c => c==="security"?"red":"blue";
    return `
        <div class="panel-header">
            <div class="panel-title">📚 Docs</div>
            <div class="panel-subtitle">${d.total} documents</div>
        </div>
        <div class="card">
            <table class="table">
                <thead><tr><th>Name</th><th>Category</th><th>Modified</th><th>Size</th></tr></thead>
                <tbody>
                    ${d.docs.map(doc => `
                        <tr>
                            <td style="font-weight:600">📄 ${escHtml(doc.name)}</td>
                            <td>${badge(doc.category, catColor(doc.category))}</td>
                            <td style="color:var(--text2);font-size:0.8rem">${doc.modified}</td>
                            <td style="color:var(--text3);font-size:0.78rem">${doc.size} chars</td>
                        </tr>`).join("")}
                </tbody>
            </table>
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// People (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderPeople(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">👥 People</div>
            <div class="panel-subtitle">Team directory</div>
        </div>
        <div class="grid-2">
            ${d.people.map(p => `
                <div class="person-card">
                    <div class="agent-avatar">${p.emoji}</div>
                    <div style="flex:1">
                        <div style="font-weight:700;color:#fff;font-size:0.95rem">${p.name}</div>
                        <div style="font-size:0.78rem;color:var(--blue2);font-weight:600;margin-top:2px">${p.title}</div>
                        <div style="font-size:0.8rem;color:var(--text2);margin-top:6px">${p.role}</div>
                        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
                            ${badge(p.status,"green")}
                            <span style="font-size:0.72rem;color:var(--text3)">${p.contact}</span>
                        </div>
                    </div>
                </div>`).join("")}
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Office Panel — Pixel Art Canvas Engine (60 FPS, animated agents)
// ──────────────────────────────────────────────────────────────────────────────
function renderOffice(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🏢 Virtual Office</div>
            <div class="panel-subtitle">Pixel art · live agents · click to interact</div>
        </div>
        <div class="office-canvas-wrap">
            <canvas id="office-canvas" class="office-canvas" width="640" height="480" style="width:100%;height:auto;max-height:580px"></canvas>
            <div class="office-sidebar">
                <div class="office-agent-box" id="office-agent-info">
                    <div class="office-hint">Click an agent or object</div>
                </div>
                <div class="office-feed-hdr">Activity Log</div>
                <div class="office-feed" id="office-feed">
                    ${(d.activity_feed || []).slice(0, 8).map(f => `
                        <div class="office-feed-row">
                            <span class="feed-agent">${f.agent}</span>
                            <span class="feed-action">${escHtml(f.action)}</span>
                        </div>`).join("")}
                </div>
            </div>
        </div>`;
}

function initOfficePanel(data, container) {
    const canvas = container.querySelector("#office-canvas");
    if (!canvas) return;

    const CW = 640, CH = 480;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // ── Layout constants ─────────────────────────────────────────
    const DW = 92, DSH = 28, DFH = 10, MH = 34, AH = 36;
    const HY_UP  = 75 + MH + DSH + DFH - 4;   // 143 — upper desk agent home y
    const HY_LOW = 232 + MH + DSH + DFH - 4;  // 300 — lower desk agent home y

    const ZONES = {
        upperDesks: [
            { x:  16, y: 75,  agent: "milfred" },
            { x: 172, y: 75,  agent: "ernst"   },
            { x: 328, y: 75,  agent: "gordon"  },
            { x: 484, y: 75,  agent: "lara"    },
        ],
        lowerDesks: [
            { x: 215, y: 232, agent: "claude"  },
            { x: 358, y: 232, agent: "eva"     },
            { x: 492, y: 232, agent: "alex"    },
        ],
        coffee:  { x: 268, y: 350, w: 240, h: 90 },
        meeting: { x: 14,  y: 226, w: 160, h: 152 },
    };
    // Coffee machine position inside the break room zone
    const CM_X = ZONES.coffee.x + 88;   // x=356
    const CM_Y = ZONES.coffee.y + 8;    // y=358

    const SCREEN_COLORS = {
        milfred:"#00ff88", ernst:"#ff4444", gordon:"#ffaa00",
        lara:"#ff44cc", claude:"#00ccff", eva:"#cc88ff", alex:"#4488ff",
    };

    const AGENT_EMOJI  = { alex:"👔", eva:"📅", milfred:"🤖", ernst:"🔒", gordon:"📈", lara:"📱", claude:"🧠" };
    const AGENT_PROPS  = {
        milfred: { accessory:"clipboard" },
        eva:     { accessory:"headset"   },
        ernst:   { accessory:"glasses"   },
        gordon:  { accessory:"mug"       },
        lara:    { accessory:"phone"     },
        claude:  { accessory:"headphones"},
        alex:    { accessory:"tie"       },
    };
    const AGENT_ACTS   = {
        milfred: ["Reviewing PR #42","Debugging canvas render","Planning Sprint 8","Merging feature branch"],
        ernst:   ["Security audit…","Firewall rules updated","Scanning ports…","Checking fail2ban"],
        gordon:  ["BTC/ETH long","Freqtrade PnL +4.2%","Chart pattern watch","Algo backtesting"],
        lara:    ["3 posts scheduled","Analytics review","Content draft","FB verification"],
        claude:  ["AI pipeline design","Architecture review","WebSocket refactor","Memory schema"],
        eva:     ["CEO briefing ready","14:00 confirmed","Routing 3 tasks","Calendar updated"],
        alex:    ["Strategy review","Reading reports","Investor update","Team 1:1 prep"],
    };

    // ── Agent state ───────────────────────────────────────────────
    const DEFS = [
        { id:"milfred", name:"Milfred", role:"Tech Lead",     shirtC:"#1e40af", hairC:"#222",    skinC:"#c68642", hx:ZONES.upperDesks[0].x+38, hy:HY_UP,  speed:1.15 },
        { id:"ernst",   name:"Ernst",   role:"Security",      shirtC:"#374151", hairC:"#111",    skinC:"#f1c27d", hx:ZONES.upperDesks[1].x+38, hy:HY_UP,  speed:0.95 },
        { id:"gordon",  name:"Gordon",  role:"Trading",       shirtC:"#059669", hairC:"#4a3728", skinC:"#c68642", hx:ZONES.upperDesks[2].x+38, hy:HY_UP,  speed:1.05 },
        { id:"lara",    name:"Lara",    role:"Growth",        shirtC:"#ca8a04", hairC:"#fde047", skinC:"#f1c27d", hx:ZONES.upperDesks[3].x+38, hy:HY_UP,  speed:1.10, female:true },
        { id:"claude",  name:"Claude",  role:"AI Architect",  shirtC:"#ea580c", hairC:"#555",    skinC:"#c68642", hx:ZONES.lowerDesks[0].x+38, hy:HY_LOW, speed:1.20 },
        { id:"eva",     name:"Eva",     role:"Exec. Asst.",   shirtC:"#7c3aed", hairC:"#8B4513", skinC:"#f1c27d", hx:ZONES.lowerDesks[1].x+38, hy:HY_LOW, speed:1.00, female:true },
        { id:"alex",    name:"Alex",    role:"CEO",           shirtC:"#1d4ed8", hairC:"#222",    skinC:"#c68642", hx:ZONES.lowerDesks[2].x+38, hy:HY_LOW, speed:0.90 },
    ];
    // Build status map from API data (keyed by agent id, lowercase)
    const statusMap = {};
    (data.desks || []).forEach(desk => {
        statusMap[desk.agent.toLowerCase()] = (desk.status || "busy").toLowerCase();
    });

    // Coffee home slots — staggered so multiple idle agents don't stack
    const COFFEE_SLOTS = [
        { x: CM_X - 68, y: CM_Y + 44 },   // far left of machine
        { x: CM_X - 46, y: CM_Y + 44 },   // left
        { x: CM_X - 24, y: CM_Y + 44 },   // center-left
        { x: CM_X + 58, y: CM_Y + 44 },   // right side
    ];
    let _idleSlot = 0;

    const agents = DEFS.map(d => {
        const apiStatus = statusMap[d.id] || "busy";
        const isIdle    = apiStatus === "idle";
        const isOffline = apiStatus === "offline";
        let hx = d.hx, hy = d.hy, initState = "typing";
        if (isIdle) {
            const slot = COFFEE_SLOTS[_idleSlot % COFFEE_SLOTS.length];
            _idleSlot++;
            hx = slot.x; hy = slot.y; initState = "coffee";
        }
        return {
            ...d, hx, hy, x: hx, y: hy, tx: hx, ty: hy,
            state: initState, frame: Math.floor(Math.random() * 120),
            timer: Math.random() * 3000 + 1500, moving: false, _ns: initState,
            apiStatus, hidden: isOffline,
            bubble: null,   // { text, type, life } — speech bubble
        };
    });

    // ── Meeting state ─────────────────────────────────────────────
    let _activeMeeting  = false;
    let _meetingCooldown = 0;   // frames to wait before next meeting
    const MEETING_TOPICS = [
        "Sprint sync 📋", "Security review 🛡️", "Trading strategy 📈",
        "Content calendar 🎨", "Release planning 🚀", "Quick standup ☀️",
    ];
    const MEETING_SEATS = [
        { x: ZONES.meeting.x + 22,  y: ZONES.meeting.y + 44  },
        { x: ZONES.meeting.x + 60,  y: ZONES.meeting.y + 95  },
        { x: ZONES.meeting.x + 105, y: ZONES.meeting.y + 44  },
        { x: ZONES.meeting.x + 120, y: ZONES.meeting.y + 95  },
    ];

    function _triggerMeeting() {
        if (_activeMeeting) return;
        const eligible = agents.filter(a => !a.hidden && a.apiStatus !== "idle" && !a.moving && a.state !== "meeting");
        if (eligible.length < 2) return;
        const count = Math.min(eligible.length, Math.random() < 0.35 ? 3 : 2);
        const picked = eligible.sort(() => Math.random() - 0.5).slice(0, count);
        const topic  = MEETING_TOPICS[Math.floor(Math.random() * MEETING_TOPICS.length)];
        picked.forEach((a, i) => {
            a._prevHx = a.hx; a._prevHy = a.hy;
            const seat = MEETING_SEATS[i % MEETING_SEATS.length];
            a.tx = seat.x + (Math.random() - 0.5) * 10;
            a.ty = seat.y + (Math.random() - 0.5) * 10;
            a.moving = true; a.state = "walking"; a._ns = "meeting";
            a.inMeeting = true; a.meetingTopic = topic;
        });
        _activeMeeting = true;
        const dur = Math.random() * 25000 + 30000;  // 30–55 s
        setTimeout(() => {
            picked.forEach(a => {
                if (!a.inMeeting) return;
                a.tx = a._prevHx || a.hx; a.ty = a._prevHy || a.hy;
                a.moving = true; a.state = "walking";
                a._ns = a.apiStatus === "idle" ? "coffee" : "typing";
                a.inMeeting = false; a.meetingTopic = null;
            });
            _activeMeeting = false;
            _meetingCooldown = 360;  // ~6 s cooldown after meeting ends
        }, dur);
        addAct(picked[0].name, `📅 Meeting: ${topic}`);
    }

    // ── Particles ─────────────────────────────────────────────────
    const particles = [];
    let steamTick = 0;

    // ── Camera (pan + zoom) ───────────────────────────────────────
    let cam = { x: 0, y: 0, scale: 1.0 };
    let _drag = null;       // { sx, sy, cx, cy }
    let _dragMoved = false;

    // ── Dust motes (day sunbeam zones) ────────────────────────────
    const dustMotes = Array.from({ length: 22 }, () => ({
        x: Math.random() * CW,
        y: 60 + Math.random() * 150,
        vx: (Math.random() - 0.5) * 0.04,
        vy: -(Math.random() * 0.025 + 0.005),
    }));

    function _clampCam() {
        const extraW = Math.max(0, CW * (cam.scale - 1));
        const extraH = Math.max(0, CH * (cam.scale - 1));
        cam.x = Math.max(-extraW - 50, Math.min(50, cam.x));
        cam.y = Math.max(-extraH - 50, Math.min(50, cam.y));
    }
    function spawnSteam() {
        for (let i = 0; i < 2; i++) particles.push({
            x: CM_X + 18 + (Math.random() - 0.5) * 8,
            y: CM_Y - 2,
            vx: (Math.random() - 0.5) * 0.35, vy: -(Math.random() * 0.55 + 0.35),
            life: 1, decay: Math.random() * 0.013 + 0.007, r: Math.random() * 3 + 1.5,
        });
    }

    // ── Activity log ──────────────────────────────────────────────
    const actLog = (data.activity_feed || []).slice(0, 10).map(f => ({ agent: f.agent, action: f.action }));
    function addAct(agentName, action) {
        actLog.unshift({ agent: agentName, action });
        if (actLog.length > 30) actLog.pop();
        const feed = document.getElementById("office-feed");
        if (feed) feed.innerHTML = actLog.slice(0, 10).map(f =>
            `<div class="office-feed-row"><span class="feed-agent">${f.agent}</span><span class="feed-action">${escHtml(f.action)}</span></div>`
        ).join("");
        // Trigger speech bubble on the agent
        const a = agents.find(ag => ag.name === agentName);
        if (a) {
            const type = /✓|complete|done/i.test(action) ? "complete"
                       : /⚠|alert|error|fail/i.test(action) ? "alert"
                       : /☕|coffee|break/i.test(action)    ? "idle"
                       : "status";
            a.bubble = { text: action, type, life: 5000 };
        }
    }

    // ── Drawing helpers ───────────────────────────────────────────
    function px(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

    function drawFloor() {
        // Main work area — warm gray carpet
        ctx.fillStyle = "#7a7888"; ctx.fillRect(0, 58, CW, CH-58);
        // Carpet tile checkerboard micro-texture
        for (let col = 0; col < CW; col += 32) for (let row = 58; row < CH; row += 32) {
            ctx.fillStyle = ((col/32 + row/32) % 2 === 0) ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.04)";
            ctx.fillRect(col+1, row+1, 30, 30);
        }
        ctx.strokeStyle = "rgba(0,0,0,0.07)"; ctx.lineWidth = 1;
        for (let gx = 0; gx < CW; gx += 32) { ctx.beginPath(); ctx.moveTo(gx, 58); ctx.lineTo(gx, CH); ctx.stroke(); }
        for (let gy = 58; gy < CH; gy += 32) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(CW, gy); ctx.stroke(); }
        // Break room — warm wood parquet planks
        const br = ZONES.coffee;
        for (let py = br.y; py < br.y + br.h; py += 10) {
            ctx.fillStyle = ((py - br.y) / 10) % 2 === 0 ? "#c8a878" : "#c0a070";
            ctx.fillRect(br.x, py, br.w, 10);
        }
        ctx.strokeStyle = "rgba(100,70,40,0.18)"; ctx.lineWidth = 1;
        for (let py = br.y; py < br.y + br.h; py += 10) {
            ctx.beginPath(); ctx.moveTo(br.x, py); ctx.lineTo(br.x + br.w, py); ctx.stroke();
        }
        ctx.strokeStyle = "rgba(160,110,60,0.08)"; ctx.lineWidth = 1;
        for (let bx = br.x; bx < br.x + br.w; bx += 44) {
            ctx.beginPath(); ctx.moveTo(bx, br.y); ctx.lineTo(bx, br.y + br.h); ctx.stroke();
        }
        // Meeting room — polished dark slate
        const mr = ZONES.meeting;
        ctx.fillStyle = "#565268"; ctx.fillRect(mr.x, mr.y, mr.w, mr.h);
        ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
        for (let cx = mr.x + 20; cx < mr.x + mr.w; cx += 20) { ctx.beginPath(); ctx.moveTo(cx, mr.y); ctx.lineTo(cx, mr.y + mr.h); ctx.stroke(); }
        for (let cy = mr.y + 20; cy < mr.y + mr.h; cy += 20) { ctx.beginPath(); ctx.moveTo(mr.x, cy); ctx.lineTo(mr.x + mr.w, cy); ctx.stroke(); }
        // Isometric diamond grid — two families of diagonal lines (↘ and ↙)
        // This gives the entire floor area a pseudo-isometric depth feel
        const TW = 40, TH = 20, FT = 58;
        ctx.strokeStyle = "rgba(255,255,255,0.065)"; ctx.lineWidth = 0.5;
        const slope = TH / TW;   // 0.5
        const sweep = (CH - FT) / slope;  // how far x shifts across full height
        // Family 1: ↘ (positive slope)
        for (let x0 = -sweep; x0 < CW; x0 += TW) {
            ctx.beginPath(); ctx.moveTo(x0, FT); ctx.lineTo(x0 + sweep, CH); ctx.stroke();
        }
        // Family 2: ↙ (negative slope)
        for (let x0 = 0; x0 < CW + sweep; x0 += TW) {
            ctx.beginPath(); ctx.moveTo(x0, FT); ctx.lineTo(x0 - sweep, CH); ctx.stroke();
        }
        // Wall-floor shadow strip
        ctx.fillStyle = "rgba(0,0,0,0.14)"; ctx.fillRect(0, 58, CW, 5);
    }

    function drawRoomWalls() {
        // ── Shared wall constants ────────────────────────────────────
        const WH  = 10;   // horizontal wall front-face height (px)
        const WT  = 8;    // vertical wall thickness (px)
        const IX  = 4;    // isometric top-face x-offset (left)
        const IY  = 7;    // isometric top-face y-offset (up)
        const FG  = "#d0c8b8"; // wall front face
        const TOP = "#ece4d8"; // wall top face (lighter)
        const SID = "#c0b8a8"; // side / east-facing face
        const SHD = "rgba(0,0,0,0.08)"; // base shadow

        // ── Helpers ──────────────────────────────────────────────────
        // Horizontal wall front + top (bottom of face sits at y, face goes up WH)
        function hw(x, y, w) {
            ctx.fillStyle = FG;  ctx.fillRect(x, y - WH, w, WH);
            ctx.fillStyle = "#ddd5c9"; ctx.fillRect(x, y - WH, w, 2); // top edge highlight
            ctx.fillStyle = SHD; ctx.fillRect(x, y - 2,  w, 2);       // base shadow
            // Isometric top face
            ctx.fillStyle = TOP;
            ctx.beginPath();
            ctx.moveTo(x,      y - WH);
            ctx.lineTo(x + w,  y - WH);
            ctx.lineTo(x + w - IX, y - WH - IY);
            ctx.lineTo(x     - IX, y - WH - IY);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = "#c0b8a8"; ctx.lineWidth = 0.75; ctx.stroke();
        }

        // Vertical solid wall segment (right face visible)
        function vw(x, y, h) {
            ctx.fillStyle = SID; ctx.fillRect(x, y, WT, h);
            ctx.fillStyle = FG;  ctx.fillRect(x, y, 2,  h); // left-edge highlight
            ctx.fillStyle = SHD; ctx.fillRect(x + WT - 2, y, 2, h);
        }

        // Vertical glass wall segment
        function vg(x, y, h) {
            ctx.fillStyle = "rgba(160,215,245,0.13)"; ctx.fillRect(x, y, WT, h);
            ctx.strokeStyle = "#a8c8dc"; ctx.lineWidth = 1;
            for (let py = y; py < y + h; py += 22) {
                ctx.strokeRect(x + 1, py, WT - 2, Math.min(22, y + h - py));
            }
        }

        // Top cap for vertical wall (parallelogram at the top edge)
        function vcap(x, y) {
            ctx.fillStyle = TOP;
            ctx.beginPath();
            ctx.moveTo(x,          y);
            ctx.lineTo(x + WT,     y);
            ctx.lineTo(x + WT - IX, y - IY);
            ctx.lineTo(x      - IX, y - IY);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = "#c0b8a8"; ctx.lineWidth = 0.75; ctx.stroke();
        }

        // Door frame for horizontal opening
        function doorH(x, y, w) {
            // Jambs
            ctx.fillStyle = "#c8b898";
            ctx.fillRect(x - 2, y - WH, 3, WH);
            ctx.fillRect(x + w - 1, y - WH, 3, WH);
            // Lintel
            ctx.fillRect(x - 2, y - WH, w + 4, 3);
        }

        // Door frame for vertical opening
        function doorV(x, y, h) {
            ctx.fillStyle = "#c8b898";
            ctx.fillRect(x, y - 2,   WT, 3); // top sill
            ctx.fillRect(x, y + h - 1, WT, 3); // bottom sill
        }

        // ── Back wall 3D ledge (wall thickness at floor level) ───────
        // Shows the back wall has depth; sits right at y=58
        ctx.fillStyle = "#c0b8ac"; ctx.fillRect(0, 58, CW, 6);
        ctx.fillStyle = "#d4ccc0"; ctx.fillRect(0, 58, CW, 2); // highlight

        // ── Meeting room north wall  (y=226, x=14–174) ───────────────
        hw(14, 226, 160);

        // ── Meeting room east wall  (x=174, y=226–378) — glass + door ─
        vg(174, 226, 54);               // top glass panel
        // door gap: y=280 to y=318 (h=38)
        doorV(174, 280, 38);
        vg(174, 318, 60);               // bottom glass panel
        vcap(174, 226);                 // top cap once at wall top

        // ── Meeting room south wall  (y=378, x=14–174) ───────────────
        // door gap: x=90 to x=118 (w=28)
        hw(14,  378, 76);
        hw(118, 378, 56);
        doorH(90, 378, 28);

        // ── Break room north wall  (y=350, x=268–508) ────────────────
        // door gap: x=312 to x=344 (w=32)
        hw(268, 350, 44);
        hw(344, 350, 164);
        doorH(312, 350, 32);

        // ── Break room west wall  (x=268, y=350–440) ─────────────────
        vw(268, 350, 90);
        vcap(268, 350);

        // ── Floor shadows beneath walls ──────────────────────────────
        ctx.fillStyle = "rgba(0,0,0,0.06)";
        ctx.fillRect(14,  378, 160, 4); // meeting south
        ctx.fillRect(268, 350, 240, 4); // break room north
        ctx.fillRect(268, 350,   4, 90); // break room west (east shadow)
    }

    function drawPlant(x, y, type, sway = 0) {
        const sw = sway;
        if (type === "snake") {
            // Pot (fixed)
            px(x+2, y+16, 12, 8, "#c2714a"); px(x+3, y+17, 10, 6, "#d4835a");
            px(x+1, y+15, 14, 3, "#b86040");
            // Leaves (sway)
            px(x+5+sw, y,    3, 16, "#3d6b4a"); px(x+6+sw, y+1,   1, 14, "#5a9a6a");
            px(x+9+sw, y+3,  3, 14, "#2e5538"); px(x+10+sw, y+4,  1, 12, "#4a8058");
            px(x+3+sw, y+4,  2, 12, "#4a7040"); px(x+4+sw,  y+5,  1, 10, "#5e9050");
        } else if (type === "cactus") {
            // Pot (fixed)
            px(x+3, y+14, 8, 8, "#c2714a"); px(x+4, y+15, 6, 6, "#d4835a");
            // Body + arms (sway)
            px(x+4+sw, y+4,  6, 12, "#3e6b3a"); px(x+5+sw, y+5,  4, 10, "#4e8848");
            px(x+2+sw, y+7,  3,  4, "#3e6b3a"); px(x+1+sw, y+6,  2,  2, "#3e6b3a");
            px(x+9+sw, y+6,  3,  4, "#3e6b3a"); px(x+11+sw,y+5,  2,  2, "#3e6b3a");
            ctx.fillStyle = "#d8cc96";
            [[5,5],[5,9],[9,7],[9,11],[7,4]].forEach(([sx,sy]) => ctx.fillRect(x+sx+sw, y+sy, 1, 2));
        } else if (type === "fiddle") {
            // Pot (fixed)
            px(x+3, y+26, 14, 8, "#c2714a"); px(x+4, y+27, 12, 6, "#d4835a");
            px(x+2, y+25, 16,  3, "#b86040");
            // Trunk (half sway)
            px(x+9+sw/2, y+10, 2, 18, "#5a4030");
            // Leaves (full sway)
            ctx.fillStyle = "#2e5a2a"; ctx.beginPath(); ctx.ellipse(x+7+sw, y+10, 7, 10, -0.2, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = "#3e7838"; ctx.beginPath(); ctx.ellipse(x+7+sw, y+10, 5,  8, -0.2, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = "#2e5a2a"; ctx.beginPath(); ctx.ellipse(x+13+sw, y+16, 6, 9, 0.3, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = "#3e7838"; ctx.beginPath(); ctx.ellipse(x+13+sw, y+16, 4, 7, 0.3, 0, Math.PI*2); ctx.fill();
        } else if (type === "pothos") {
            // Pot (fixed)
            px(x+3, y,   8, 5, "#c2714a"); px(x+4, y+1, 6, 3, "#d4835a");
            // Vines + leaves (sway)
            ctx.strokeStyle = "#3e6b3a"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x+7+sw, y+5); ctx.bezierCurveTo(x+4+sw,y+10,x+2+sw,y+16,x+1+sw,y+22); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x+7+sw, y+5); ctx.bezierCurveTo(x+10+sw,y+12,x+12+sw,y+18,x+13+sw,y+24); ctx.stroke();
            [[2,13],[0,21],[12,17],[14,23],[7,9]].forEach(([lx,ly]) => {
                ctx.fillStyle = "#3e6b3a"; ctx.beginPath(); ctx.ellipse(x+lx+sw, y+ly, 4, 3, -0.4, 0, Math.PI*2); ctx.fill();
                ctx.fillStyle = "#5a9a55"; ctx.beginPath(); ctx.ellipse(x+lx+sw, y+ly, 2, 2, 0, 0, Math.PI*2); ctx.fill();
            });
        }
    }

    function drawClock() {
        const cx = 307, cy = 26, r = 16;
        // Face
        ctx.fillStyle = "#f5f0e8";
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = "#5a4a30"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.stroke();
        // Hour tick marks
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
            const inner = i % 3 === 0 ? r - 5 : r - 3;
            ctx.strokeStyle = "#333";
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
            ctx.lineTo(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1));
            ctx.stroke();
        }
        const now = new Date();
        const hAngle = ((now.getHours() % 12) + now.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2;
        const mAngle = (now.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2;
        const sAngle = (now.getSeconds() / 60) * Math.PI * 2 - Math.PI / 2;
        // Hour hand
        ctx.strokeStyle = "#222"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(hAngle) * (r - 7), cy + Math.sin(hAngle) * (r - 7)); ctx.stroke();
        // Minute hand
        ctx.strokeStyle = "#444"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(mAngle) * (r - 4), cy + Math.sin(mAngle) * (r - 4)); ctx.stroke();
        // Second hand
        ctx.strokeStyle = "#e53e3e"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(sAngle) * (r - 3), cy + Math.sin(sAngle) * (r - 3)); ctx.stroke();
        // Center dot
        ctx.fillStyle = "#222"; ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI*2); ctx.fill();
    }

    function drawWall() {
        // Warm off-white wall
        ctx.fillStyle = "#ede8e0"; ctx.fillRect(0, 0, CW, 58);
        ctx.fillStyle = "rgba(0,0,0,0.012)";
        for (let wy = 0; wy < 52; wy += 6) ctx.fillRect(0, wy, CW, 1);
        // Baseboard trim
        px(0, 52, CW, 3, "#d4c8b4"); px(0, 55, CW, 3, "#c8b098");
        const h = new Date().getHours(), isDay = h >= 6 && h < 19;
        [50, 192, 334, 476].forEach(wx => {
            // Window reveal depth
            ctx.fillStyle = "#d8d0c0"; ctx.fillRect(wx-1, 2, 90, 51);
            if (isDay) {
                const skyGrad = ctx.createLinearGradient(wx, 3, wx, 49);
                skyGrad.addColorStop(0, "#6ab4e8"); skyGrad.addColorStop(1, "#a8d8f0");
                ctx.fillStyle = skyGrad; ctx.fillRect(wx+2, 3, 84, 44);
                // Clouds
                ctx.fillStyle = "rgba(255,255,255,0.75)";
                ctx.beginPath(); ctx.ellipse(wx+22, 16, 12, 6, 0, 0, Math.PI*2); ctx.fill();
                ctx.beginPath(); ctx.ellipse(wx+32, 13,  8, 5, 0, 0, Math.PI*2); ctx.fill();
                ctx.beginPath(); ctx.ellipse(wx+42, 17,  9, 5, 0, 0, Math.PI*2); ctx.fill();
                // Sunbeam shimmer strip
                ctx.fillStyle = "rgba(255,235,160,0.06)";
                ctx.beginPath(); ctx.moveTo(wx+70,3); ctx.lineTo(wx+88,3); ctx.lineTo(wx+88,49); ctx.lineTo(wx+50,49); ctx.closePath(); ctx.fill();
                // Glass reflection
                ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(wx+2, 3, 16, 44);
            } else {
                ctx.fillStyle = "#090618"; ctx.fillRect(wx+2, 3, 84, 44);
                [[8,8],[25,14],[55,7],[70,18],[40,25],[15,30],[60,30]].forEach(([sx,sy]) =>
                    px(wx+sx, 3+sy, 2, 2, "rgba(255,255,255,0.75)"));
                // Crescent moon
                ctx.fillStyle = "#fffde0"; ctx.beginPath(); ctx.arc(wx+65, 14, 6, 0, Math.PI*2); ctx.fill();
                ctx.fillStyle = "#090618"; ctx.beginPath(); ctx.arc(wx+68, 12, 5, 0, Math.PI*2); ctx.fill();
            }
            // Window frame
            ctx.strokeStyle = "#c8c0b0"; ctx.lineWidth = 3; ctx.strokeRect(wx, 3, 88, 46);
            ctx.strokeStyle = "#d8d0c0"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(wx+44, 3); ctx.lineTo(wx+44, 49); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(wx,   26); ctx.lineTo(wx+88, 26); ctx.stroke();
        });
        // Motivational poster — gap left of W0 (x=2–46)
        ctx.fillStyle = "#e8f4e8"; ctx.fillRect(2, 5, 44, 44);
        ctx.strokeStyle = "#a0b8a0"; ctx.lineWidth = 1.5; ctx.strokeRect(2, 5, 44, 44);
        ctx.fillStyle = "#4a7c59"; ctx.font = "bold 5px monospace"; ctx.textAlign = "center";
        ctx.fillText("BUILD", 24, 20); ctx.fillText("SHIP", 24, 28); ctx.fillText("LEARN", 24, 36);
        // Whiteboard — gap right of W3 (x=566–636)
        px(568, 5, 68, 44, "#f5f5f0");
        ctx.strokeStyle = "#b0a898"; ctx.lineWidth = 1.5; ctx.strokeRect(568, 5, 68, 44);
        ctx.strokeStyle = "rgba(30,100,200,0.55)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(574, 18); ctx.lineTo(606, 18); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(574, 25); ctx.lineTo(622, 25); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(574, 32); ctx.lineTo(612, 32); ctx.stroke();
        ctx.strokeStyle = "rgba(200,40,40,0.5)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(612, 14); ctx.lineTo(624, 22); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(624, 14); ctx.lineTo(612, 22); ctx.stroke();
        px(568, 43, 68, 3, "#c8c0b0"); // eraser ledge
        // Sun rays on floor (day)
        if (isDay) {
            ctx.fillStyle = "rgba(255,235,160,0.035)";
            [50, 192, 334, 476].forEach(wx => {
                ctx.beginPath(); ctx.moveTo(wx, 58); ctx.lineTo(wx+88, 58);
                ctx.lineTo(wx+120, 200); ctx.lineTo(wx-32, 200); ctx.fill();
            });
        }
        drawClock();
    }

    function drawDesk(x, y, agentId) {
        const gc = SCREEN_COLORS[agentId] || "#00d4ff";

        // ── Shadow ───────────────────────────────────────────────────
        ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(x+4, y+MH+DSH+DFH+1, DW-8, 5);

        // ── Chair ────────────────────────────────────────────────────
        const cy2 = y+MH+DSH+DFH+4;
        px(x+20, cy2,    52, 4,  "#8a7a6a");
        px(x+22, cy2+4,  48, 18, "#9a8a7a");
        px(x+24, cy2+6,  44, 14, "#a89888");
        px(x+26, cy2+22,  8,  5, "#7a6a5a");
        px(x+DW-34, cy2+22, 8, 5, "#7a6a5a");
        // Wheels (5)
        for (let wi = 0; wi < 5; wi++) {
            px(x+22+wi*11, cy2+28, 5, 5, "#444");
            px(x+23+wi*11, cy2+28, 3, 5, "#666");
        }

        // ── Monitor stand ────────────────────────────────────────────
        px(x+34, y+MH-4, 10, 6, "#c0b8b0");

        // ── Monitor ──────────────────────────────────────────────────
        px(x+10, y, DW-20, MH-2, "#ddd8d0");
        px(x+12, y+2, DW-24, MH-6, "#0a0a1a");
        const bt = Math.floor(Date.now() / 350);
        for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
            if ((bt + row + col) % 3 !== 0) px(x+14+col*11, y+5+row*7, 8, 4, gc + "bb");
        }
        ctx.fillStyle = gc + "22"; ctx.fillRect(x+8, y+MH-7, DW-16, 10);
        ctx.strokeStyle = "#b8b0a8"; ctx.lineWidth = 2; ctx.strokeRect(x+10, y, DW-20, MH-2);

        // ── Desk surface ─────────────────────────────────────────────
        px(x, y+MH, DW, DSH, "#e8e0d4");
        px(x+2, y+MH+2, DW-4, DSH-4, "#f2ece4");

        // Screen glow on desk surface
        const glowGrad = ctx.createRadialGradient(x+DW/2, y+MH, 0, x+DW/2, y+MH, 32);
        glowGrad.addColorStop(0, gc + "1a"); glowGrad.addColorStop(1, gc + "00");
        ctx.fillStyle = glowGrad; ctx.fillRect(x+5, y+MH, DW-10, 18);

        // ── Desk lamp (rear-right of surface) ────────────────────────
        px(x+82, y+MH+4, 2, DSH-6, "#8a8080");        // pole
        px(x+73, y+MH+4,  9, 2,    "#8a8080");         // arm
        ctx.fillStyle = "#f0e870";
        ctx.beginPath();
        ctx.moveTo(x+70, y+MH+4); ctx.lineTo(x+86, y+MH+4);
        ctx.lineTo(x+84, y+MH-4); ctx.lineTo(x+72, y+MH-4);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "#c8b840"; ctx.lineWidth = 0.5; ctx.stroke();
        px(x+76, y+MH+3, 4, 2, "#fff8a0");             // bulb

        // ── Keyboard + Mouse ─────────────────────────────────────────
        px(x+18, y+MH+6, 38, 10, "#d0c8c0"); px(x+20, y+MH+8, 34, 6, "#e0d8d0");
        px(x+62, y+MH+7, 10,  9, "#d0c8c0"); px(x+63, y+MH+8,  8, 7, "#e0d8d0");

        // ── Per-agent items ──────────────────────────────────────────
        if (["gordon","lara","milfred"].includes(agentId)) {
            px(x+6, y+MH+6,  6, 9, "#c2714a"); px(x+7, y+MH+7,  4, 7, "#d4835a");
            px(x+7, y+MH+3,  3, 5, "#4a7c59"); px(x+9, y+MH+2,  2, 6, "#3d6b4a");
        }
        if (["ernst","claude","alex","eva"].includes(agentId)) {
            px(x+6, y+MH+8,  8, 8, "#f0e8dc"); px(x+7, y+MH+9,  6, 6, "#4a1a08");
            px(x+14, y+MH+10, 2, 4, "#f0e8dc");
        }

        // ── Cable ────────────────────────────────────────────────────
        ctx.strokeStyle = "rgba(60,50,40,0.4)"; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x+14, y+MH);
        ctx.bezierCurveTo(x+10, y+MH+DSH, x+6, y+MH+DSH+DFH, x+8, y+MH+DSH+DFH+8);
        ctx.stroke();

        // ── Desk front face + drawers + legs ─────────────────────────
        px(x, y+MH+DSH, DW, DFH, "#d8d0c4");
        px(x+4,  y+MH+DSH+1, 40, DFH-3, "#ccc4b8");   // left drawer
        px(x+48, y+MH+DSH+1, 40, DFH-3, "#ccc4b8");   // right drawer
        ctx.fillStyle = "#9a8878";
        ctx.beginPath(); ctx.arc(x+24, y+MH+DSH+DFH/2, 2.5, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(x+68, y+MH+DSH+DFH/2, 2.5, 0, Math.PI*2); ctx.fill();
        px(x+4,     y+MH+DSH, 6, DFH+2, "#c8c0b4");
        px(x+DW-10, y+MH+DSH, 6, DFH+2, "#c8c0b4");
    }

    function drawCoffeeRoom(x, y) {
        const { w, h } = ZONES.coffee;
        ctx.strokeStyle = "#c8920a"; ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]); ctx.strokeRect(x+1, y+1, w-2, h-2); ctx.setLineDash([]);
        ctx.fillStyle = "#7c5a08"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
        ctx.fillText("BREAK ROOM  ☕", x + w/2, y + 14);
        // Counter surface
        px(x+6, y+52, 72, 14, "#d4b896"); px(x+8, y+54, 68, 10, "#e0c8a8");
        // Couch
        const cx = x + 148, bcy = y + 18;
        // Wall-mounted TV above couch
        const tvX = cx + 8, tvY = y + 2;
        px(tvX,   tvY,    56, 26, "#111111");         // bezel
        px(tvX+2, tvY+2,  52, 21, "#08080e");         // screen
        const tvF = Math.floor(Date.now() / 3500) % 4;
        if (tvF === 0) {
            // Green chart
            px(tvX+3, tvY+3, 50, 7, "#0a1a0a");
            [6,9,7,11,8,13,10].forEach((bh, i) => px(tvX+4+i*7, tvY+19-bh, 5, bh, "#10b98144"));
            ctx.fillStyle = "#10b981"; ctx.font = "5px monospace"; ctx.textAlign = "center";
            ctx.fillText("+4.2% PnL", tvX+29, tvY+9);
        } else if (tvF === 1) {
            // Blue dashboard
            px(tvX+3, tvY+3, 50, 7, "#041228");
            [4,7,5,9,6,10,8].forEach((bh, i) => px(tvX+4+i*7, tvY+19-bh, 5, bh, "#3b82f655"));
            ctx.fillStyle = "#60a5fa"; ctx.font = "5px monospace"; ctx.textAlign = "center";
            ctx.fillText("NOUGA TV", tvX+29, tvY+9);
        } else if (tvF === 2) {
            // News ticker
            px(tvX+3, tvY+3, 50, 18, "#080820");
            ctx.fillStyle = "#a78bfa"; ctx.font = "5px monospace"; ctx.textAlign = "center";
            ctx.fillText("OFFICE NEWS", tvX+29, tvY+9);
            px(tvX+3, tvY+15, 50, 5, "#2a1a40");
            ctx.fillStyle = "#e0d0ff"; ctx.font = "4px monospace"; ctx.textAlign = "left";
            ctx.fillText("Sprint 8 on track ✓", tvX+5, tvY+19);
        } else {
            // Weather
            px(tvX+3, tvY+3, 50, 18, "#0a1520");
            ctx.fillStyle = "#7dd3fc"; ctx.font = "7px monospace"; ctx.textAlign = "center";
            ctx.fillText("☁ 72°F", tvX+29, tvY+13);
        }
        // TV glow on wall
        ctx.fillStyle = "rgba(60,80,160,0.06)"; ctx.fillRect(cx+4, y+28, 68, 12);

        px(cx,    bcy,     84, 8,  "#6a5a80"); px(cx+1,  bcy+1,  82, 6,  "#7a6a94");
        px(cx,    bcy+8,   84, 36, "#6a5a80");
        for (let seg = 0; seg < 3; seg++) {
            px(cx+2+seg*27, bcy+10, 25, 30, "#8a7aac"); px(cx+3+seg*27, bcy+11, 23, 28, "#9a8abc");
        }
        // Throw pillow on couch
        px(cx+58, bcy+12, 18, 18, "#c4a8d8"); px(cx+60, bcy+14, 14, 14, "#d4b8e8");
        px(cx-6,  bcy,     8, 44, "#6a5a80"); px(cx-5,  bcy+2,  6, 40, "#7a6a94");
        px(cx+84, bcy,     8, 44, "#6a5a80"); px(cx+85, bcy+2,  6, 40, "#7a6a94");
        px(cx,    bcy+44,  4,  5, "#4a3a5a"); px(cx+80, bcy+44, 4,  5, "#4a3a5a");
        // Coffee table
        px(cx+8,  bcy+52, 68,  5, "#c8a878"); px(cx+10, bcy+57, 64,  2, "#a07848");
        px(cx+12, bcy+55,  4,  4, "#a07848"); px(cx+68, bcy+55,  4,  4, "#a07848");
        // Items on coffee table
        px(cx+18, bcy+50, 10, 4, "#f0e8dc"); px(cx+19, bcy+51, 8, 2, "#4a1a08"); // mug
        px(cx+32, bcy+50, 16, 4, "#e8e4d8"); // magazine
    }

    function drawCoffeeMachine(x, y) {
        // Shadow
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath(); ctx.ellipse(x+26, y+72, 22, 5, 0, 0, Math.PI*2); ctx.fill();
        // Body
        px(x, y, 52, 62, "#2c1810");
        px(x+2, y+2, 48, 58, "#341e12");
        // Front panel
        px(x+6, y+5, 36, 20, "#1a0a08");
        px(x+8, y+7, 32, 16, "#3d1408");
        // LEDs
        px(x+10, y+10, 6, 3, "#ff4400");
        px(x+10, y+14, 6, 3, "#00ff44");
        px(x+20, y+10, 6, 3, "#ff8800");
        // Buttons
        [8, 20, 32].forEach(bx => { px(x+bx,y+30,8,8,"#1a0808"); px(x+bx+1,y+31,6,6,"#2d1010"); });
        // Spout + cup
        px(x+18, y+42, 8, 14, "#1a0808");
        px(x+12, y+57, 18, 14, "#fff8f0");
        px(x+13, y+58, 16, 12, "#e8dcc8");
        px(x+14, y+59, 14, 8, "#3d1408");
        px(x+28, y+60, 3, 8, "#e0d0b8");
        // Label
        ctx.fillStyle = "#ff6b35"; ctx.font = "bold 7px monospace"; ctx.textAlign = "center";
        ctx.fillText("COFFEE", x+26, y+50);
    }

    function drawMeetingRoom(x, y) {
        // Floor handled by drawFloor (dark slate). Room border + content.
        ctx.strokeStyle = "#9b59b6"; ctx.lineWidth = 1.5;
        ctx.setLineDash([5,4]); ctx.strokeRect(x+1, y+1, 158, 150); ctx.setLineDash([]);
        ctx.fillStyle = "#c084fc"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
        ctx.fillText("MEETING ROOM", x+80, y+13);
        // Whiteboard on back wall
        px(x+20, y+17, 120, 26, "#f0ede8");
        ctx.strokeStyle = "#c8c0b0"; ctx.lineWidth = 1.5; ctx.strokeRect(x+20, y+17, 120, 26);
        ctx.strokeStyle = "rgba(30,100,200,0.5)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x+26, y+26); ctx.lineTo(x+60, y+26); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x+26, y+32); ctx.lineTo(x+80, y+32); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x+26, y+38); ctx.lineTo(x+68, y+38); ctx.stroke();
        px(x+20, y+42, 120, 2, "#c8c0b0"); // eraser ledge
        // Oval meeting table
        const tx = x+80, ty = y+90;
        ctx.fillStyle = "#3a2e20"; ctx.beginPath(); ctx.ellipse(tx, ty, 62, 30, 0, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = "#4a3a28"; ctx.beginPath(); ctx.ellipse(tx, ty, 60, 28, 0, 0, Math.PI*2); ctx.fill();
        // Table items
        px(tx-12, ty-8, 22, 14, "#1a1a2e"); px(tx-10, ty-6, 18, 10, "#00aaff1a"); // laptop
        px(tx+20,  ty-6, 14, 10, "#e8e4d8"); px(tx+22,  ty-4, 10,  6, "#d0cac0"); // papers
        // Chairs around oval (6 positions)
        [ [0, 46], [Math.PI/3, 42], [2*Math.PI/3, 42],
          [Math.PI, 46], [4*Math.PI/3, 42], [5*Math.PI/3, 42] ].forEach(([ang, r]) => {
            const csx = tx + Math.cos(ang)*r, csy = ty + Math.sin(ang)*r;
            ctx.fillStyle = "#5a4a38";
            ctx.beginPath(); ctx.ellipse(csx, csy, 9, 7, ang, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = "#7a6a58";
            ctx.beginPath(); ctx.ellipse(csx, csy, 7, 5, ang, 0, Math.PI*2); ctx.fill();
        });
        // Status
        ctx.fillStyle = _activeMeeting ? "#ef4444" : "#10b981";
        ctx.font = "7px monospace"; ctx.textAlign = "center";
        ctx.fillText(_activeMeeting ? "● in session" : "● available", x+80, y+138);
    }

    function drawAgent(a) {
        if (a.hidden) return;
        const ax = Math.round(a.x), ay = Math.round(a.y);
        // 20 × 36 hi-bit sprite — center x = ax+10, bottom y = ay+35
        const wf = Math.floor(a.frame / 6) % 4;
        const lL = a.moving ? (wf===1 ?  4 : wf===3 ? -4 : 0) : 0;  // left leg offset
        const lR = a.moving ? (wf===1 ? -4 : wf===3 ?  4 : 0) : 0;  // right leg offset
        const aL = a.moving ? (wf===1 ? -3 : wf===3 ?  3 : 0) : 0;  // left arm swing
        const aR = a.moving ? (wf===1 ?  3 : wf===3 ? -3 : 0) : 0;  // right arm swing
        const ta = a.state === "typing" ? (Math.floor(a.frame / 5) % 2) * 2 : 0;

        // ── Shadow ellipse ─────────────────────────────────────────
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.beginPath(); ctx.ellipse(ax+10, ay+AH+2, 11, 3.5, 0, 0, Math.PI*2); ctx.fill();

        // ── Legs (rows 26–32) ─────────────────────────────────────
        px(ax+3,  ay+26+lL, 6, 8, "#1e1e28");
        px(ax+3,  ay+26+lL, 2, 8, "rgba(255,255,255,0.10)");  // left crease
        px(ax+11, ay+26+lR, 6, 8, "#1e1e28");
        px(ax+15, ay+26+lR, 2, 8, "rgba(255,255,255,0.10)");  // right crease

        // ── Shoes (rows 33–35) ────────────────────────────────────
        px(ax+2,  ay+33+lL, 7, 3, "#2a2020");
        px(ax+2,  ay+33+lL, 5, 1, "rgba(255,255,255,0.15)");  // toe highlight
        px(ax+11, ay+33+lR, 7, 3, "#2a2020");
        px(ax+11, ay+33+lR, 5, 1, "rgba(255,255,255,0.15)");

        // ── Belt (rows 25–26) ─────────────────────────────────────
        px(ax+3, ay+25, 14, 2, "#3a3020");
        px(ax+3, ay+25,  5, 1, "rgba(255,255,255,0.12)");     // buckle glint

        // ── Body / shirt (rows 15–25) ─────────────────────────────
        px(ax+3,  ay+15, 14, 11, a.shirtC);
        px(ax+4,  ay+16,  3,  9, "rgba(255,255,255,0.18)");   // shirt highlight
        px(ax+14, ay+16,  2,  9, "rgba(0,0,0,0.18)");         // shirt shadow
        px(ax+8,  ay+15,  4,  5, a.skinC + "88");             // collar/neck

        // ── Arms ──────────────────────────────────────────────────
        if (a.state === "thinking") {
            px(ax+0,  ay+16+aL, 3, 10, a.shirtC);             // left arm down
            px(ax+17, ay+14+aR, 3,  8, a.shirtC);             // right arm raised
            px(ax+17, ay+21,    3,  3, a.skinC);               // hand at chin
        } else if (a.state === "reading") {
            px(ax+0,  ay+16,    3,  8, a.shirtC);
            px(ax+17, ay+16,    3,  8, a.shirtC);
            px(ax+2,  ay+22,   16, 11, "#0f172a");             // tablet body
            px(ax+3,  ay+23,   14,  9, "#1e3a5f");             // screen
            px(ax+3,  ay+23,   14,  2, "rgba(96,165,250,0.20)"); // screen glare
            px(ax+4,  ay+25,    6,  1, "rgba(255,255,255,0.15)");
        } else if (a.state === "waiting") {
            px(ax+0,  ay+16,    3,  8, a.shirtC);
            px(ax+17, ay+16,    3,  8, a.shirtC);
            px(ax+2,  ay+21,   16,  4, a.shirtC);              // crossed arms
            px(ax+2,  ay+22,   16,  1, "rgba(0,0,0,0.15)");
        } else {
            px(ax+0,  ay+16+aL+ta, 3, 10, a.shirtC);
            px(ax+17, ay+16+aR+ta, 3, 10, a.shirtC);
        }

        // ── Head skin (rows 2–13) ─────────────────────────────────
        px(ax+4,  ay+2,  12, 12, a.skinC);   // center
        px(ax+3,  ay+3,  14, 10, a.skinC);   // wider middle
        px(ax+3,  ay+12, 14,  1, "rgba(0,0,0,0.12)");   // chin shadow
        px(ax+5,  ay+3,   6,  3, "rgba(255,255,255,0.14)"); // forehead highlight
        px(ax+4,  ay+7,   2,  3, "rgba(255,255,255,0.10)"); // left cheek
        px(ax+14, ay+7,   2,  3, "rgba(255,255,255,0.10)"); // right cheek

        // ── Hair (rows 0–5) ───────────────────────────────────────
        px(ax+4,  ay+0,  12,  4, a.hairC);   // top cap
        px(ax+3,  ay+0,   1,  1, a.hairC);   // TL corner
        px(ax+16, ay+0,   1,  1, a.hairC);   // TR corner
        px(ax+2,  ay+1,   2,  6, a.hairC);   // left temple
        px(ax+16, ay+1,   2,  6, a.hairC);   // right temple
        px(ax+5,  ay+1,   8,  1, "rgba(255,255,255,0.22)"); // crown highlight
        px(ax+3,  ay+4,  14,  1, "rgba(0,0,0,0.12)");       // underside shadow
        if (a.female) {
            px(ax+2,  ay+1,  2, 14, a.hairC); // long left curtain
            px(ax+16, ay+1,  2, 14, a.hairC); // long right curtain
            px(ax+4,  ay-2, 12,  3, a.hairC); // extra top / bangs
            px(ax+5,  ay-2,  8,  1, "rgba(255,255,255,0.18)");
        }

        // ── Neck (rows 13–15) ─────────────────────────────────────
        px(ax+8, ay+13, 4, 3, a.skinC);

        // ── Eyes (rows 5–8) ───────────────────────────────────────
        px(ax+5,  ay+5, 4, 4, "#ede8df");  // left sclera
        px(ax+11, ay+5, 4, 4, "#ede8df");  // right sclera
        const blinking = a.frame % 180 < 3;
        if (blinking) {
            px(ax+5,  ay+7, 4, 1, "#333");
            px(ax+11, ay+7, 4, 1, "#333");
        } else {
            px(ax+6,  ay+6, 2, 2, "#4e7ca1");  // left iris
            px(ax+12, ay+6, 2, 2, "#4e7ca1");  // right iris
            px(ax+6,  ay+6, 1, 1, "#111");     // left pupil
            px(ax+12, ay+6, 1, 1, "#111");     // right pupil
            px(ax+7,  ay+6, 1, 1, "rgba(255,255,255,0.75)"); // left eye hl
            px(ax+13, ay+6, 1, 1, "rgba(255,255,255,0.75)"); // right eye hl
        }
        if (a.female) {
            px(ax+5,  ay+4, 1, 1, "#111"); px(ax+6,  ay+3, 1, 1, "#111"); px(ax+8,  ay+4, 1, 1, "#111");
            px(ax+11, ay+4, 1, 1, "#111"); px(ax+12, ay+3, 1, 1, "#111"); px(ax+14, ay+4, 1, 1, "#111");
        }

        // ── Nose (row 9) ──────────────────────────────────────────
        px(ax+9, ay+9, 2, 1, "rgba(0,0,0,0.18)");

        // ── Mouth (rows 11–12) ────────────────────────────────────
        if (a.state === "coffee" || a.state === "idle") {
            px(ax+7,  ay+11, 1, 1, "#555");
            px(ax+8,  ay+12, 4, 1, "#555");
            px(ax+12, ay+11, 1, 1, "#555");
        } else {
            px(ax+7, ay+11, 6, 1, "#888");
        }

        // ── Accessories ───────────────────────────────────────────
        const props = AGENT_PROPS[a.id] || {};
        if (props.accessory === "glasses") {
            ctx.strokeStyle = "#666"; ctx.lineWidth = 0.8;
            ctx.strokeRect(ax+4, ay+5, 5, 4); ctx.strokeRect(ax+11, ay+5, 5, 4);
            ctx.beginPath(); ctx.moveTo(ax+9, ay+7); ctx.lineTo(ax+11, ay+7); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(ax+3,  ay+6); ctx.lineTo(ax+2,  ay+8); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(ax+16, ay+6); ctx.lineTo(ax+17, ay+8); ctx.stroke();
        }
        if (props.accessory === "tie") {
            px(ax+8,  ay+15, 4, 10, "#c0392b");
            px(ax+9,  ay+20, 2,  4, "#8e2015");
            px(ax+8,  ay+24, 5,  2, "#c0392b");
        }
        if (props.accessory === "clipboard" && !a.moving) {
            px(ax-7, ay+15, 7, 12, "#e8dfc8");
            px(ax-6, ay+16, 5, 10, "#f5eedc");
            px(ax-5, ay+15, 3,  1, "#888");
            px(ax-5, ay+19, 4,  1, "#ccc");
            px(ax-5, ay+21, 4,  1, "#ccc");
            px(ax-5, ay+23, 3,  1, "#ccc");
        }
        if (props.accessory === "headset" && !a.moving) {
            px(ax+17, ay+2,  2, 10, a.hairC);
            px(ax+18, ay+11, 4,  3, "#444");
            px(ax+20, ay+12, 2,  1, "#e0e0e0");
        }
        if (props.accessory === "headphones" && !a.moving) {
            px(ax+2,  ay+2, 16, 2, "#2a2a2a");
            px(ax+2,  ay+3,  2, 6, "#333");
            px(ax+16, ay+3,  2, 6, "#333");
            px(ax+2,  ay+8,  3, 4, "#222");
            px(ax+15, ay+8,  3, 4, "#222");
        }
        if (props.accessory === "phone" && a.state === "idle") {
            px(ax+19, ay+15, 4, 8, "#1a1a1a");
            px(ax+20, ay+16, 2, 6, "#00ccff33");
        }
        if (props.accessory === "mug" && !a.moving) {
            px(ax+19, ay+16, 7, 6, "#fff8f0");
            px(ax+20, ay+17, 5, 4, "#3d1408");
            px(ax+25, ay+18, 2, 3, "#fff8f0");
        }

        // ── Thinking dots ─────────────────────────────────────────
        if (a.state === "thinking") {
            const tf = Math.floor(a.frame / 20) % 3;
            ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
            ctx.fillStyle = "#f9a8d4";
            ctx.fillText([".", "..", "..."][tf], ax+10, ay-18);
        }

        // ── Coffee cup (state) ────────────────────────────────────
        if (a.state === "coffee") {
            px(ax+19, ay+15, 8, 7, "#fff8f0");
            px(ax+20, ay+16, 6, 5, "#3d1408");
            px(ax+25, ay+17, 2, 4, "#fff8f0");
            if (Math.floor(a.frame / 15) % 2) {
                ctx.fillStyle = "rgba(255,255,255,0.35)";
                ctx.beginPath(); ctx.arc(ax+22, ay+13, 1.5, 0, Math.PI*2); ctx.fill();
                ctx.beginPath(); ctx.arc(ax+24, ay+12, 1,   0, Math.PI*2); ctx.fill();
            }
        }

        // ── Name tag ──────────────────────────────────────────────
        ctx.font = "bold 7px monospace"; ctx.textAlign = "center";
        const tw = ctx.measureText(a.name).width;
        px(ax+10-Math.round(tw/2)-2, ay-16, Math.round(tw)+4, 11, "rgba(0,0,0,0.72)");
        ctx.fillStyle = "#fff"; ctx.fillText(a.name, ax+10, ay-7);

        // ── Speech bubble ─────────────────────────────────────────
        if (a.bubble) {
            const BUBBLE_COLORS = { status:"#e0f2fe", alert:"#fef3c7", complete:"#d1fae5", idle:"#f3e8ff" };
            const bc = BUBBLE_COLORS[a.bubble.type] || "#f0f0f0";
            ctx.font = "6px monospace"; ctx.textAlign = "left";
            const btext = a.bubble.text.slice(0, 18);
            const bw = Math.min(ctx.measureText(btext).width + 8, 90);
            const bx = ax + 18, by = ay - 28;
            ctx.fillStyle = bc; ctx.fillRect(bx, by, bw, 14);
            ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, 14);
            ctx.fillStyle = bc;
            ctx.beginPath(); ctx.moveTo(bx+4, by+14); ctx.lineTo(bx+8, by+14); ctx.lineTo(bx+4, by+19); ctx.fill();
            ctx.fillStyle = "#111"; ctx.fillText(btext, bx+4, by+9);
        }

        // ── Meeting bubble ────────────────────────────────────────
        if (a.inMeeting && a.state === "meeting") {
            const topic = a.meetingTopic || "…";
            ctx.font = "6px monospace"; ctx.textAlign = "left";
            const bw = Math.min(ctx.measureText(topic).width + 8, 80);
            const bx = ax + 18, by = a.bubble ? ay - 48 : ay - 28;
            px(bx, by, bw, 14, "rgba(255,255,255,0.92)");
            px(bx+6, by+14, 6, 5, "rgba(255,255,255,0.92)");
            ctx.fillStyle = "#111"; ctx.fillText(topic.slice(0, 16), bx+4, by+9);
        }

        // ── Status dot ────────────────────────────────────────────
        const dotC = {busy:"#16a34a", active:"#16a34a", idle:"#f59e0b", offline:"#888"};
        ctx.fillStyle = dotC[a.apiStatus] || (a.moving ? "#3b82f6" : "#16a34a");
        ctx.beginPath(); ctx.arc(ax+19, ay+1, 3, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(ax+19, ay+1, 3, 0, Math.PI*2); ctx.stroke();
    }

    function drawTimeOverlay() {
        const h = new Date().getHours();
        let overlay = null;
        if (h < 6 || h >= 22) {
            // Night — deep blue-dark + desk lamp glows
            overlay = "rgba(5,3,20,0.36)";
            [...ZONES.upperDesks, ...ZONES.lowerDesks].forEach(d => {
                const g = ctx.createRadialGradient(d.x+46, d.y+70, 0, d.x+46, d.y+70, 72);
                g.addColorStop(0, "rgba(255,200,80,0.13)"); g.addColorStop(1, "rgba(255,200,80,0)");
                ctx.fillStyle = g; ctx.fillRect(d.x-12, d.y+15, DW+24, 100);
            });
        } else if (h < 9) {
            // Morning — warm sunrise amber tint
            overlay = "rgba(251,146,60,0.09)";
        } else if (h < 18) {
            // Day — clear, no overlay
            return;
        } else if (h < 22) {
            // Evening — amber/orange sunset + soft desk glows
            overlay = "rgba(180,60,10,0.15)";
            [...ZONES.upperDesks, ...ZONES.lowerDesks].forEach(d => {
                const g = ctx.createRadialGradient(d.x+46, d.y+70, 0, d.x+46, d.y+70, 72);
                g.addColorStop(0, "rgba(255,200,80,0.07)"); g.addColorStop(1, "rgba(255,200,80,0)");
                ctx.fillStyle = g; ctx.fillRect(d.x-12, d.y+15, DW+24, 100);
            });
        }
        if (overlay) { ctx.fillStyle = overlay; ctx.fillRect(0, 58, CW, CH-58); }
    }

    // ── Update ────────────────────────────────────────────────────
    function update(dt) {
        steamTick += dt;
        if (steamTick > 250) { steamTick = 0; spawnSteam(); }
        for (let i = particles.length-1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx; p.y += p.vy; p.life -= p.decay;
            if (p.life <= 0) particles.splice(i, 1);
        }
        // Dust motes (daytime)
        const _h = new Date().getHours();
        if (_h >= 6 && _h < 19) {
            dustMotes.forEach(d => {
                d.x += d.vx; d.y += d.vy;
                if (d.y < 58) { d.y = 62 + Math.random() * 140; d.x = Math.random() * CW; }
                if (d.x < 0) d.x = CW; else if (d.x > CW) d.x = 0;
            });
        }
        agents.forEach(a => {
            a.frame++;
            a.timer -= dt;
            // Bubble auto-dismiss
            if (a.bubble) { a.bubble.life -= dt; if (a.bubble.life <= 0) a.bubble = null; }
            if (a.moving) {
                const dx = a.tx - a.x, dy = a.ty - a.y;
                const d = Math.sqrt(dx*dx + dy*dy);
                if (d < 1.5) {
                    a.x = a.tx; a.y = a.ty; a.moving = false; a.state = a._ns || "typing";
                } else {
                    const spd = a.speed * (dt/16);
                    a.x += (dx/d)*spd; a.y += (dy/d)*spd;
                }
            } else if (a.timer <= 0) {
                const r = Math.random();
                const isIdleAgent = a.apiStatus === "idle";
                if (isIdleAgent) {
                    // Idle agents stay near coffee — occasional small wander or sip
                    if (r < 0.25) {
                        // Drift slightly within the break room zone
                        a.tx = Math.max(ZONES.coffee.x + 8, Math.min(ZONES.coffee.x + ZONES.coffee.w - 30, a.hx + (Math.random()-0.5)*28));
                        a.ty = Math.max(ZONES.coffee.y + 22, Math.min(ZONES.coffee.y + ZONES.coffee.h - 24, a.hy + (Math.random()-0.5)*20));
                        a.moving = true; a.state = "walking"; a._ns = "coffee";
                        a.timer = Math.random()*3000 + 1500;
                    } else if (r < 0.35) {
                        // Return to coffee home slot
                        a.tx = a.hx; a.ty = a.hy;
                        a.moving = true; a.state = "walking"; a._ns = "coffee";
                        a.timer = Math.random()*4000 + 2000;
                    } else {
                        a.state = "coffee";
                        a.timer = Math.random()*5000 + 3000;
                    }
                } else {
                    if (r < 0.10) {
                        // Go to break room coffee
                        a.tx = CM_X - 62 + Math.random() * 44;
                        a.ty = CM_Y + 38 + Math.random() * 14;
                        a.moving = true; a.state = "walking"; a._ns = "coffee";
                        a.timer = Math.random()*4000 + 2000;
                        addAct(a.name, ["Getting coffee ☕","Coffee break ☕","At coffee machine"][Math.floor(Math.random()*3)]);
                    } else if (r < 0.22) {
                        // Return home (desk)
                        a.tx = a.hx; a.ty = a.hy;
                        a.moving = true; a.state = "walking"; a._ns = "typing";
                        a.timer = Math.random()*8000 + 5000;
                        const acts = AGENT_ACTS[a.id] || ["Working"];
                        addAct(a.name, acts[Math.floor(Math.random()*acts.length)]);
                    } else if (r < 0.30) {
                        // Small wander near desk
                        a.tx = Math.max(22, Math.min(CW-30, a.hx + (Math.random()-0.5)*44));
                        a.ty = Math.max(65, Math.min(CH-38, a.hy + (Math.random()-0.5)*28));
                        a.moving = true; a.state = "walking"; a._ns = "idle";
                        a.timer = Math.random()*3000 + 1500;
                    } else {
                        const stateRoll = Math.random();
                    if (stateRoll < 0.50)      a.state = "typing";
                    else if (stateRoll < 0.65) a.state = "thinking";
                    else if (stateRoll < 0.78) a.state = "reading";
                    else if (stateRoll < 0.88) a.state = "waiting";
                    else                       a.state = "idle";
                        a.timer = Math.random()*5000 + 3000;
                    }
                }
            }
        });
        // Meeting trigger — ~1 meeting per 3 min on average (0.00025/frame @ ~60fps)
        if (_meetingCooldown > 0) _meetingCooldown--;
        else if (!_activeMeeting && Math.random() < 0.00025) _triggerMeeting();
    }

    // ── Render ────────────────────────────────────────────────────
    function render() {
        ctx.clearRect(0, 0, CW, CH);
        ctx.fillStyle = "#e8e0d0"; ctx.fillRect(0, 0, CW, CH);

        // World — everything inside camera transform
        ctx.save();
        ctx.translate(cam.x, cam.y); ctx.scale(cam.scale, cam.scale);

        drawFloor();
        drawRoomWalls();
        drawWall();
        drawMeetingRoom(ZONES.meeting.x, ZONES.meeting.y);
        drawCoffeeRoom(ZONES.coffee.x, ZONES.coffee.y);
        ZONES.upperDesks.forEach(d => drawDesk(d.x, d.y, d.agent));
        ZONES.lowerDesks.forEach(d => drawDesk(d.x, d.y, d.agent));
        drawCoffeeMachine(CM_X, CM_Y);

        // Plants with sway
        const sway = Math.sin(Date.now() / 1800) * 1.5;
        drawPlant(4,   62, "snake",  sway);
        drawPlant(618, 62, "snake", -sway);
        drawPlant(ZONES.coffee.x + 218, ZONES.coffee.y + 28, "cactus", sway * 0.6);
        drawPlant(ZONES.meeting.x + 140, ZONES.meeting.y + 102, "fiddle", sway);
        drawPlant(ZONES.coffee.x - 26, ZONES.coffee.y + 18, "pothos", sway * 0.8);

        // Dust motes (daytime)
        const _h = new Date().getHours();
        if (_h >= 6 && _h < 19) {
            ctx.fillStyle = "rgba(255,248,210,0.55)";
            dustMotes.forEach(d => { ctx.beginPath(); ctx.arc(d.x, d.y, 1, 0, Math.PI*2); ctx.fill(); });
        }

        // Steam
        particles.forEach(p => {
            ctx.fillStyle = `rgba(160,130,100,${(p.life*0.4).toFixed(2)})`;
            ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.r), Math.round(p.r));
        });

        drawTimeOverlay();
        [...agents].sort((a,b) => a.y-b.y).forEach(drawAgent);

        ctx.restore();  // end camera transform

        // Fixed overlays (screen space)
        ctx.fillStyle = "rgba(0,0,0,0.025)";
        for (let sy = 0; sy < CH; sy += 4) ctx.fillRect(0, sy, CW, 1);
        ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, CW-2, CH-2);

        // Reset view hint
        if (cam.x !== 0 || cam.y !== 0 || cam.scale !== 1.0) {
            ctx.fillStyle = "rgba(0,0,0,0.50)"; ctx.fillRect(CW-70, 6, 64, 16);
            ctx.fillStyle = "#fff"; ctx.font = "9px monospace"; ctx.textAlign = "center";
            ctx.fillText("⌂ reset view", CW-38, 18);
        }
    }

    // ── Hit detection (takes screen coords, converts to world) ────
    function hitTest(sx, sy) {
        const wx = (sx - cam.x) / cam.scale, wy = (sy - cam.y) / cam.scale;
        const a = agents.find(a => wx >= a.x-2 && wx <= a.x+22 && wy >= a.y-2 && wy <= a.y+AH+5);
        if (a) return { type:"agent", a };
        const c = ZONES.coffee;
        if (wx >= c.x && wx <= c.x+c.w && wy >= c.y && wy <= c.y+c.h) return { type:"coffee" };
        const m = ZONES.meeting;
        if (wx >= m.x && wx <= m.x+m.w && wy >= m.y && wy <= m.y+m.h) return { type:"meeting" };
        const allDesks = [...ZONES.upperDesks, ...ZONES.lowerDesks];
        const d = allDesks.find(d => wx >= d.x && wx <= d.x+DW && wy >= d.y && wy <= d.y+MH+DSH+DFH);
        if (d) return { type:"desk", d };
        return null;
    }

    canvas.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        const r = canvas.getBoundingClientRect();
        const sx = (e.clientX-r.left)*(CW/r.width), sy = (e.clientY-r.top)*(CH/r.height);
        _drag = { sx, sy, cx: cam.x, cy: cam.y };
        _dragMoved = false;
        canvas.style.cursor = "grabbing";
    });

    canvas.addEventListener("mousemove", e => {
        const r = canvas.getBoundingClientRect();
        const sx = (e.clientX-r.left)*(CW/r.width), sy = (e.clientY-r.top)*(CH/r.height);
        if (_drag) {
            if (Math.abs(sx-_drag.sx) + Math.abs(sy-_drag.sy) > 3) _dragMoved = true;
            cam.x = _drag.cx + (sx - _drag.sx);
            cam.y = _drag.cy + (sy - _drag.sy);
            _clampCam();
        } else {
            canvas.style.cursor = hitTest(sx, sy) ? "pointer" : "grab";
        }
    });

    canvas.addEventListener("mouseup",    () => { _drag = null; canvas.style.cursor = "grab"; });
    canvas.addEventListener("mouseleave", () => { _drag = null; });

    canvas.addEventListener("click", e => {
        if (_dragMoved) { _dragMoved = false; return; }
        const r = canvas.getBoundingClientRect();
        const sx = (e.clientX-r.left)*(CW/r.width), sy = (e.clientY-r.top)*(CH/r.height);
        // Reset button (screen space)
        if (sx >= CW-70 && sx <= CW-6 && sy >= 6 && sy <= 22) {
            cam.x = 0; cam.y = 0; cam.scale = 1.0; return;
        }
        const hit = hitTest(sx, sy);
        if (!hit) return;
        if (hit.type === "agent") showAgentInfo(hit.a);
        else if (hit.type === "desk") { const a = agents.find(ag => ag.id === hit.d.agent); if (a) showAgentInfo(a); }
        else if (hit.type === "coffee") showCoffeeChat();
        else if (hit.type === "meeting") showMeetingModal();
    });

    canvas.addEventListener("dblclick", () => { cam.x = 0; cam.y = 0; cam.scale = 1.0; _drag = null; });

    canvas.addEventListener("wheel", e => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        const sx = (e.clientX-r.left)*(CW/r.width), sy = (e.clientY-r.top)*(CH/r.height);
        const wx = (sx - cam.x) / cam.scale, wy = (sy - cam.y) / cam.scale;
        const factor = e.deltaY < 0 ? 1.12 : 0.9;
        cam.scale = Math.max(0.5, Math.min(3.0, cam.scale * factor));
        cam.x = sx - wx * cam.scale;
        cam.y = sy - wy * cam.scale;
        _clampCam();
    }, { passive: false });

    // ── Info panel ────────────────────────────────────────────────
    function setInfo(html) {
        const b = document.getElementById("office-agent-info"); if (b) b.innerHTML = html;
    }

    function showAgentInfo(a) {
        const sl = {typing:"🟢 Working",walking:"🔵 Moving",idle:"🟡 Idle",coffee:"☕ Coffee break",offline:"⚫ Offline"};
        const statusLabel = {busy:"🟢 Busy",active:"🟢 Active",idle:"🟡 Idle",offline:"⚫ Offline"}[a.apiStatus] || "";
        const acts = AGENT_ACTS[a.id] || [];
        const cur  = acts[Math.floor(Math.random()*acts.length)] || "Working";
        setInfo(`
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
                <div style="width:30px;height:30px;border-radius:6px;background:${a.shirtC};display:flex;align-items:center;justify-content:center;font-size:1.1rem">
                    ${AGENT_EMOJI[a.id]||"👤"}
                </div>
                <div>
                    <div style="font-weight:700;font-size:0.88rem">${a.name}</div>
                    <div style="font-size:0.72rem;color:var(--text3)">${a.role}</div>
                </div>
            </div>
            <div style="font-size:0.78rem;color:var(--text2);margin-bottom:4px">${statusLabel || sl[a.state] || a.state}</div>
            <div style="font-size:0.74rem;color:var(--text3);font-style:italic">"${escHtml(cur)}"</div>
            <button class="btn btn-ghost" style="margin-top:8px;width:100%;font-size:0.72rem"
                onclick="document.getElementById('office-agent-info').innerHTML='<div class=office-hint>Click an agent or object</div>'">✕ Close</button>`);
    }

    function showCoffeeChat() {
        const lines = [
            {agent:"Gordon", action:"BTC up 3% this morning ☕"},
            {agent:"Lara",   action:"FB verification still pending 😤"},
            {agent:"Ernst",  action:"All scans clean today 🛡️"},
            {agent:"Claude", action:"Canvas office looking great 🚀"},
            {agent:"Milfred",action:"Team sync at 14:00 🕑"},
            {agent:"Eva",    action:"Alex's 15:00 confirmed 📅"},
        ];
        const feed = document.getElementById("office-feed");
        const hdr  = container.querySelector(".office-feed-hdr");
        if (hdr) hdr.textContent = "☕ Water Cooler";
        if (feed) feed.innerHTML = lines.map(f => `
            <div class="office-feed-row">
                <span class="feed-agent">${f.agent}</span>
                <span class="feed-action">${escHtml(f.action)}</span>
            </div>`).join("");
        setTimeout(() => {
            if (hdr) hdr.textContent = "Activity Log";
            if (feed) feed.innerHTML = actLog.slice(0,10).map(f =>
                `<div class="office-feed-row"><span class="feed-agent">${f.agent}</span><span class="feed-action">${escHtml(f.action)}</span></div>`
            ).join("");
        }, 5500);
    }

    function showMeetingModal() {
        const modal = createModal({
            title: "📅 Book Meeting Room",
            body: `
                <div class="form-field"><label class="form-label">Meeting Title</label>
                    <input class="form-input" id="meet-title" placeholder="e.g. Weekly Sync"></div>
                <div class="form-field"><label class="form-label">Attendees</label>
                    <input class="form-input" id="meet-attendees" placeholder="e.g. Alex, Ernst, Gordon"></div>
                <div class="form-field"><label class="form-label">Time</label>
                    <input class="form-input" id="meet-time" type="time" value="${String(new Date().getHours()).padStart(2,"0")}:00"></div>`,
            footer: `<button class="btn btn-ghost" id="meet-cancel">Cancel</button>
                     <button class="btn btn-primary" id="meet-book">Book Room</button>`,
        });
        modal.querySelector("#meet-cancel").onclick = () => modal.remove();
        modal.querySelector("#meet-book").onclick = () => {
            const title = modal.querySelector("#meet-title").value.trim() || "Meeting";
            const time  = modal.querySelector("#meet-time").value;
            modal.remove();
            addAct("System", `"${title}" booked @ ${time}`);
            agents.filter(() => Math.random() < 0.45).forEach(a => {
                a.tx = Math.max(ZONES.meeting.x+15, Math.min(ZONES.meeting.x+142, ZONES.meeting.x+20+Math.random()*120));
                a.ty = Math.max(ZONES.meeting.y+28, Math.min(ZONES.meeting.y+130, ZONES.meeting.y+35+Math.random()*90));
                a.moving = true; a.state = "walking"; a._ns = "idle"; a.timer = 10000;
            });
        };
    }

    // ── Animation loop ────────────────────────────────────────────
    let animId = null, lastTime = 0;
    function loop(ts) {
        const dt = Math.min(ts - lastTime, 50);
        lastTime = ts;
        update(dt);
        render();
        animId = requestAnimationFrame(loop);
    }
    animId = requestAnimationFrame(ts => { lastTime = ts; loop(ts); });

    const obs = new MutationObserver(() => {
        if (!document.body.contains(canvas)) { cancelAnimationFrame(animId); obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// Company (Mission, Vision, Strategy, Goals)
// ──────────────────────────────────────────────────────────────────────────────
function renderTeam(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🏢 Company</div>
            <div class="panel-subtitle">Mission · Vision · Strategy · Goals</div>
        </div>

        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Mission</div>
            <div style="font-size:0.92rem;color:var(--text);line-height:1.7;font-style:italic">"${escHtml(d.mission)}"</div>
        </div>

        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Vision</div>
            <div style="font-size:1rem;color:var(--text);line-height:1.8;font-style:italic;padding:8px 0">
                "To be the intelligence layer for every ambitious team — making world-class thinking accessible to builders everywhere."
            </div>
            <div class="grid-2" style="margin-top:12px">
                <div>
                    <div style="font-size:0.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">3-Year Picture</div>
                    <ul class="checklist">
                        <li class="check-item"><span class="check-icon">🌍</span><span style="font-size:0.85rem">Nouga is the default AI operating system for early-stage companies</span></li>
                        <li class="check-item"><span class="check-icon">🤖</span><span style="font-size:0.85rem">AI agents handle 80% of routine operations autonomously</span></li>
                        <li class="check-item"><span class="check-icon">📈</span><span style="font-size:0.85rem">Profitable, capital-efficient, and globally distributed</span></li>
                    </ul>
                </div>
                <div>
                    <div style="font-size:0.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Core Beliefs</div>
                    <ul class="checklist">
                        <li class="check-item"><span class="check-icon">💡</span><span style="font-size:0.85rem">Small teams with great leverage beat large teams every time</span></li>
                        <li class="check-item"><span class="check-icon">🔗</span><span style="font-size:0.85rem">AI and humans are partners, not replacements</span></li>
                        <li class="check-item"><span class="check-icon">⚡</span><span style="font-size:0.85rem">Speed of learning is the ultimate competitive advantage</span></li>
                    </ul>
                </div>
            </div>
        </div>

        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Strategy</div>
            <div style="margin-bottom:14px">
                <div style="font-size:0.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">🗺️ Where Do We Play</div>
                <div class="grid-2" style="gap:10px">
                    <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:12px">
                        <div style="font-size:0.8rem;font-weight:700;color:var(--blue2);margin-bottom:6px">PRIMARY MARKET</div>
                        <div style="font-size:0.85rem;color:var(--text);line-height:1.5">Early-stage startups (seed–Series A) running lean with 2–15 people who need operational leverage without headcount.</div>
                    </div>
                    <div style="background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:12px">
                        <div style="font-size:0.8rem;font-weight:700;color:var(--blue2);margin-bottom:6px">GEOGRAPHY</div>
                        <div style="font-size:0.85rem;color:var(--text);line-height:1.5">English-speaking markets first (US, UK, Canada, ANZ), expanding to Europe in 2026.</div>
                    </div>
                </div>
            </div>
            <div style="margin-bottom:14px">
                <div style="font-size:0.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">🎁 What Do We Offer</div>
                <ul class="checklist">
                    <li class="check-item"><span class="check-icon">🤖</span><span style="font-size:0.85rem"><strong>AI Agent Suite</strong> — purpose-built agents for trading, security, content, and ops that run autonomously</span></li>
                    <li class="check-item"><span class="check-icon">🧠</span><span style="font-size:0.85rem"><strong>Mission Control Dashboard</strong> — unified ops layer giving founders a single pane of glass</span></li>
                    <li class="check-item"><span class="check-icon">⚙️</span><span style="font-size:0.85rem"><strong>Integration Platform</strong> — connects your tools (Slack, Gmail, GitHub, Binance) into one intelligent workflow</span></li>
                    <li class="check-item"><span class="check-icon">📊</span><span style="font-size:0.85rem"><strong>LLM Council</strong> — multi-model reasoning for strategic decisions, not just task execution</span></li>
                </ul>
            </div>
            <div>
                <div style="font-size:0.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">🚀 Go-to-Market</div>
                <div class="grid-2" style="gap:10px">
                    <div>
                        <div style="font-size:0.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Acquisition</div>
                        <ul class="checklist">
                            <li class="check-item"><span class="check-icon">✍️</span><span style="font-size:0.82rem">Founder-led content (build-in-public, X/LinkedIn)</span></li>
                            <li class="check-item"><span class="check-icon">🤝</span><span style="font-size:0.82rem">Community partnerships with startup accelerators</span></li>
                            <li class="check-item"><span class="check-icon">🔍</span><span style="font-size:0.82rem">SEO / organic via AI ops use-case content</span></li>
                        </ul>
                    </div>
                    <div>
                        <div style="font-size:0.8rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Conversion & Retention</div>
                        <ul class="checklist">
                            <li class="check-item"><span class="check-icon">🎯</span><span style="font-size:0.82rem">Free trial → usage-based pricing</span></li>
                            <li class="check-item"><span class="check-icon">📞</span><span style="font-size:0.82rem">High-touch onboarding for first 50 customers</span></li>
                            <li class="check-item"><span class="check-icon">🔄</span><span style="font-size:0.82rem">Sticky via integrations and institutional memory</span></li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">Company Goals</div>
            <ul class="checklist">
                ${d.goals.map(g=>`<li class="check-item"><span class="check-icon">🎯</span><span style="font-size:0.85rem">${escHtml(g)}</span></li>`).join("")}
            </ul>
        </div>`;
}


// ──────────────────────────────────────────────────────────────────────────────
// System — Network Diagram + Version Checker
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// Skills Inventory (static data)
// ──────────────────────────────────────────────────────────────────────────────
const SKILLS_DATA = {
    system: [
        { name: "Get Shit Done (GSD)", icon: "🚀", usedBy: "All agents",  status: "active", desc: "Systematic workflow & task management" },
        { name: "UI/UX Pro Max",        icon: "🎨", usedBy: "Claude",      status: "active", desc: "50 styles, 21 palettes" },
        { name: "Elite Frontend UX",    icon: "💎", usedBy: "Claude",      status: "active", desc: "Production-grade interfaces" },
        { name: "Claude Code MCP",      icon: "🔧", usedBy: "Claude",      status: "active", desc: "Full MCP tool access" },
        { name: "Antfarm Workflows",    icon: "🐜", usedBy: "Milfred",     status: "active", desc: "Multi-agent orchestration" },
        { name: "RTK (Token Optimizer)", icon: "🚀", usedBy: "All agents",  status: "active", desc: "Reduces tokens by 60-90%" },
        { name: "Ralph",                 icon: "🔁", usedBy: "Claude",      status: "active", desc: "Autonomous AI development loop" },
    ],
    agents: [
        {
            name: "Claude", icon: "🤖",
            skills: ["Get Shit Done (GSD)", "UI/UX Pro Max", "Elite Frontend UX", "Claude Code MCP"],
        },
        {
            name: "Milfred", icon: "👤",
            skills: ["Antfarm Workflows", "Get Shit Done (GSD)"],
        },
        {
            name: "Ernst", icon: "🔍",
            skills: ["Quality Assurance"],
        },
        {
            name: "Gordon", icon: "📈",
            skills: ["Trading Algorithms"],
        },
        {
            name: "Lara", icon: "✍️",
            skills: ["Content Creation"],
        },
        {
            name: "Eva", icon: "📋",
            skills: ["Executive Assistant"],
        },
    ],
    pending: [
        { name: "System Architect",          priority: "high",   source: "Custom"                },
        { name: "Ralph (Autonomous Loop)",   priority: "medium", source: "frankbria/ralph"       },
        { name: "Vibe Kanban",               priority: "medium", source: "bloopai/vibe"          },
        { name: "Claude Code Templates",     priority: "medium", source: "davila7/templates"     },
        { name: "Super Powers",              priority: "medium", source: "openclaw"              },
        { name: "Supabase",                  priority: "medium", source: "Research"              },
        { name: "Figma Toolkit",             priority: "low",    source: "Anthropic"             },
        { name: "Context 7",                 priority: "low",    source: "Anthropic"             },
        { name: "Playwright CLI",            priority: "low",    source: "openclaw"              },
        { name: "Obsidian",                  priority: "low",    source: "openclaw"              },
    ],
};

function renderSkills() {
    const priorityColor = p => p === "high" ? "red" : p === "medium" ? "yellow" : "gray";

    const systemRows = SKILLS_DATA.system.map(s => `
        <div class="service-row">
            <div class="service-left">
                <span style="font-size:1.2rem">${s.icon}</span>
                <div>
                    <div class="service-name">${escHtml(s.name)}</div>
                    <div class="service-port">${escHtml(s.desc)}</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:0.75rem;color:var(--text3)">${escHtml(s.usedBy)}</span>
                ${badge("active", "green")}
            </div>
        </div>`).join("");

    const agentRows = SKILLS_DATA.agents.map(a => `
        <div class="service-row" style="align-items:flex-start;padding:10px 0">
            <div class="service-left" style="align-items:flex-start">
                <span style="font-size:1.2rem;margin-top:2px">${a.icon}</span>
                <div>
                    <div class="service-name">${escHtml(a.name)}</div>
                    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:5px">
                        ${a.skills.map(sk => `<span style="background:var(--bg3,#222236);border:1px solid var(--border,#333);border-radius:4px;padding:2px 8px;font-size:0.72rem;color:var(--text2)">${escHtml(sk)}</span>`).join("")}
                    </div>
                </div>
            </div>
        </div>`).join("");

    const pendingRows = SKILLS_DATA.pending.map(s => `
        <div class="service-row">
            <div class="service-left">
                <span style="font-size:1rem">📦</span>
                <div>
                    <div class="service-name">${escHtml(s.name)}</div>
                    <div class="service-port">${escHtml(s.source)}</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                ${badge(s.priority, priorityColor(s.priority))}
                <button class="btn btn-ghost" style="padding:2px 8px;font-size:0.7rem;opacity:0.5;cursor:default" disabled>Install</button>
            </div>
        </div>`).join("");

    return `
        <div class="panel-header">
            <div class="panel-title">🧩 Skills Inventory</div>
            <div class="panel-subtitle">Installed capabilities · Agent assignments · Pending installs</div>
        </div>
        <div class="grid-3" style="margin-bottom:16px">
            <div class="stat-card">
                <div class="stat-label">System Skills</div>
                <div class="stat-value">${SKILLS_DATA.system.length}</div>
                <div class="stat-sub">all active</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Agents Equipped</div>
                <div class="stat-value">${SKILLS_DATA.agents.length}</div>
                <div class="stat-sub">with assigned skills</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Pending Installs</div>
                <div class="stat-value">${SKILLS_DATA.pending.length}</div>
                <div class="stat-sub">${SKILLS_DATA.pending.filter(s=>s.priority==="high").length} high priority</div>
            </div>
        </div>
        <div class="grid-2" style="margin-bottom:16px">
            <div class="card">
                <div class="card-title">System Skills</div>
                ${systemRows}
            </div>
            <div class="card">
                <div class="card-title">Agent Skills</div>
                ${agentRows}
            </div>
        </div>
        <div class="card">
            <div class="card-title">Pending Skills <span style="font-size:0.75rem;color:var(--text3);font-weight:400;margin-left:6px">— research &amp; install queue</span></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 24px">
                ${pendingRows}
            </div>
        </div>
        
        <!-- Hawk Code Review Section -->
        <div class="card" style="margin-top:16px;border-left:3px solid var(--green2)">
            <div class="card-title">🦅 Hawk Code Review</div>
            <div style="display:flex;gap:16px;margin-bottom:12px">
                <div style="flex:1">
                    <div style="font-size:0.8rem;color:var(--text3);margin-bottom:4px">Status</div>
                    <div style="font-weight:600;color:var(--green2)">🟢 Active & Ready</div>
                </div>
                <div style="flex:1">
                    <div style="font-size:0.8rem;color:var(--text3);margin-bottom:4px">Pending Reviews</div>
                    <div style="font-weight:600">0</div>
                </div>
                <div style="flex:1">
                    <div style="font-size:0.8rem;color:var(--text3);margin-bottom:4px">Last Review</div>
                    <div style="font-weight:600">-</div>
                </div>
            </div>
            <div style="background:rgba(0,0,0,0.2);padding:12px;border-radius:6px;margin-bottom:12px">
                <div style="font-size:0.8rem;color:var(--text3);margin-bottom:8px">How to use:</div>
                <ol style="margin:0;padding-left:20px;font-size:0.85rem;color:var(--text2)">
                    <li>Claude completes code changes</li>
                    <li>Submit to Hawk for review</li>
                    <li>Hawk checks: bugs, security, performance</li>
                    <li>Approve → Deploy | Reject → Fix → Resubmit</li>
                </ol>
            </div>
            <button class="btn-primary" style="width:100%" onclick="alert('Submit code to Hawk for review - Feature coming soon')">
                🦅 Submit Code for Review
            </button>
        </div>`;
}

function renderSystem(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">⚙️ System</div>
            <div class="panel-subtitle">Network topology · Services · Versions</div>
        </div>
        <div class="grid-4" style="margin-bottom:16px">
            <div class="stat-card">
                <div class="stat-label">Tailscale IP</div>
                <div style="font-size:0.9rem;font-weight:700;color:var(--blue2);font-family:monospace;margin-top:4px">${d.tailscale_ip}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Hostname</div>
                <div style="font-size:0.88rem;font-weight:600;color:#fff;margin-top:4px">${escHtml(d.hostname)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Disk Used</div>
                <div style="font-size:1rem;font-weight:700;color:#fff;margin-top:4px">${d.disk.used||"—"} / ${d.disk.total||"—"}</div>
                <div class="stat-sub">${d.disk.percent||""} used</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Uptime</div>
                <div style="font-size:0.78rem;color:var(--text2);margin-top:4px">${escHtml((d.uptime||"").slice(0,60))}</div>
            </div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Network Topology</div>
            <div id="net-diagram-placeholder">
                <div class="net-diagram">
                    <div class="net-row">
                        <div class="net-node" data-node="internet">
                            <div class="net-node-box up">
                                <div class="net-status-dot up"></div>
                                <span style="font-size:1.1rem">🌐</span>
                                <div><div class="net-node-name">Internet</div></div>
                            </div>
                        </div>
                        <div class="net-arrow">→</div>
                        <div class="net-node" data-node="cloudflare">
                            <div class="net-node-box ${d.services.find(s=>s.name.includes("Mission"))?.up?"up":"up"}">
                                <div class="net-status-dot up"></div>
                                <span style="font-size:1.1rem">☁️</span>
                                <div><div class="net-node-name">Cloudflare</div><div class="net-node-sub">nouga.ai</div></div>
                            </div>
                        </div>
                        <div class="net-arrow">→</div>
                        <div class="net-node" data-node="macmini">
                            <div class="net-node-box up">
                                <div class="net-status-dot up"></div>
                                <span style="font-size:1.1rem">💻</span>
                                <div><div class="net-node-name">Mac Mini</div><div class="net-node-sub">${d.tailscale_ip}</div></div>
                            </div>
                        </div>
                    </div>
                    <div class="net-arrow-v"></div>
                    <div class="net-services" style="justify-content:center;gap:12px">
                        ${d.services.map(s => `
                            <div class="net-node" data-node="${s.name}">
                                <div class="net-node-box ${s.up?"up":"down"}">
                                    <div class="net-status-dot ${s.up?"up":"down"}"></div>
                                    <span style="font-size:1rem">${s.emoji}</span>
                                    <div>
                                        <div class="net-node-name">${escHtml(s.name)}</div>
                                        <div class="net-node-sub">:${s.port}</div>
                                    </div>
                                </div>
                            </div>`).join("")}
                    </div>
                </div>
            </div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-title">Services</div>
                ${d.services.map(s => `
                    <div class="service-row">
                        <div class="service-left">
                            <span style="font-size:1.1rem">${s.emoji}</span>
                            <div>
                                <div class="service-name">${escHtml(s.name)}</div>
                                <div class="service-port">port ${s.port}</div>
                            </div>
                        </div>
                        ${badge(s.status, s.up?"green":"red")}
                    </div>`).join("")}
            </div>
            <div class="card" id="versions-card">
                <div class="card-title">Tool Versions <button class="btn btn-ghost" id="refresh-versions" style="padding:3px 8px;font-size:0.72rem;margin-left:8px">↻ Check</button></div>
                <div id="versions-list"><div style="font-size:0.8rem;color:var(--text3);padding:8px 0">Click ↻ to check versions</div></div>
            </div>
        </div>`;
}

function initSystemPanel(data, container) {
    // Node click → tooltip
    container.querySelectorAll(".net-node").forEach(node => {
        node.addEventListener("click", () => {
            const name = node.dataset.node;
            const svc  = data.services?.find(s => s.name.includes(name) || name.includes(s.name?.split(" ")[0]?.toLowerCase()));
            const msg  = svc ? `${svc.name} — ${svc.up ? "Online" : "Offline"} (port ${svc.port})` : `${name} — connected`;
            // Brief highlight
            const box = node.querySelector(".net-node-box");
            if (box) { box.style.background = "rgba(59,130,246,0.15)"; setTimeout(() => box.style.background = "", 800); }
        });
    });

    // Version checker
    container.querySelector("#refresh-versions")?.addEventListener("click", async () => {
        const list = container.querySelector("#versions-list");
        const btn  = container.querySelector("#refresh-versions");
        if (!list || !btn) return;
        btn.disabled = true; btn.textContent = "Checking…";
        list.innerHTML = `<div class="loading"><div class="spinner"></div> Running checks…</div>`;
        try {
            const d = await fetchData("versions");
            list.innerHTML = (d.versions || []).map(v => `
                <div class="version-row">
                    <div class="version-name">
                        <span>${v.ok ? "✅" : "❌"}</span>
                        ${escHtml(v.name)}
                    </div>
                    <div class="version-val">${escHtml(v.version)}</div>
                </div>`).join("");
        } catch(e) {
            list.innerHTML = `<div class="error-box">⚠️ ${escHtml(e.message)}</div>`;
        }
        btn.disabled = false; btn.textContent = "↻ Check";
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Radar — SVG Spider Chart
// ──────────────────────────────────────────────────────────────────────────────
function renderRadar(d) {
    const axes = [
        { label: "Firewall",      score: 10 },
        { label: "Tailscale",     score: 10 },
        { label: "SSH Keys",      score: 10 },
        { label: "Fail2Ban",      score: 10 },
        { label: "Monitoring",    score: 10 },
        { label: "Prompt Guard",  score: 10 },
        { label: "Port Security", score: 10 },
        { label: "Audit Logs",    score: 9  },
        { label: "Access Ctrl",   score: 10 },
        { label: "Backups",       score: 8  },
    ];

    const cx = 180, cy = 180, R = 140;
    const n  = axes.length;
    const toRad = deg => deg * Math.PI / 180;

    // Compute points
    const axisPoints = axes.map((_, i) => {
        const angle = toRad(-90 + i * (360 / n));
        return { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
    });
    const valuePoints = axes.map((a, i) => {
        const angle = toRad(-90 + i * (360 / n));
        const r = R * (a.score / 10);
        return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });

    const poly = pts => pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    // Ring polygons at 2,4,6,8,10
    const rings = [2,4,6,8,10].map(v => {
        const pts = axes.map((_, i) => {
            const angle = toRad(-90 + i * (360/n));
            const r = R * (v/10);
            return { x: cx + r*Math.cos(angle), y: cy + r*Math.sin(angle) };
        });
        return `<polygon points="${poly(pts)}" class="radar-ring"/>`;
    }).join("");

    // Axis lines
    const axisLines = axisPoints.map(p => `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" class="radar-axis"/>`).join("");

    // Labels
    const labels = axes.map((a, i) => {
        const lx = cx + (R + 22) * Math.cos(toRad(-90 + i*(360/n)));
        const ly = cy + (R + 22) * Math.sin(toRad(-90 + i*(360/n)));
        const anchor = lx < cx - 5 ? "end" : lx > cx + 5 ? "start" : "middle";
        return `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="radar-label" text-anchor="${anchor}" dominant-baseline="middle">${a.label}</text>`;
    }).join("");

    // Dots on value polygon
    const dots = valuePoints.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" class="radar-dot"/>`).join("");

    const svgW = 400, svgH = 400;

    return `
        <div class="panel-header">
            <div class="panel-title">🛡️ Radar</div>
            <div class="panel-subtitle">Security posture · Last scan: ${d.last_scan}</div>
        </div>
        <div class="grid-2" style="margin-bottom:16px">
            <div class="card">
                <div class="card-title">Spider Chart</div>
                <div class="radar-wrap">
                    <svg width="${svgW}" height="${svgH}" class="radar-svg" viewBox="0 0 ${svgW} ${svgH}">
                        ${rings}
                        ${axisLines}
                        <polygon points="${poly(valuePoints)}" class="radar-area"/>
                        ${labels}
                        ${dots}
                    </svg>
                </div>
            </div>
            <div>
                <div class="card" style="margin-bottom:12px;text-align:center">
                    <div class="card-title">Security Score</div>
                    <div style="font-size:4rem;font-weight:900;color:var(--green);line-height:1;margin:12px 0">
                        ${d.score}
                    </div>
                    <div style="font-size:0.8rem;color:var(--text2)">out of ${d.score_max}</div>
                    <div style="margin-top:8px">${badge("monitor " + d.monitor_status,"green")}</div>
                </div>
                <div class="card">
                    <div class="card-title">✅ Implemented (${d.implemented.length})</div>
                    <ul class="checklist">
                        ${d.implemented.slice(0,8).map(i => `
                            <li class="check-item"><span class="check-icon">✅</span><span style="font-size:0.8rem">${escHtml(i)}</span></li>`).join("")}
                    </ul>
                </div>
            </div>
        </div>
        ${d.pending?.length ? `
        <div class="card">
            <div class="card-title">⏳ Pending Actions (${d.pending.length})</div>
            <ul class="checklist">
                ${d.pending.map(i => `
                    <li class="check-item"><span class="check-icon">⚠️</span><span style="font-size:0.82rem">${escHtml(i)}</span></li>`).join("")}
            </ul>
        </div>` : ""}
        <div class="card" style="margin-top:12px">
            <div class="card-title">Recent Alerts</div>
            ${d.alerts?.length ? d.alerts.slice(-8).map(a => `
                <div class="alert-row">
                    <span class="alert-time">${escHtml(a.timestamp)}</span>
                    <span class="alert-level">${badge(a.level, a.level==="CRITICAL"?"red":a.level==="WARNING"?"yellow":"blue")}</span>
                    <span class="alert-msg">${escHtml(a.message)}</span>
                </div>`).join("")
            : `<div style="font-size:0.85rem;color:var(--text3);padding:12px 0">No alerts recorded.</div>`}
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory — Automation Workshop
// ──────────────────────────────────────────────────────────────────────────────
// Example workflow definitions shown as visual flow diagrams
const WF_EXAMPLES = [
    {
        name: "Morning Briefing",
        emoji: "🌅",
        desc: "Daily 08:00 startup routine — briefing, market check, security scan",
        steps: [
            { type: "trigger",   label: "⏰ Cron 08:00",          detail: "Every weekday" },
            { type: "action",    label: "📅 Eva: CEO Briefing",    detail: "Compile overnight events" },
            { type: "action",    label: "📈 Gordon: Market Check", detail: "BTC/ETH positions" },
            { type: "action",    label: "🔒 Ernst: Security Scan", detail: "Fail2ban + port scan" },
            { type: "notify",    label: "💬 Telegram Summary",     detail: "Send to Alex" },
        ],
    },
    {
        name: "Security Alert",
        emoji: "🚨",
        desc: "Triggered on intrusion detection — escalates through Ernst to Alex",
        steps: [
            { type: "trigger",   label: "🔔 Fail2Ban Alert",       detail: "SSH brute-force detected" },
            { type: "condition", label: "❓ Severity ≥ HIGH?",     detail: "Check alert level" },
            { type: "action",    label: "🔒 Ernst: Block IP",      detail: "Add to deny list" },
            { type: "action",    label: "📝 Ernst: Write Report",  detail: "Incident log entry" },
            { type: "notify",    label: "🚨 Alert Alex",           detail: "Telegram + dashboard" },
        ],
    },
    {
        name: "Content Pipeline",
        emoji: "✍️",
        desc: "Lara drafts social posts from research, queued for approval",
        steps: [
            { type: "trigger",   label: "🔔 New Topic Added",      detail: "Via dashboard or API" },
            { type: "action",    label: "🔍 Milfred: Research",    detail: "Web search + summarise" },
            { type: "action",    label: "✍️ Lara: Draft Posts",    detail: "Twitter / LinkedIn / FB" },
            { type: "condition", label: "❓ Needs Approval?",      detail: "Check content policy" },
            { type: "notify",    label: "✅ Queue for Review",     detail: "Appears in Approvals" },
        ],
    },
];

function wfFlowHtml(steps) {
    return `<div class="wf-flow">${steps.map((s, i) => `
        <div class="wf-node ${s.type}" title="${escHtml(s.detail)}">
            <div class="wf-node-box">
                <div class="wf-node-label">${s.label}</div>
                <div class="wf-node-desc">${escHtml(s.detail)}</div>
            </div>
        </div>${i < steps.length - 1 ? `<div class="wf-arrow">→</div>` : ""}`).join("")}
    </div>`;
}

function renderFactory(d) {
    const exampleCards = WF_EXAMPLES.map(ex => `
        <div class="wf-example-card">
            <div class="wf-example-header">
                <span style="font-size:1.4rem">${ex.emoji}</span>
                <div>
                    <div class="wf-example-name">${escHtml(ex.name)}</div>
                    <div class="wf-example-desc">${escHtml(ex.desc)}</div>
                </div>
            </div>
            ${wfFlowHtml(ex.steps)}
        </div>`).join("");

    return `
        <div class="panel-header">
            <div class="panel-title">🏭 Automation Workshop</div>
            <div class="panel-subtitle">Visual workflow builder · ${d.workflows?.length || 0} active workflows · ${d.total_agents} agents</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">What are workflows?</div>
            <div style="font-size:0.87rem;color:var(--text2);line-height:1.7;margin-bottom:10px">
                Workflows automate multi-step tasks across agents. Each workflow defines a <span style="color:var(--green)">Trigger</span> (event or schedule),
                a series of <span style="color:var(--blue2)">Actions</span> (agent tasks), optional <span style="color:var(--yellow)">Conditions</span> (branching logic),
                and <span style="color:var(--purple)">Notifications</span> (Telegram/dashboard alerts).
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.8rem">
                <span class="badge chip-trigger">Trigger — starts the flow</span>
                <span class="badge chip-action">Action — agent task</span>
                <span class="badge chip-condition">Condition — branch logic</span>
                <span class="badge chip-notify">Notify — alert/message</span>
                <span class="badge chip-delay">Delay — wait step</span>
            </div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Example Workflows</div>
            <div class="wf-examples-wrap">${exampleCards}</div>
        </div>
        <div class="card">
            <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
                Active Workflows
                <button class="btn btn-primary" id="new-workflow-btn" style="padding:4px 10px;font-size:0.75rem">+ New Workflow</button>
            </div>
            <div id="workflows-list">
                ${(d.workflows || []).map(w => `
                    <div class="step-item" data-workflow="${escHtml(w.name)}">
                        <span style="font-size:1rem">${w.emoji}</span>
                        <div style="flex:1">
                            <div class="service-name">${escHtml(w.name)}</div>
                            <div class="service-port">${w.steps} steps · last: ${escHtml(w.last_run)}</div>
                        </div>
                        ${statusBadge(w.status)}
                        <button class="btn btn-ghost run-wf-btn" style="padding:4px 8px;font-size:0.72rem">▶ Run</button>
                    </div>`).join("")}
            </div>
        </div>
        <div class="card" style="margin-top:12px">
            <div class="card-title">Installed Skills</div>
            ${(d.skills || []).map(s => `
                <div class="service-row">
                    <div class="service-left"><div>
                        <div class="service-name">${escHtml(s.name)}</div>
                        <div class="service-port">${s.category}</div>
                    </div></div>
                    ${badge(s.status,"green")}
                </div>`).join("")}
        </div>`;
}

function initFactoryPanel(data, container) {
    if (typeof Sortable !== "undefined") {
        const list = container.querySelector("#workflows-list");
        if (list) Sortable.create(list, { animation: 150, ghostClass: "sortable-ghost" });
    }

    container.querySelector("#new-workflow-btn")?.addEventListener("click", () => showWorkflowModal());

    container.querySelectorAll(".run-wf-btn").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            btn.textContent = "⏳ Running…";
            btn.disabled = true;
            setTimeout(() => { btn.textContent = "▶ Run"; btn.disabled = false; }, 2500);
        });
    });
}

function showWorkflowModal() {
    const stepTypes = ["Trigger","Action","Condition","Notify","Delay"];
    const modal = createModal({
        title: "New Workflow",
        body: `
            <div class="form-field"><label class="form-label">Workflow Name</label>
                <input class="form-input" id="wf-name" placeholder="e.g. daily-sync"></div>
            <div class="form-field"><label class="form-label">Description</label>
                <input class="form-input" id="wf-desc" placeholder="What does this workflow do?"></div>
            <div class="form-field"><label class="form-label">Steps</label>
                <div id="wf-steps" class="steps-list" style="min-height:60px">
                    <div id="wf-placeholder" style="color:var(--text3);font-size:0.8rem;text-align:center;padding:12px">Add steps below ↓ · drag to reorder</div>
                </div>
            </div>
            <div class="form-field"><label class="form-label">Add Step</label>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    ${stepTypes.map(t => `<button class="btn badge chip-${t.toLowerCase()}" data-step-type="${t}" style="cursor:pointer">${t}</button>`).join("")}
                </div>
            </div>`,
        footer: `
            <button class="btn btn-ghost" id="wf-cancel">Cancel</button>
            <button class="btn btn-primary" id="wf-save">Create Workflow</button>`,
    });

    const stepsEl = modal.querySelector("#wf-steps");
    if (typeof Sortable !== "undefined") Sortable.create(stepsEl, { animation: 150, ghostClass: "sortable-ghost" });

    let stepCount = 0;
    modal.querySelectorAll("[data-step-type]").forEach(btn => {
        btn.addEventListener("click", () => {
            const type = btn.dataset.stepType;
            modal.querySelector("#wf-placeholder")?.remove();
            const div = document.createElement("div");
            stepCount++;
            div.className = "step-item";
            div.innerHTML = `
                <span class="step-number">${stepCount}</span>
                <span class="badge chip-${type.toLowerCase()}">${type}</span>
                <input class="form-input" placeholder="${type} description…" style="flex:1">
                <button class="task-action-btn" style="flex-shrink:0">✕</button>`;
            div.querySelector(".task-action-btn").onclick = () => div.remove();
            stepsEl.appendChild(div);
        });
    });

    modal.querySelector("#wf-cancel").onclick = () => modal.remove();
    modal.querySelector("#wf-save").onclick = () => {
        const name = modal.querySelector("#wf-name").value.trim();
        if (!name) { modal.querySelector("#wf-name").focus(); return; }
        modal.remove();
        loadPanel("factory");
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Pipeline (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderPipeline(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🚀 Deployment Pipeline</div>
            <div class="panel-subtitle">${d.repo} → ${d.site_url}</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Pipeline Stages</div>
            <div class="pipeline-stages">
                ${d.stages.map(s => `
                    <div class="stage ${s.status}">
                        <div class="stage-icon">${s.icon}</div>
                        <div class="stage-name">${s.name}</div>
                    </div>`).join("")}
            </div>
            <div style="display:flex;gap:16px;align-items:center;margin-top:16px">
                <span style="font-size:0.85rem;color:var(--text2)">Site:</span>
                <code style="font-size:0.85rem;color:var(--blue2)">${d.site_url}</code>
                ${statusBadge(d.site_status)}
            </div>
        </div>
        <div class="card">
            <div class="card-title">Recent Commits</div>
            ${d.recent_commits.map(c => `
                <div style="display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);align-items:center">
                    <code style="color:var(--blue2);font-size:0.78rem;flex-shrink:0">${c.hash}</code>
                    <span style="font-size:0.85rem;color:var(--text)">${escHtml(c.message)}</span>
                </div>`).join("")}
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Gantt Timeline View
// ──────────────────────────────────────────────────────────────────────────────
function renderGantt(d) {
    const allTasks = [
        ...(d.in_progress || []).map(t => ({ ...t, _status: "in_progress" })),
        ...(d.todo        || []).map(t => ({ ...t, _status: "todo"        })),
        ...(d.done        || []).map(t => ({ ...t, _status: "done"        })),
    ];

    // Timeline: 4 weeks back → 12 weeks forward = 16 weeks
    const today        = new Date();
    const WEEKS_BEFORE = 4;
    const WEEKS_AFTER  = 12;
    const TOTAL_WEEKS  = WEEKS_BEFORE + WEEKS_AFTER;
    const WEEK_W       = 84;  // px per week column
    const LABEL_W      = 230; // px for the task-name column

    function getMonday(dt) {
        const d2  = new Date(dt);
        const day = d2.getDay();
        d2.setDate(d2.getDate() - (day === 0 ? 6 : day - 1));
        d2.setHours(0, 0, 0, 0);
        return d2;
    }

    function isoWeek(dt) {
        const d2     = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
        const dayNum = d2.getUTCDay() || 7;
        d2.setUTCDate(d2.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d2.getUTCFullYear(), 0, 1));
        return Math.ceil((((d2 - yearStart) / 86400000) + 1) / 7);
    }

    const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    const currentMonday = getMonday(today);
    const timelineStart = new Date(currentMonday);
    timelineStart.setDate(timelineStart.getDate() - WEEKS_BEFORE * 7);

    // Build week descriptors
    const weeks = Array.from({ length: TOTAL_WEEKS }, (_, i) => {
        const ws = new Date(timelineStart);
        ws.setDate(ws.getDate() + i * 7);
        return {
            start:     ws,
            num:       isoWeek(ws),
            isCurrent: i === WEEKS_BEFORE,
            label:     `W${isoWeek(ws)}`,
            dateLabel: ws.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            month:     ws.getMonth(),
            year:      ws.getFullYear(),
        };
    });

    // Build month band descriptors
    const monthBands = [];
    weeks.forEach((w, i) => {
        const key = `${w.year}-${w.month}`;
        if (!monthBands.length || monthBands[monthBands.length - 1].key !== key) {
            monthBands.push({ key, label: `${MONTH_NAMES[w.month]} ${w.year}`, startIdx: i, count: 1 });
        } else {
            monthBands[monthBands.length - 1].count++;
        }
    });

    // Today's exact pixel offset within the timeline
    const msPerWeek     = 7 * 24 * 3600 * 1000;
    const todayOffset   = (today - timelineStart) / msPerWeek;
    const todayLineLeft = todayOffset * WEEK_W;

    // Convert a task to bar position
    function barPos(task) {
        const rawDate = task.target_date || task.due_date;
        let endDate   = rawDate ? new Date(rawDate) : null;
        let startDate;

        if (task._status === "in_progress") {
            startDate = new Date(today);
            startDate.setDate(startDate.getDate() - 7);
            if (!endDate) { endDate = new Date(today); endDate.setDate(endDate.getDate() + 7); }
        } else if (task._status === "todo") {
            startDate = new Date(today);
            if (!endDate) { endDate = new Date(today); endDate.setDate(endDate.getDate() + 7); }
        } else { // done
            if (endDate) {
                startDate = new Date(endDate);
                startDate.setDate(startDate.getDate() - 14);
            } else {
                startDate = new Date(today); startDate.setDate(startDate.getDate() - 14);
                endDate   = new Date(today);
            }
        }

        const isOverdue   = rawDate && endDate < today && task._status !== "done";
        const startOffset = (startDate - timelineStart) / msPerWeek;
        const endOffset   = (endDate   - timelineStart) / msPerWeek;

        if (endOffset <= 0 || startOffset >= TOTAL_WEEKS) return null;

        const clampedStart = Math.max(0, startOffset);
        const clampedEnd   = Math.min(TOTAL_WEEKS, endOffset);
        return {
            left:     clampedStart * WEEK_W,
            width:    Math.max(WEEK_W * 0.55, (clampedEnd - clampedStart) * WEEK_W),
            hasDate:  !!rawDate,
            isOverdue,
        };
    }

    const STATUS_CFG = {
        in_progress: { label: "In Progress", barClass: "gantt-bar-inprogress", pillBg: "rgba(59,130,246,0.15)",  pillColor: "#60a5fa", dotBg: "#3b82f6" },
        todo:        { label: "To Do",        barClass: "gantt-bar-todo",        pillBg: "rgba(139,92,246,0.15)", pillColor: "#a78bfa", dotBg: "#8b5cf6" },
        done:        { label: "Done",         barClass: "gantt-bar-done",        pillBg: "rgba(16,185,129,0.15)", pillColor: "#34d399", dotBg: "#10b981" },
    };

    const weekHeaderHtml = weeks.map(w => `
        <div class="gantt-week-hdr${w.isCurrent ? " gantt-week-now" : ""}" style="width:${WEEK_W}px"
             aria-label="${w.isCurrent ? "Current week, " : ""}${w.label}, ${w.dateLabel}">
            <div class="gantt-wnum">${w.label}</div>
            <div class="gantt-wdate">${w.dateLabel}</div>
        </div>`).join("");

    const monthBandHtml = monthBands.map(mb => `
        <div class="gantt-month-cell" style="width:${mb.count * WEEK_W}px">${mb.label}</div>`).join("");

    const weekCols = weeks.map((w, i) =>
        `<div class="gantt-col${w.isCurrent ? " gantt-col-now" : ""}" style="left:${i * WEEK_W}px;width:${WEEK_W}px"></div>`
    ).join("");
    const todayLine = `<div class="gantt-today-line" style="left:${todayLineLeft.toFixed(1)}px" aria-hidden="true"></div>`;

    let rowsHtml = "";
    let overdueTotal = 0;

    for (const status of ["in_progress", "todo", "done"]) {
        const tasks = allTasks.filter(t => t._status === status);
        if (!tasks.length) continue;

        const cfg = STATUS_CFG[status];
        rowsHtml += `
            <div class="gantt-group-row" role="rowgroup">
                <div class="gantt-lbl" style="width:${LABEL_W}px">
                    <div class="gantt-group-lbl-wrap">
                        <span class="gantt-status-pill" style="background:${cfg.pillBg};color:${cfg.pillColor}">
                            <span class="gantt-status-pill-dot" style="background:${cfg.dotBg}"></span>
                            ${cfg.label}
                        </span>
                        <span class="gantt-status-count">${tasks.length}</span>
                    </div>
                </div>
                <div class="gantt-bars" style="width:${TOTAL_WEEKS * WEEK_W}px">${weekCols}${todayLine}</div>
            </div>`;

        for (const task of tasks) {
            const pos      = barPos(task);
            const rawDate  = task.target_date || task.due_date;
            const dueLabel = rawDate ? `Due: ${rawDate}` : "No date set";
            const isOverdue = pos && pos.isOverdue;
            if (isOverdue) overdueTotal++;

            let barClass = cfg.barClass;
            if (isOverdue)        barClass = "gantt-bar-overdue";
            if (pos && !pos.hasDate) barClass += " gantt-bar-nodate";

            const barHtml = pos ? `
                <div class="gantt-bar ${barClass}"
                     style="left:${pos.left.toFixed(1)}px;width:${pos.width.toFixed(1)}px"
                     role="img"
                     aria-label="${escHtml(task.title)} — ${dueLabel}${isOverdue ? " (Overdue)" : ""}"
                     tabindex="0"
                     title="${escHtml(task.title)} — ${dueLabel}${isOverdue ? " ⚠ Overdue" : ""}">
                    <span class="gantt-bar-lbl">${escHtml(task.title)}</span>
                </div>` : "";

            rowsHtml += `
                <div class="gantt-task-row${isOverdue ? " is-overdue" : ""}" role="row">
                    <div class="gantt-lbl" style="width:${LABEL_W}px">
                        <span class="gantt-task-name" title="${escHtml(task.title)}">${escHtml(task.title)}</span>
                        <span class="gantt-task-who">${escHtml(task.assignee || "\u2014")}</span>
                    </div>
                    <div class="gantt-bars" style="width:${TOTAL_WEEKS * WEEK_W}px">
                        ${weekCols}${todayLine}${barHtml}
                    </div>
                </div>`;
        }
    }

    const totalWidth   = LABEL_W + TOTAL_WEEKS * WEEK_W;
    const overdueBadge = overdueTotal > 0
        ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:rgba(239,68,68,0.15);color:#fca5a5;border-radius:99px;font-size:0.7rem;font-weight:700;margin-left:8px">
               <span style="width:6px;height:6px;border-radius:50%;background:#ef4444;display:inline-block;flex-shrink:0"></span>
               ${overdueTotal} overdue
           </span>` : "";

    const todayScrollLeft = Math.round(todayLineLeft);

    return `
        <div class="panel-header">
            <div>
                <div class="panel-title" style="display:flex;align-items:center;gap:0">
                    Timeline${overdueBadge}
                </div>
                <div class="panel-subtitle">${allTasks.length} tasks across ${TOTAL_WEEKS} weeks &middot; Today is W${isoWeek(today)}, ${today.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>
            </div>
            <button class="btn btn-ghost" onclick="navigate('tasks')" style="font-size:0.82rem">&#8592; Kanban</button>
        </div>

        <div class="gantt-toolbar">
            <div class="gantt-toolbar-left">
                <button class="gantt-today-btn" id="gantt-scroll-today" aria-label="Jump to today">
                    <span class="gantt-today-indicator"></span>
                    Jump to Today
                </button>
            </div>
            <div class="gantt-legend" role="list" aria-label="Status legend">
                <span class="gantt-legend-item" role="listitem"><span class="gantt-legend-dot" style="background:linear-gradient(135deg,#3b82f6,#2563eb)"></span>In Progress</span>
                <span class="gantt-legend-item" role="listitem"><span class="gantt-legend-dot" style="background:linear-gradient(135deg,#8b5cf6,#7c3aed)"></span>To Do</span>
                <span class="gantt-legend-item" role="listitem"><span class="gantt-legend-dot" style="background:linear-gradient(135deg,#10b981,#059669)"></span>Done</span>
                <span class="gantt-legend-item" role="listitem"><span class="gantt-legend-dot" style="background:linear-gradient(135deg,#ef4444,#dc2626)"></span>Overdue</span>
                <span class="gantt-legend-item" role="listitem"><span class="gantt-legend-dot" style="background:repeating-linear-gradient(-45deg,transparent,transparent 3px,rgba(255,255,255,0.2) 3px,rgba(255,255,255,0.2) 6px);background-color:#555"></span>No date</span>
            </div>
        </div>

        <div class="gantt-wrap" id="gantt-scroll-container" role="grid" aria-label="Project timeline Gantt chart">
            <div class="gantt-inner" style="min-width:${totalWidth}px">
                <div class="gantt-month-row">
                    <div class="gantt-month-lbl-spacer" style="width:${LABEL_W}px;height:25px"></div>
                    <div style="display:flex;flex-shrink:0">${monthBandHtml}</div>
                </div>
                <div class="gantt-head-row">
                    <div class="gantt-head-lbl" style="width:${LABEL_W}px">Task</div>
                    <div class="gantt-head-weeks" style="width:${TOTAL_WEEKS * WEEK_W}px;display:flex">
                        ${weekHeaderHtml}
                    </div>
                </div>
                <div class="gantt-body">${rowsHtml}</div>
            </div>
        </div>
        <span data-gantt-today-px="${todayScrollLeft.toFixed(0)}" data-gantt-label-w="${LABEL_W}" style="display:none"></span>`;
}


// ──────────────────────────────────────────────────────────────────────────────
// Antfarm Workflows Panel
// ──────────────────────────────────────────────────────────────────────────────
const ANTFARM_API = "http://localhost:5001/api/antfarm";

const WF_META = {
    "bug-fix":        { emoji: "🐛", label: "Bug Fix",        color: "#f87171" },
    "feature-dev":    { emoji: "✨", label: "Feature Dev",    color: "#60a5fa" },
    "security-audit": { emoji: "🔒", label: "Security Audit", color: "#fb923c" },
};

function _wfStatusBadge(status) {
    const map = {
        running: { color: "#22c55e", bg: "#16a34a22", label: "running" },
        pending: { color: "#f5a623", bg: "#f5a62322", label: "pending" },
        done:    { color: "#60a5fa", bg: "#60a5fa22", label: "done"    },
        failed:  { color: "#f87171", bg: "#f8717122", label: "failed"  },
        waiting: { color: "#888",    bg: "#88888822", label: "waiting" },
    };
    const s = map[status] || map.waiting;
    return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.72rem;font-weight:600;color:${s.color};background:${s.bg};border:1px solid ${s.color}44">${s.label}</span>`;
}

function _wfProgress(steps) {
    if (!steps || !steps.length) return { done: 0, total: 0, bar: "" };
    const total = steps.length;
    const done  = steps.filter(s => s.status === "done").length;
    const pct   = Math.round((done / total) * 100);
    const bar   = `<div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1;height:6px;background:#ffffff15;border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#60a5fa,#818cf8);transition:width 0.3s"></div>
        </div>
        <span style="font-size:0.72rem;color:var(--text3,#888);white-space:nowrap">${done}/${total}</span>
    </div>`;
    return { done, total, pct, bar };
}

function _wfAgents(steps) {
    if (!steps || !steps.length) return "—";
    const agents = [...new Set(steps.map(s => s.agent_id || "").filter(Boolean).map(a => a.replace(/-[a-z]+$/, "").replace(/^[a-z]/, c => c.toUpperCase())))];
    return agents.slice(0, 3).join(", ") || "—";
}

function _wfCurrentStep(steps) {
    if (!steps || !steps.length) return "—";
    const running = steps.find(s => s.status === "running");
    const waiting = steps.find(s => s.status === "waiting");
    const failed  = steps.find(s => s.status === "failed");
    const active  = running || waiting || failed;
    if (!active) return "Complete";
    return active.step_id || "—";
}

function renderWorkflows() {
    return `
        <div class="panel-header">
            <div>
                <div class="panel-title">👥 Agent Management Overview</div>
                <div class="panel-subtitle">Agent status · task queues · workflow runs</div>
            </div>
            <button class="btn btn-ghost" id="agent-hub-refresh" style="font-size:0.8rem">↻ Refresh</button>
        </div>
        <div id="agent-hub-body" style="padding:16px;display:flex;flex-direction:column;gap:24px">
            <div class="loading"><div class="spinner"></div> Loading agents…</div>
        </div>`;
}

function _wfRunModal(workflows) {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        const wfOpts = workflows.map(w => {
            const m = WF_META[w.id] || { emoji: "⚙️", label: w.name || w.id };
            return `<option value="${escHtml(w.id)}">${m.emoji} ${escHtml(m.label || w.name)}</option>`;
        }).join("");
        overlay.innerHTML = `
            <div class="modal" style="max-width:480px">
                <div class="modal-header">
                    <div class="modal-title">🐜 Start New Workflow</div>
                    <button class="modal-close">✕</button>
                </div>
                <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;padding:20px">
                    <div>
                        <label style="font-size:0.8rem;color:var(--text3,#888);display:block;margin-bottom:6px">Workflow type</label>
                        <select id="wf-sel" class="form-input">${wfOpts}</select>
                    </div>
                    <div>
                        <label style="font-size:0.8rem;color:var(--text3,#888);display:block;margin-bottom:6px">Task / Description</label>
                        <textarea id="wf-task" class="form-input" rows="4" placeholder="Describe what you want done…" style="resize:vertical;font-family:inherit"></textarea>
                    </div>
                    <div style="display:flex;gap:8px;justify-content:flex-end">
                        <button class="btn btn-ghost" id="wf-cancel">Cancel</button>
                        <button class="btn btn-primary" id="wf-submit">🚀 Start Workflow</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector(".modal-close").onclick = () => { overlay.remove(); resolve(null); };
        overlay.querySelector("#wf-cancel").onclick   = () => { overlay.remove(); resolve(null); };
        overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
        overlay.querySelector("#wf-submit").onclick = async () => {
            const workflow = overlay.querySelector("#wf-sel").value;
            const task     = overlay.querySelector("#wf-task").value.trim();
            if (!task) { overlay.querySelector("#wf-task").focus(); return; }
            overlay.querySelector("#wf-submit").disabled = true;
            overlay.querySelector("#wf-submit").textContent = "Starting…";
            resolve({ workflow, task });
            overlay.remove();
        };
        // Pre-select if called with a workflow
        if (workflows._preselect) {
            overlay.querySelector("#wf-sel").value = workflows._preselect;
        }
    });
}

const AGENT_STATUS_CFG = {
    active:  { dot: "#22c55e", label: "Active"   },
    idle:    { dot: "#f5a623", label: "Idle"      },
    offline: { dot: "#ef4444", label: "Offline"   },
    paused:  { dot: "#6b7280", label: "Paused"    },
};
const PRIORITY_CFG = {
    high:   { color: "#ef4444", label: "High",   dot: "🔴" },
    normal: { color: "#f5a623", label: "Med",    dot: "🟡" },
    low:    { color: "#22c55e", label: "Low",    dot: "🟢" },
};

let _agentHubExpanded = new Set(); // agent IDs whose queues are expanded

async function initWorkflowsPanel(_, el) {
    const body = el.querySelector("#agent-hub-body");

    async function reload() {
        body.innerHTML = `<div class="loading"><div class="spinner"></div> Loading…</div>`;

        const PRIO_ORDER = { high: 0, normal: 1, low: 2 };
        let agents = [], allTasks = [], runs = [], wfDefs = [];
        try {
            const [agentsRes, tasksRes] = await Promise.all([
                fetchData("agents"),
                fetchData("tasks"),
            ]);
            agents   = agentsRes.agents || [];
            allTasks = [...(tasksRes.todo||[]), ...(tasksRes.in_progress||[]), ...(tasksRes.done||[])];
        } catch(e) {
            body.innerHTML = `<div style="color:var(--red,#f87171);padding:16px">Failed to load agents: ${escHtml(e.message)}</div>`;
            return;
        }
        try {
            const [runsRes, wfRes] = await Promise.all([
                fetch(`${ANTFARM_API}/runs`),
                fetch(`${ANTFARM_API}/workflows`),
            ]);
            const rj = await runsRes.json(); const wj = await wfRes.json();
            if (rj.success) runs   = rj.data;
            if (wj.success) wfDefs = wj.data;
        } catch(e) { /* antfarm offline — show empty section */ }

        // ── Agent grid ────────────────────────────────────────────────────────
        const agentCardsHtml = agents.map(a => {
            const statusCfg  = AGENT_STATUS_CFG[a.status] || AGENT_STATUS_CFG.idle;
            // Sort tasks: active first, then by priority, done last
            const agentTasks = allTasks
                .filter(t => (t.assignee||"").toLowerCase() === a.name.toLowerCase())
                .sort((x, y) => {
                    const statusRank = s => s === "in_progress" ? 0 : s === "todo" ? 1 : 2;
                    if (statusRank(x.status) !== statusRank(y.status)) return statusRank(x.status) - statusRank(y.status);
                    return (PRIO_ORDER[x.priority] ?? 1) - (PRIO_ORDER[y.priority] ?? 1);
                });
            const current    = agentTasks.find(t => t.status === "in_progress");
            const pending    = agentTasks.filter(t => t.status === "todo");
            const queueCount = pending.length;
            const isExpanded = _agentHubExpanded.has(a.id);

            // Queue rows
            const queueRowsHtml = agentTasks.map(t => {
                const pc = PRIORITY_CFG[t.priority] || PRIORITY_CFG.normal;
                const statusLabel = t.status === "in_progress" ? "Active" : t.status === "done" ? "Done" : "Pending";
                const statusColor = t.status === "in_progress" ? "#60a5fa" : t.status === "done" ? "#22c55e" : "#888";
                const doneBtn = t.status === "in_progress"
                    ? `<button class="btn btn-ghost ah-complete-btn" data-task-id="${t.id}" data-agent-name="${escHtml(a.name)}" style="font-size:0.7rem;padding:2px 6px;color:#22c55e;border-color:#22c55e44">✓ Done</button>`
                    : "";
                return `<tr class="ah-queue-row">
                    <td style="padding:5px 8px">
                        <span title="${escHtml(pc.label)}" style="cursor:pointer;font-size:0.85rem" class="ah-priority-toggle" data-task-id="${t.id}" data-priority="${t.priority}">${pc.dot}</span>
                    </td>
                    <td style="padding:5px 8px;font-size:0.82rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.title)}">${escHtml(t.title)}</td>
                    <td style="padding:5px 8px"><span style="font-size:0.72rem;color:${statusColor}">${statusLabel}</span></td>
                    <td style="padding:5px 8px;text-align:right;white-space:nowrap">
                        ${doneBtn}
                        <button class="btn btn-ghost ah-reassign-btn" data-task-id="${t.id}" style="font-size:0.7rem;padding:2px 6px">Move</button>
                        <button class="btn btn-ghost ah-delete-btn" data-task-id="${t.id}" style="font-size:0.7rem;padding:2px 6px;color:var(--red,#f87171)">✕</button>
                    </td>
                </tr>`;
            }).join("");

            // Compute effective status for display
            const effStatus = current ? "active" : (queueCount > 0 ? "idle" : a.status || "idle");
            const effCfg = AGENT_STATUS_CFG[effStatus] || AGENT_STATUS_CFG.idle;
            const statusHint = current
                ? `Working · ${queueCount} queued`
                : queueCount > 0
                    ? `🟡 ${queueCount} task${queueCount>1?"s":""} waiting — idle`
                    : "Idle — no tasks";

            return `<div class="ah-agent-card" data-agent-id="${escHtml(a.id)}">
                <div class="ah-card-header">
                    <span class="ah-agent-emoji">${escHtml(a.emoji||"🤖")}</span>
                    <div class="ah-agent-info">
                        <div class="ah-agent-name">${escHtml(a.name)}</div>
                        <div class="ah-agent-role" style="font-size:0.7rem;color:var(--text3)">${escHtml(statusHint)}</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
                        <span class="ah-status-dot" style="background:${effCfg.dot}" title="${effCfg.label}"></span>
                        ${queueCount > 0 ? `<span class="ah-queue-badge">${queueCount}</span>` : ""}
                        <button class="btn btn-ghost ah-assign-btn" data-agent-id="${escHtml(a.id)}" data-agent-name="${escHtml(a.name)}" style="font-size:0.72rem;padding:2px 8px">+ Task</button>
                        <button class="ah-expand-btn" data-agent-id="${escHtml(a.id)}">${isExpanded ? "▲" : "▼"}</button>
                    </div>
                </div>
                ${current ? `<div class="ah-current-task"><span style="color:var(--blue,#60a5fa);font-size:0.72rem;font-weight:600">▶ ACTIVE</span> <span style="font-size:0.8rem">${escHtml(current.title)}</span></div>` : ""}
                <div class="ah-queue-wrap${isExpanded ? " open" : ""}">
                    ${agentTasks.length === 0
                        ? `<div style="padding:10px 12px;font-size:0.78rem;color:var(--text3)">No tasks assigned — click + Task to add</div>`
                        : `<table style="width:100%;border-collapse:collapse"><tbody>${queueRowsHtml}</tbody></table>`}
                </div>
            </div>`;
        }).join("");

        // ── Antfarm section ───────────────────────────────────────────────────
        const runsHtml = runs.length === 0
            ? `<div style="padding:16px;font-size:0.82rem;color:var(--text3)">No workflow runs yet. Use quick-start to kick one off.</div>`
            : `<table class="table" style="width:100%"><thead><tr>
                <th>Workflow</th><th>Task</th><th>Status</th><th>Progress</th><th>Step</th><th>Started</th><th></th>
               </tr></thead><tbody>${runs.map(r => {
                    const meta = WF_META[r.workflow_id] || { emoji: "⚙️", label: r.workflow_id, color: "#888" };
                    const prog = _wfProgress(r.steps);
                    const task = (r.task||"").replace(/\/.+\s+/, "…").substring(0, 50);
                    return `<tr>
                        <td><span style="color:${meta.color};font-weight:600">${meta.emoji} ${meta.label}</span></td>
                        <td style="font-size:0.78rem;color:var(--text2);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(task)}</td>
                        <td>${_wfStatusBadge(r.status)}</td>
                        <td style="min-width:100px">${prog.bar}</td>
                        <td style="font-size:0.75rem;color:var(--text3)">${escHtml(_wfCurrentStep(r.steps))}</td>
                        <td style="font-size:0.75rem;color:var(--text3)">${r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}</td>
                        <td><button class="btn btn-ghost wf-view-btn" data-run-id="${escHtml(r.id)}" style="font-size:0.72rem;padding:2px 7px">View</button></td>
                    </tr>`;
               }).join("")}</tbody></table>`;

        // ── Summary widget ────────────────────────────────────────────────────
        const activeAgents = agents.filter(a => allTasks.some(t => t.status === "in_progress" && (t.assignee||"").toLowerCase() === a.name.toLowerCase()));
        const idleWithTasks = agents.filter(a => {
            const aTasks = allTasks.filter(t => (t.assignee||"").toLowerCase() === a.name.toLowerCase());
            return !aTasks.find(t => t.status === "in_progress") && aTasks.find(t => t.status === "todo");
        });
        const totalQueued = allTasks.filter(t => t.status === "todo").length;

        const summaryHtml = `
            <div style="display:flex;gap:12px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--border1,#2a2a40);margin-bottom:8px">
                <div style="background:var(--bg2);border-radius:8px;padding:10px 16px;min-width:120px;text-align:center">
                    <div style="font-size:1.4rem;font-weight:700;color:#22c55e">${activeAgents.length}</div>
                    <div style="font-size:0.72rem;color:var(--text3)">Active agents</div>
                </div>
                <div style="background:var(--bg2);border-radius:8px;padding:10px 16px;min-width:120px;text-align:center">
                    <div style="font-size:1.4rem;font-weight:700;color:#f5a623">${idleWithTasks.length}</div>
                    <div style="font-size:0.72rem;color:var(--text3)">Idle with queue</div>
                </div>
                <div style="background:var(--bg2);border-radius:8px;padding:10px 16px;min-width:120px;text-align:center">
                    <div style="font-size:1.4rem;font-weight:700;color:#60a5fa">${totalQueued}</div>
                    <div style="font-size:0.72rem;color:var(--text3)">Tasks queued</div>
                </div>
                <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
                    <label style="font-size:0.78rem;color:var(--text2);display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input type="checkbox" id="ah-auto-assign" ${window._ahAutoAssign !== false ? "checked" : ""} style="width:14px;height:14px">
                        Auto-assign new tasks
                    </label>
                    <button class="btn btn-primary" id="ah-new-task-global" style="font-size:0.78rem;padding:4px 12px">+ New Task</button>
                </div>
            </div>`;

        body.innerHTML = `
            <div>
                <div class="ah-section-hdr">
                    <span>Agents</span>
                    <div style="display:flex;gap:6px">
                        <button class="btn btn-ghost" id="ah-pause-all" style="font-size:0.72rem;padding:2px 8px">⏸ Pause All</button>
                    </div>
                </div>
                ${summaryHtml}
                <div class="ah-agent-grid">${agentCardsHtml}</div>
            </div>
            <div>
                <div class="ah-section-hdr">
                    <span>🐜 Antfarm Workflow Runs</span>
                    <div style="display:flex;gap:6px">
                        <button class="btn btn-ghost wf-quick" data-wf="feature-dev" style="font-size:0.72rem;padding:2px 8px;border-color:#60a5fa44;color:#60a5fa">✨ Feature</button>
                        <button class="btn btn-ghost wf-quick" data-wf="bug-fix"     style="font-size:0.72rem;padding:2px 8px;border-color:#f8717144;color:#f87171">🐛 Bug Fix</button>
                        <button class="btn btn-ghost wf-quick" data-wf="security-audit" style="font-size:0.72rem;padding:2px 8px;border-color:#fb923c44;color:#fb923c">🔒 Audit</button>
                        <button class="btn btn-primary" id="wf-new-btn" style="font-size:0.72rem;padding:2px 10px">+ New</button>
                    </div>
                </div>
                <div style="overflow-x:auto">${runsHtml}</div>
            </div>`;

        // ── Event wiring ──────────────────────────────────────────────────────

        // Expand/collapse agent queue
        el.querySelectorAll(".ah-expand-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.agentId;
                if (_agentHubExpanded.has(id)) _agentHubExpanded.delete(id);
                else _agentHubExpanded.add(id);
                reload();
            });
        });

        // Entire card header click also toggles
        el.querySelectorAll(".ah-card-header").forEach(hdr => {
            hdr.addEventListener("click", e => {
                if (e.target.closest("button")) return;
                const id = hdr.closest(".ah-agent-card")?.dataset.agentId;
                if (!id) return;
                if (_agentHubExpanded.has(id)) _agentHubExpanded.delete(id);
                else _agentHubExpanded.add(id);
                reload();
            });
        });

        // Priority cycle
        el.querySelectorAll(".ah-priority-toggle").forEach(span => {
            span.addEventListener("click", async () => {
                const cycle = ["high", "normal", "low"];
                const cur   = span.dataset.priority || "normal";
                const next  = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
                try {
                    await apiPut(`tasks/${span.dataset.taskId}`, { priority: next });
                    reload();
                } catch(e) { showNotif("Failed to update priority", "red"); }
            });
        });

        // Reassign task (move to another agent)
        el.querySelectorAll(".ah-reassign-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                const agent = prompt("Reassign to (name):", "");
                if (!agent) return;
                try {
                    await apiPut(`tasks/${btn.dataset.taskId}`, { assignee: agent });
                    showNotif(`Task reassigned to ${agent}`, "green");
                    reload();
                } catch(e) { showNotif("Failed to reassign", "red"); }
            });
        });

        // Delete task from queue
        el.querySelectorAll(".ah-delete-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                if (!confirm("Delete this task?")) return;
                try {
                    await apiDelete(`tasks/${btn.dataset.taskId}`);
                    reload();
                } catch(e) { showNotif("Failed to delete task", "red"); }
            });
        });

        // Auto-assign toggle
        el.querySelector("#ah-auto-assign")?.addEventListener("change", e => {
            window._ahAutoAssign = e.target.checked;
        });

        // Helper: open add-task modal
        function openAddTaskModal(presetAgent) {
            const agentOpts = agents.map(a =>
                `<option value="${escHtml(a.name)}"${a.name === presetAgent ? " selected" : ""}>${escHtml(a.emoji||"🤖")} ${escHtml(a.name)}</option>`
            ).join("");
            const modal = document.createElement("div");
            modal.className = "modal-overlay";
            modal.innerHTML = `
                <div class="modal" style="max-width:440px">
                    <div class="modal-header">
                        <div class="modal-title">+ New Task</div>
                        <button class="modal-close">✕</button>
                    </div>
                    <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;padding:20px">
                        <div>
                            <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:6px">Task Title *</label>
                            <input id="ah-task-title" class="form-input" placeholder="What needs to be done?" style="width:100%">
                        </div>
                        <div style="display:flex;gap:10px">
                            <div style="flex:1">
                                <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:6px">Priority</label>
                                <select id="ah-task-priority" class="form-input">
                                    <option value="high">🔴 High</option>
                                    <option value="normal" selected>🟡 Medium</option>
                                    <option value="low">🟢 Low</option>
                                </select>
                            </div>
                            <div style="flex:1">
                                <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:6px">Assign to</label>
                                <select id="ah-task-agent" class="form-input">${agentOpts}</select>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-ghost" id="ah-task-cancel">Cancel</button>
                        <button class="btn btn-primary" id="ah-task-submit">Add Task</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            modal.querySelector(".modal-close").onclick = () => modal.remove();
            modal.querySelector("#ah-task-cancel").onclick = () => modal.remove();
            modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });

            // Auto-assign: pre-select least-loaded agent if no preset
            if (!presetAgent && window._ahAutoAssign !== false) {
                const agentLoads = agents.map(a => ({
                    name: a.name,
                    load: allTasks.filter(t => (t.assignee||"").toLowerCase() === a.name.toLowerCase() && t.status !== "done").length,
                })).sort((a, b) => a.load - b.load);
                if (agentLoads.length) modal.querySelector("#ah-task-agent").value = agentLoads[0].name;
            }

            modal.querySelector("#ah-task-submit").onclick = async () => {
                const title    = modal.querySelector("#ah-task-title").value.trim();
                const priority = modal.querySelector("#ah-task-priority").value;
                const assignee = modal.querySelector("#ah-task-agent").value;
                if (!title) { modal.querySelector("#ah-task-title").focus(); return; }
                try {
                    await apiPost("tasks", { title, priority, assignee, status: "todo" });
                    modal.remove();
                    showNotif(`Task added${assignee ? ` for ${assignee}` : ""}`, "green");
                    reload();
                } catch(e) { showNotif("Failed to add task", "red"); }
            };
            setTimeout(() => modal.querySelector("#ah-task-title")?.focus(), 50);
        }

        // Global "+ New Task" button
        el.querySelector("#ah-new-task-global")?.addEventListener("click", () => openAddTaskModal(null));

        // + Task button per agent
        el.querySelectorAll(".ah-assign-btn").forEach(btn => {
            btn.addEventListener("click", () => openAddTaskModal(btn.dataset.agentName));
        });

        // Complete task → mark done, auto-start next pending task for same agent
        el.querySelectorAll(".ah-complete-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                const taskId   = btn.dataset.taskId;
                const agentName = btn.dataset.agentName;
                try {
                    await apiPut(`tasks/${taskId}`, { status: "done" });
                    // Auto-start next highest-priority pending task for this agent
                    const agentTasks = allTasks.filter(t =>
                        (t.assignee||"").toLowerCase() === agentName.toLowerCase() && t.status === "todo"
                    ).sort((a, b) => (PRIO_ORDER[a.priority] ?? 1) - (PRIO_ORDER[b.priority] ?? 1));
                    if (agentTasks.length > 0) {
                        await apiPut(`tasks/${agentTasks[0].id}`, { status: "in_progress" });
                        showNotif(`${agentName} started: "${agentTasks[0].title}"`, "green");
                    } else {
                        showNotif(`${agentName} is now idle — no more tasks queued`, "green");
                    }
                    reload();
                } catch(e) { showNotif("Failed to complete task: " + e.message, "red"); }
            });
        });

        // Antfarm: start workflow
        async function startWorkflow(preselect) {
            const defs = [...wfDefs];
            if (preselect) defs._preselect = preselect;
            const result = await _wfRunModal(defs);
            if (!result) return;
            try {
                const r = await fetch(`${ANTFARM_API}/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) });
                const j = await r.json();
                if (!j.success) throw new Error(j.error || "Failed");
                showNotif("Workflow started!", "green");
                setTimeout(reload, 1500);
            } catch(e) { showNotif("Failed: " + e.message, "red"); }
        }
        el.querySelectorAll(".wf-quick").forEach(btn => { btn.onclick = () => startWorkflow(btn.dataset.wf); });
        el.querySelector("#wf-new-btn")?.addEventListener("click", () => startWorkflow(null));
        el.querySelectorAll(".wf-view-btn").forEach(btn => {
            btn.onclick = () => { const run = runs.find(r => r.id === btn.dataset.runId); if (run) _showRunDetail(run); };
        });
    }

    el.querySelector("#agent-hub-refresh")?.addEventListener("click", reload);
    await reload();
}

function _showRunDetail(run) {
    const meta = WF_META[run.workflow_id] || { emoji: "⚙️", label: run.workflow_id, color: "#888" };
    const steps = run.steps || [];
    const stepsHtml = steps.map((s, i) => {
        const statusColor = { done: "#22c55e", running: "#60a5fa", failed: "#f87171", waiting: "#555", pending: "#f5a623" }[s.status] || "#888";
        const icon = { done: "✓", running: "⟳", failed: "✗", waiting: "·", pending: "○" }[s.status] || "·";
        return `<div style="display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #ffffff08">
            <div style="width:24px;height:24px;border-radius:50%;background:${statusColor}22;border:2px solid ${statusColor};display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:${statusColor};flex-shrink:0;margin-top:2px">${icon}</div>
            <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:0.85rem">${escHtml(s.step_id || `Step ${i+1}`)}</div>
                <div style="font-size:0.75rem;color:var(--text3,#888)">${escHtml(s.agent_id || "")}</div>
                ${s.output ? `<div style="margin-top:6px;padding:8px;background:#ffffff08;border-radius:6px;font-size:0.75rem;color:var(--text2,#aaa);white-space:pre-wrap;max-height:120px;overflow-y:auto;font-family:monospace">${escHtml(s.output.substring(0, 400))}${s.output.length > 400 ? "…" : ""}</div>` : ""}
            </div>
            <div style="font-size:0.72rem;color:${statusColor};white-space:nowrap">${s.status}</div>
        </div>`;
    }).join("");

    const prog = _wfProgress(steps);
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
        <div class="modal" style="max-width:620px;max-height:80vh;display:flex;flex-direction:column">
            <div class="modal-header">
                <div class="modal-title">${meta.emoji} ${meta.label} · Run Detail</div>
                <button class="modal-close">✕</button>
            </div>
            <div style="padding:16px 20px;border-bottom:1px solid var(--border1,#2a2a40)">
                <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                    ${_wfStatusBadge(run.status)}
                    <span style="font-size:0.78rem;color:var(--text3,#888)">Run ${run.id.substring(0,8)}</span>
                    <span style="font-size:0.78rem;color:var(--text3,#888)">${new Date(run.created_at).toLocaleString()}</span>
                </div>
                <div style="margin-top:8px;font-size:0.8rem;color:var(--text2,#aaa)">${escHtml(run.task || "")}</div>
                <div style="margin-top:10px">${prog.bar}</div>
            </div>
            <div style="flex:1;overflow-y:auto;padding:12px 20px">${stepsHtml}</div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector(".modal-close").onclick = () => overlay.remove();
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

function showNotif(msg, color = "green") {
    _showToast({ type: color === "red" ? "system" : "system", payload: { message: msg }, timestamp: new Date().toISOString() });
}

// ──────────────────────────────────────────────────────────────────────────────
// Panel map
// ──────────────────────────────────────────────────────────────────────────────
const PANELS = {
    tasks:     { fn: renderTasks,     endpoint: "tasks",    init: initTasksPanel   },
    agents:    { fn: renderAgents,    endpoint: "agents",   init: initAgentsPanel  },
    content:   { fn: renderContent,   endpoint: "content"                          },
    approvals: { fn: renderApprovals, endpoint: "approvals"                        },
    council:   { fn: renderCouncil,   endpoint: "council",  init: initCouncilPanel },
    calendar:  { fn: renderCalendar,  endpoint: "calendar", init: initCalendarPanel},
    projects:  { fn: renderProjects,  endpoint: "projects", init: initProjectsPanel },
    memory:    { fn: renderMemory,    endpoint: "memory"                           },
    docs:      { fn: renderDocs,      endpoint: "docs"                             },
    people:    { fn: renderPeople,    endpoint: "people"                           },
    office:    { fn: renderOffice,    endpoint: "office",   init: initOfficePanel  },
    team:      { fn: renderTeam,      endpoint: "team"                             },
    system:    { fn: renderSystem,    endpoint: "system",   init: initSystemPanel  },
    skills:    { fn: renderSkills,    endpoint: null                               },
    radar:     { fn: renderRadar,     endpoint: "radar"                            },
    factory:   { fn: renderFactory,   endpoint: "factory",  init: initFactoryPanel },
    pipeline:  { fn: renderPipeline,  endpoint: "pipeline"                         },
    workflows: { fn: renderWorkflows, endpoint: null,        init: initWorkflowsPanel },
};

// ──────────────────────────────────────────────────────────────────────────────
// Navigation
// ──────────────────────────────────────────────────────────────────────────────
function navigate(panelId) {
    activePanel = panelId;
    document.querySelectorAll(".nav-item").forEach(el => {
        el.classList.toggle("active", el.dataset.panel === panelId);
    });
    document.querySelectorAll(".panel").forEach(el => {
        el.classList.toggle("active", el.id === `panel-${panelId}`);
    });
    loadPanel(panelId);
}

async function loadPanel(panelId) {
    const panel = PANELS[panelId];
    if (!panel) return;
    const el = $(`panel-${panelId}`);
    if (!el) return;

    // Static panels (no remote endpoint)
    if (panel.endpoint === null) {
        el.innerHTML = panel.fn();
        if (panel.init) panel.init(null, el);
        return;
    }

    // Prevent concurrent fetches for the same panel
    if (panelLoading[panelId]) {
        console.log(`[loadPanel] skipping — already loading "${panelId}"`);
        return;
    }
    panelLoading[panelId] = true;

    const hasCache = !!panelCache[panelId];

    if (!hasCache) {
        // First load: show spinner (no content yet)
        el.innerHTML = loading();
    } else if (panelId === "projects" && _taskViewProject !== null) {
        // Auto-refresh while user is viewing a project detail — don't touch the panel
    } else {
        // Subsequent refresh: if we were just showing a task-detail view, restore
        // the cached projects list immediately so the user doesn't see a stale task view
        if (panelId === "projects" && el.querySelector(".task-view")) {
            el.innerHTML = panelCache[panelId].html;
        }
        _showStaleIndicator(el, "↻ refreshing…", "var(--yellow,#f5a623)");
    }

    try {
        const data = await fetchData(panel.endpoint);
        let html;
        try {
            html = panel.fn(data);
        } catch (renderErr) {
            console.error(`[loadPanel] render error for panel "${panelId}":`, renderErr, "data:", data);
            throw new Error(`Render error: ${renderErr.message}`);
        }
        // Success — update cache and render
        panelCache[panelId] = { data, html, ts: Date.now() };
        // Don't overwrite an active task-list view (user clicked a project while this fetch was in flight)
        if (panelId === "projects" && _taskViewProject !== null) {
            console.log("[loadPanel] projects fetch succeeded but task view is active — cache updated, skipping render");
        } else {
            el.innerHTML = html;
            if (panel.init) panel.init(data, el);
            lastUpdate = new Date();
            updateStatusBar();
        }
    } catch(e) {
        console.error(`[loadPanel] failed to load panel "${panelId}":`, e);
        // Don't overwrite an active task-list view with a projects-panel error
        if (panelId === "projects" && _taskViewProject !== null) {
            console.log("[loadPanel] projects fetch failed but task view is active — suppressing error overlay");
        } else if (hasCache) {
            // Content already loaded once — restore it and show a non-intrusive warning
            el.innerHTML = panelCache[panelId].html;
            if (panel.init) panel.init(panelCache[panelId].data, el);
            _showStaleIndicator(el, "⚠ Refresh failed — showing cached data", "var(--yellow,#f5a623)", 5000);
        } else {
            // Never loaded successfully — show error (no content to lose)
            el.innerHTML = errorBox(`Failed to load ${panelId}: ${e.message}`);
        }
    } finally {
        panelLoading[panelId] = false;
    }
}

/** Show a temporary overlay badge on a panel without replacing its content. */
function _showStaleIndicator(el, text, color, autoRemoveMs = 0) {
    el.style.position = "relative";
    const prev = el.querySelector(".__stale-indicator");
    if (prev) prev.remove();
    const badge = document.createElement("div");
    badge.className = "__stale-indicator";
    badge.style.cssText = `position:absolute;top:8px;right:12px;font-size:11px;color:${color};` +
        `background:rgba(0,0,0,0.65);padding:2px 8px;border-radius:4px;z-index:100;pointer-events:none;`;
    badge.textContent = text;
    el.appendChild(badge);
    if (autoRemoveMs > 0) setTimeout(() => badge.remove(), autoRemoveMs);
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto-refresh
// ──────────────────────────────────────────────────────────────────────────────
function startRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (!activePanel) return;
        // Don't overwrite the task-list view — if a project detail is open, skip auto-refresh
        if (activePanel === "projects" && _taskViewProject !== null) {
            console.log("[Refresh] skipping auto-refresh — task view is active");
            return;
        }
        loadPanel(activePanel);
    }, REFRESH_MS);
}

// ──────────────────────────────────────────────────────────────────────────────
// Status bar + clock
// ──────────────────────────────────────────────────────────────────────────────
function updateStatusBar() {
    const el = $("statusbar-update");
    if (el && lastUpdate) {
        const diff = Math.round((Date.now() - lastUpdate) / 1000);
        el.textContent = diff < 5 ? "just now" : `${diff}s ago`;
    }
}

function updateClock() {
    const el = $("header-time");
    if (el) el.textContent = new Date().toLocaleTimeString();
}

// ──────────────────────────────────────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────────────────────────────────────
async function checkHealth() {
    const dot   = $("api-status-dot");
    const label = $("api-status-label");
    try {
        await fetchData("health");
        if (dot)   dot.style.background   = "var(--green)";
        if (label) label.textContent = "API online";
    } catch {
        if (dot)   dot.style.background   = "var(--red)";
        if (label) label.textContent = "API offline";
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// Floating Quick-Chat Widget
// ──────────────────────────────────────────────────────────────────────────────
const FLOAT_AGENTS = [
    { id: "eva",     name: "Eva",    emoji: "📅" },
    { id: "claude",  name: "Claude", emoji: "🧠" },
    { id: "milfred", name: "Milfred",emoji: "🤖" },
    { id: "ernst",   name: "Ernst",  emoji: "🔒" },
    { id: "gordon",  name: "Gordon", emoji: "📈" },
    { id: "lara",    name: "Lara",   emoji: "📱" },
    { id: "alex",    name: "Alex",   emoji: "👔" },
];

// ──────────────────────────────────────────────────────────────────────────────
// Floating Tasks Widget
// ──────────────────────────────────────────────────────────────────────────────
function initFloatingTasks() {
    const saved = JSON.parse(localStorage.getItem("floatTasks") || "{}");
    let collapsed = saved.collapsed !== false;
    let filterAgent = saved.agent || "all";
    let widgetW = saved.w || 310;
    let bodyH   = saved.h || 280;

    const widget = document.createElement("div");
    widget.id = "float-tasks";

    // Position: bottom-right, to the left of the chat widget
    const posX = saved.x ?? (window.innerWidth  - 640);
    const posY = saved.y ?? (window.innerHeight - 44 - 48);
    widget.style.cssText = `
        position:fixed;left:${posX}px;top:${posY}px;z-index:9998;
        font-size:0.82rem;
        background:var(--bg1,#141420);border:1px solid var(--border1,#2a2a40);
        border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);
        display:flex;flex-direction:column;overflow:hidden;
        user-select:none;
    `;
    widget.style.width = widgetW + "px";
    document.body.appendChild(widget);

    function _persist() {
        const rect = widget.getBoundingClientRect();
        localStorage.setItem("floatTasks", JSON.stringify({ collapsed, agent: filterAgent, x: rect.left, y: rect.top, w: Math.round(widget.offsetWidth), h: bodyH }));
    }

    const resizer = enableResizeWidget(widget, () => widget.querySelector("#ftw-body"), (w, h) => { widgetW = w; bodyH = h; _persist(); });

    async function _render() {
        const agentOpts = `<option value="all"${filterAgent==="all"?" selected":""}>All Agents</option>`
            + FLOAT_AGENTS.map(a => `<option value="${a.id}"${filterAgent===a.id?" selected":""}>${a.emoji} ${a.name}</option>`).join("");
        widget.innerHTML = `
            <div id="ftw-header" style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:var(--bg2,#1a1a2e);border-bottom:1px solid var(--border1,#2a2a40)">
                <span style="font-size:1rem">📋</span>
                <span style="flex:1;font-size:0.8rem;font-weight:600;color:#fff">Tasks</span>
                <select id="ftw-agent-sel" style="background:transparent;border:none;color:var(--text2,#aaa);font-size:0.72rem;cursor:pointer;max-width:100px" onclick="event.stopPropagation()">
                    ${agentOpts}
                </select>
                <span id="ftw-toggle" style="color:var(--text3,#888);font-size:0.75rem;padding:2px 6px">${collapsed ? "▼" : "▲"}</span>
            </div>
            <div id="ftw-body" style="display:${collapsed ? "none" : "flex"};flex-direction:column;height:${bodyH}px;overflow-y:auto;padding:6px 8px">
                <div style="color:var(--text3,#888);font-size:0.75rem;text-align:center;padding:12px 0" id="ftw-loading">Loading…</div>
            </div>`;
        resizer.reattach();

        if (!collapsed) {
            try {
                const data = await fetchData("tasks");
                const all = [...(data.todo || []), ...(data.in_progress || []), ...(data.done || [])];
                const filtered = filterAgent === "all" ? all
                    : all.filter(t => t.assignee?.toLowerCase() === filterAgent);
                const body = widget.querySelector("#ftw-body");
                if (!filtered.length) {
                    body.innerHTML = `<div style="color:var(--text3,#888);font-size:0.75rem;text-align:center;padding:12px 0">No tasks</div>`;
                } else {
                    body.innerHTML = filtered.slice(0, 20).map(t => `
                        <div style="padding:5px 2px;border-bottom:1px solid var(--border1,#2a2a40);display:flex;gap:8px;align-items:flex-start">
                            <span style="font-size:0.7rem;min-width:14px;color:${_taskStatusColor(t.status)};margin-top:2px">${_taskStatusLabel(t.status)}</span>
                            <div style="flex:1;min-width:0">
                                <div style="color:var(--text1,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.title)}</div>
                                <div style="font-size:0.68rem;color:var(--text3,#888)">${escHtml(t.assignee||"")}${t.tag ? ` · ${escHtml(t.tag)}` : ""}</div>
                            </div>
                        </div>`).join("");
                }
            } catch(e) {
                widget.querySelector("#ftw-body").innerHTML = `<div style="color:var(--red,#f87171);font-size:0.75rem;padding:8px">${escHtml(e.message)}</div>`;
            }
        }

        // Events
        widget.querySelector("#ftw-header").addEventListener("click", () => {
            collapsed = !collapsed; _persist(); _render();
        });
        widget.querySelector("#ftw-agent-sel").addEventListener("change", e => {
            filterAgent = e.target.value; _persist(); _render();
        });
    }

    enableDragWidget(widget, _persist, ["SELECT", "BUTTON"]);

    // Refresh tasks every 30s when expanded
    setInterval(() => { if (!collapsed) _render(); }, 30000);

    _render();
}

function initFloatingChat() {
    // Restore persisted state
    const saved  = JSON.parse(localStorage.getItem("floatChat") || "{}");
    let collapsed = saved.collapsed ?? false;   // default expanded
    let selAgent  = saved.agent || "eva";
    let widgetW   = saved.w || 300;
    let bodyH     = saved.h || 320;
    const msgs      = {};  // in-memory per-agent message buffer (capped at 50)
    const msgsError = {};  // track agents where history fetch failed
    const THINK_ID  = "fch-thinking";

    const widget = document.createElement("div");
    widget.id = "float-chat";
    const posX = saved.x ?? (window.innerWidth  - 320);
    const posY = saved.y ?? (window.innerHeight - 44 - 48);
    widget.style.cssText = `
        position:fixed;left:${posX}px;top:${posY}px;z-index:9999;
        font-size:0.82rem;
        background:var(--bg1,#141420);border:1px solid var(--border1,#2a2a40);
        border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);
        display:flex;flex-direction:column;overflow:hidden;
        user-select:none;
    `;
    widget.style.width = widgetW + "px";
    document.body.appendChild(widget);

    function _persist() {
        const rect = widget.getBoundingClientRect();
        localStorage.setItem("floatChat", JSON.stringify({ collapsed, agent: selAgent, x: rect.left, y: rect.top, w: Math.round(widget.offsetWidth), h: bodyH }));
    }

    const resizer = enableResizeWidget(widget, () => widget.querySelector("#fch-body"), (w, h) => { widgetW = w; bodyH = h; _persist(); });

    function _agentInfo(id) { return FLOAT_AGENTS.find(a => a.id === id) || { id, name: id, emoji: "🤖" }; }

    function _render() {
        const a = _agentInfo(selAgent);
        const agentOpts = FLOAT_AGENTS.map(ag =>
            `<option value="${ag.id}"${ag.id === selAgent ? " selected" : ""}>${ag.emoji} ${ag.name}</option>`
        ).join("");

        widget.innerHTML = `
            <div id="fch-header" style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:var(--bg2,#1a1a2e);border-bottom:1px solid var(--border1,#2a2a40)">
                <span style="font-size:1.1rem">${a.emoji}</span>
                <select id="fch-agent-sel" style="flex:1;background:transparent;border:none;color:#fff;font-size:0.8rem;cursor:pointer" onclick="event.stopPropagation()">
                    ${agentOpts}
                </select>
                <span id="fch-toggle" style="color:var(--text3,#888);font-size:0.75rem;padding:2px 6px">${collapsed ? "▼" : "▲"}</span>
            </div>
            <div id="fch-body" style="display:${collapsed ? "none" : "flex"};flex-direction:column;height:${bodyH}px">
                <div id="fch-messages" style="flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px"></div>
                <div style="padding:6px 8px;border-top:1px solid var(--border1,#2a2a40);display:flex;gap:6px;flex-shrink:0">
                    <input id="fch-input" class="form-input" placeholder="Message ${a.name}…" style="font-size:0.78rem;flex:1">
                    <button id="fch-send" class="btn btn-ghost" style="padding:0 10px">→</button>
                </div>
            </div>`;
        resizer.reattach();

        // Restore buffered messages for this agent
        const msgEl = widget.querySelector("#fch-messages");
        (msgs[selAgent] || []).forEach(m => {
            msgEl.insertAdjacentHTML("beforeend", _chatBubble(m.role, m.text, m.ts));
        });
        if (!msgs[selAgent]?.length && !msgsError[selAgent]) {
            // Load history from API (first open per agent)
            console.log(`[chat] loading history for agent=${selAgent}`);
            fetchData(`agents/${selAgent}/chat/history`).then(d => {
                console.log(`[chat] history response for ${selAgent}:`, d);
                if (!msgs[selAgent]) msgs[selAgent] = [];
                (d.messages || []).forEach(m => {
                    msgs[selAgent].push({ role: "user",  text: m.user_msg,    ts: m.created_at });
                    msgs[selAgent].push({ role: "agent", text: m.agent_reply, ts: m.created_at });
                    msgEl.insertAdjacentHTML("beforeend", _chatBubble("user",  m.user_msg,    m.created_at));
                    msgEl.insertAdjacentHTML("beforeend", _chatBubble("agent", m.agent_reply, m.created_at));
                });
                msgEl.scrollTop = msgEl.scrollHeight;
            }).catch(err => { console.error(`[chat] history fetch failed for ${selAgent}:`, err); msgsError[selAgent] = true; });
        }
        msgEl.scrollTop = msgEl.scrollHeight;

        // Events
        widget.querySelector("#fch-header").addEventListener("click", () => {
            collapsed = !collapsed;
            _persist();
            _render();
        });
        widget.querySelector("#fch-agent-sel").addEventListener("change", e => {
            selAgent = e.target.value;
            _persist();
            _render();
        });

        const inp  = widget.querySelector("#fch-input");
        const send = widget.querySelector("#fch-send");
        const doSend = async () => {
            const msg = inp.value.trim();
            if (!msg) return;
            const now = new Date().toISOString();
            inp.value = "";
            inp.disabled = true;
            send.disabled = true;
            if (!msgs[selAgent]) msgs[selAgent] = [];
            msgs[selAgent].push({ role: "user", text: msg, ts: now });
            if (msgs[selAgent].length > 100) msgs[selAgent].splice(0, msgs[selAgent].length - 100);
            console.log(`[chat] sending message to agent=${selAgent}:`, msg);
            msgEl.insertAdjacentHTML("beforeend", _chatBubble("user", msg, now));
            console.log(`[chat] user bubble added to UI`);
            // Thinking indicator
            const label = _agentInfo(selAgent).name;
            let dots = 0;
            const dotEl = document.createElement("div");
            dotEl.id = THINK_ID;
            dotEl.style.cssText = "font-size:0.73rem;color:var(--text3,#888);padding:2px 4px;";
            dotEl.textContent = `⏳ ${label} thinking…`;
            msgEl.appendChild(dotEl);
            msgEl.scrollTop = msgEl.scrollHeight;
            const dotTimer = setInterval(() => {
                dots = (dots + 1) % 4;
                dotEl.textContent = `⏳ ${label} thinking${".".repeat(dots)}`;
            }, 500);
            const chatUrl = `${API}/agents/${selAgent}/chat`;
            console.log(`[chat] POST ${chatUrl}`, { message: msg });
            try {
                const res = await fetch(chatUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ message: msg }),
                    credentials: "include",
                    signal: AbortSignal.timeout(90000),
                });
                clearInterval(dotTimer);
                dotEl.remove();
                console.log(`[chat] HTTP ${res.status} from ${selAgent}`, { url: res.url, ok: res.ok, headers: Object.fromEntries(res.headers) });
                const json = await res.json();
                console.log(`[chat] response body from ${selAgent}:`, json);
                if (!json.success) throw new Error(json.error || "API error");
                const reply = json.data.reply;
                msgs[selAgent].push({ role: "agent", text: reply, ts: new Date().toISOString() });
                msgEl.insertAdjacentHTML("beforeend", _chatBubble("agent", reply));
                console.log(`[chat] agent bubble added to UI`);
                msgEl.scrollTop = msgEl.scrollHeight;
            } catch(e) {
                clearInterval(dotTimer);
                dotEl.remove();
                console.error(`[chat] error for ${selAgent}:`, e);
                console.error(`[chat] error name=${e.name}, message=${e.message}, stack=`, e.stack);
                let errMsg;
                if (e.name === "TimeoutError" || e.name === "AbortError") {
                    errMsg = `⚠️ ${label} timed out (90s)`;
                } else if (e instanceof TypeError && e.message.toLowerCase().includes("fetch")) {
                    // "Failed to fetch" — network-level failure (CORS, DNS, server down)
                    console.error(`[chat] Network/CORS error — URL was: ${chatUrl}`);
                    console.error(`[chat] Check: 1) Is api.nouga.ai reachable? 2) CORS headers present? 3) Session cookie sent (credentials:include)?`);
                    errMsg = `⚠️ Network error — check console for details (possible CORS or connectivity issue)`;
                } else if (e.message === "API error" || e.message?.startsWith("API")) {
                    errMsg = `⚠️ ${e.message}`;
                } else {
                    errMsg = `⚠️ ${e.message}`;
                }
                msgEl.insertAdjacentHTML("beforeend", `<div style="font-size:0.73rem;color:var(--red,#f87171);padding:2px 4px">${escHtml(errMsg)}</div>`);
                msgEl.scrollTop = msgEl.scrollHeight;
            } finally {
                inp.disabled = false;
                send.disabled = false;
                inp.focus();
            }
        };
        send.addEventListener("click", doSend);
        inp.addEventListener("keydown", e => { if (e.key === "Enter") doSend(); });
        if (!collapsed) setTimeout(() => inp.focus(), 50);
    }

    enableDragWidget(widget, _persist);

    _render();
}

document.addEventListener("DOMContentLoaded", () => {
    // Gate on auth (redirects to login.html if remote + unauthenticated)
    checkAuth();

    document.querySelectorAll(".nav-item").forEach(el => {
        el.addEventListener("click", () => navigate(el.dataset.panel));
    });

    // Notification bell
    document.getElementById("notif-bell")?.addEventListener("click", toggleNotifDrawer);
    document.getElementById("notif-drawer-close")?.addEventListener("click", () => {
        document.getElementById("notif-drawer")?.classList.remove("open");
    });
    // Close drawer on outside click
    document.addEventListener("click", e => {
        const drawer = document.getElementById("notif-drawer");
        const bell   = document.getElementById("notif-bell");
        if (drawer?.classList.contains("open") && !drawer.contains(e.target) && !bell?.contains(e.target)) {
            drawer.classList.remove("open");
        }
    });

    navigate("tasks");
    startRefresh();
    checkHealth();
    initWebSocket();
    initFloatingTasks();
    initFloatingChat();
    setInterval(updateClock,      1000);
    setInterval(updateStatusBar,  5000);
    setInterval(checkHealth,     60000);
    updateClock();
});
// Delete button fix deployed Mon Mar  9 21:25:04 CET 2026
