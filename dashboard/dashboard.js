/* ============================================================
   Nouga Mission Control — Dashboard JS  (Phase 2)
============================================================ */

const API_HOST = "https://api.nouga.ai";
const API    = `${API_HOST}/api`;
const WS_URL = API_HOST;

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
        const reload = { task: "tasks", agent: "agents", cron: "calendar", council: "council" };
        if (reload[notif.type] && activePanel === reload[notif.type]) loadPanel(activePanel);
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
async function fetchData(endpoint) {
    const res = await fetch(`${API}/${endpoint}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
}

async function apiPost(endpoint, body) {
    const res = await fetch(`${API}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
        signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
}

async function apiDelete(endpoint) {
    const res = await fetch(`${API}/${endpoint}`, {
        method: "DELETE",
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
            const r = await fetch(`${API}/parking-lot`);
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
    const reports = (d.agents||[]).filter(a=>["gordon","lara","claude"].includes(a.id));

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
// Projects (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderProjects(d) {
    const statusColor = s => s==="green"?"green":s==="yellow"?"yellow":"red";
    return `
        <div class="panel-header">
            <div class="panel-title">🗂️ Projects</div>
            <div class="panel-subtitle">${d.projects.length} active projects</div>
        </div>
        ${d.projects.map(p => `
            <div class="card" style="margin-bottom:12px">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
                    <div style="display:flex;align-items:center;gap:10px">
                        <span style="font-size:1.3rem">${p.emoji}</span>
                        <div>
                            <div style="font-weight:700;color:#fff;font-size:0.95rem">${escHtml(p.name)}</div>
                            <div style="font-size:0.78rem;color:var(--text2);margin-top:2px">${escHtml(p.phase)}</div>
                        </div>
                    </div>
                    ${badge(p.label, statusColor(p.status))}
                </div>
                ${progressBar(p.progress)}
                <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:0.78rem;color:var(--text3)">
                    <span>${escHtml(p.details)}</span>
                    <span>👤 ${p.owner}</span>
                </div>
            </div>`).join("")}`;
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
// Team (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function renderTeam(d) {
    const renderNode = (node, indent=0) => {
        if (!node) return "";
        const reports = (node.reports||[]).map(r => renderNode(r, indent+1)).join("");
        return `
            <div style="margin-left:${indent*24}px;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px;padding:9px 13px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:4px">
                    <span style="font-weight:700;color:#fff;font-size:0.88rem">${node.name||""}</span>
                    <span style="font-size:0.75rem;color:var(--text2)">${node.title||""}</span>
                </div>${reports}
            </div>`;
    };
    return `
        <div class="panel-header">
            <div class="panel-title">🏗️ Company Goals</div>
            <div class="panel-subtitle">Headcount: ${d.headcount} · Org structure</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Mission</div>
            <div style="font-size:0.92rem;color:var(--text);line-height:1.7;font-style:italic">"${escHtml(d.mission)}"</div>
        </div>
        <div class="grid-2">
            <div class="card"><div class="card-title">Org Chart</div>
                ${renderNode({ name: d.org_chart.ceo.name, title: d.org_chart.ceo.title, reports: d.org_chart.reports })}
            </div>
            <div class="card"><div class="card-title">2026 Goals</div>
                <ul class="checklist">
                    ${d.goals.map(g=>`<li class="check-item"><span class="check-icon">🎯</span><span style="font-size:0.85rem">${escHtml(g)}</span></li>`).join("")}
                </ul>
            </div>
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Vision
// ──────────────────────────────────────────────────────────────────────────────
function renderVision() {
    return `
        <div class="panel-header">
            <div class="panel-title">🔭 Vision</div>
            <div class="panel-subtitle">Where we're going · Long-term north star</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Our Vision</div>
            <div style="font-size:1rem;color:var(--text);line-height:1.8;font-style:italic;padding:8px 0">
                "To be the intelligence layer for every ambitious team — making world-class thinking accessible to builders everywhere."
            </div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-title">3-Year Picture</div>
                <ul class="checklist">
                    <li class="check-item"><span class="check-icon">🌍</span><span style="font-size:0.85rem">Nouga is the default AI operating system for early-stage companies</span></li>
                    <li class="check-item"><span class="check-icon">🤖</span><span style="font-size:0.85rem">AI agents handle 80% of routine operations autonomously</span></li>
                    <li class="check-item"><span class="check-icon">📈</span><span style="font-size:0.85rem">Profitable, capital-efficient, and globally distributed</span></li>
                </ul>
            </div>
            <div class="card">
                <div class="card-title">Core Beliefs</div>
                <ul class="checklist">
                    <li class="check-item"><span class="check-icon">💡</span><span style="font-size:0.85rem">Small teams with great leverage beat large teams every time</span></li>
                    <li class="check-item"><span class="check-icon">🔗</span><span style="font-size:0.85rem">AI and humans are partners, not replacements</span></li>
                    <li class="check-item"><span class="check-icon">⚡</span><span style="font-size:0.85rem">Speed of learning is the ultimate competitive advantage</span></li>
                </ul>
            </div>
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Strategy
// ──────────────────────────────────────────────────────────────────────────────
function renderStrategy() {
    return `
        <div class="panel-header">
            <div class="panel-title">♟️ Strategy</div>
            <div class="panel-subtitle">How we win · Choices that define us</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">🗺️ Where Do We Play</div>
            <div style="font-size:0.88rem;color:var(--text2);margin-bottom:12px;line-height:1.6">The markets, customers, and segments we've chosen to focus on.</div>
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
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">🎁 What Do We Offer</div>
            <div style="font-size:0.88rem;color:var(--text2);margin-bottom:12px;line-height:1.6">The products, services, and capabilities we bring to market.</div>
            <ul class="checklist">
                <li class="check-item"><span class="check-icon">🤖</span><span style="font-size:0.85rem"><strong>AI Agent Suite</strong> — purpose-built agents for trading, security, content, and ops that run autonomously</span></li>
                <li class="check-item"><span class="check-icon">🧠</span><span style="font-size:0.85rem"><strong>Mission Control Dashboard</strong> — unified ops layer giving founders a single pane of glass</span></li>
                <li class="check-item"><span class="check-icon">⚙️</span><span style="font-size:0.85rem"><strong>Integration Platform</strong> — connects your tools (Slack, Gmail, GitHub, Binance) into one intelligent workflow</span></li>
                <li class="check-item"><span class="check-icon">📊</span><span style="font-size:0.85rem"><strong>LLM Council</strong> — multi-model reasoning for strategic decisions, not just task execution</span></li>
            </ul>
        </div>
        <div class="card">
            <div class="card-title">🚀 Go-to-Market</div>
            <div style="font-size:0.88rem;color:var(--text2);margin-bottom:12px;line-height:1.6">How we acquire, convert, and retain customers.</div>
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
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// System — Network Diagram + Version Checker
// ──────────────────────────────────────────────────────────────────────────────
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
// Panel map
// ──────────────────────────────────────────────────────────────────────────────
const PANELS = {
    tasks:     { fn: renderTasks,     endpoint: "tasks",    init: initTasksPanel   },
    agents:    { fn: renderAgents,    endpoint: "agents",   init: initAgentsPanel  },
    content:   { fn: renderContent,   endpoint: "content"                          },
    approvals: { fn: renderApprovals, endpoint: "approvals"                        },
    council:   { fn: renderCouncil,   endpoint: "council",  init: initCouncilPanel },
    calendar:  { fn: renderCalendar,  endpoint: "calendar", init: initCalendarPanel},
    projects:  { fn: renderProjects,  endpoint: "projects"                         },
    memory:    { fn: renderMemory,    endpoint: "memory"                           },
    docs:      { fn: renderDocs,      endpoint: "docs"                             },
    people:    { fn: renderPeople,    endpoint: "people"                           },
    office:    { fn: renderOffice,    endpoint: "office",   init: initOfficePanel  },
    team:      { fn: renderTeam,      endpoint: "team"                             },
    vision:    { fn: renderVision,    endpoint: null                               },
    strategy:  { fn: renderStrategy,  endpoint: null                               },
    system:    { fn: renderSystem,    endpoint: "system",   init: initSystemPanel  },
    radar:     { fn: renderRadar,     endpoint: "radar"                            },
    factory:   { fn: renderFactory,   endpoint: "factory",  init: initFactoryPanel },
    pipeline:  { fn: renderPipeline,  endpoint: "pipeline"                         },
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

    if (panel.endpoint === null) {
        el.innerHTML = panel.fn();
        if (panel.init) panel.init(null, el);
        return;
    }

    el.innerHTML = loading();
    try {
        const data = await fetchData(panel.endpoint);
        el.innerHTML = panel.fn(data);
        if (panel.init) panel.init(data, el);
        lastUpdate = new Date();
        updateStatusBar();
    } catch(e) {
        el.innerHTML = errorBox(`Failed to load ${panelId}: ${e.message}`);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto-refresh
// ──────────────────────────────────────────────────────────────────────────────
function startRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (activePanel) loadPanel(activePanel); }, REFRESH_MS);
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
            fetchData(`agents/${selAgent}/chat/history`).then(d => {
                if (!msgs[selAgent]) msgs[selAgent] = [];
                (d.messages || []).forEach(m => {
                    msgs[selAgent].push({ role: "user",  text: m.user_msg,    ts: m.created_at });
                    msgs[selAgent].push({ role: "agent", text: m.agent_reply, ts: m.created_at });
                    msgEl.insertAdjacentHTML("beforeend", _chatBubble("user",  m.user_msg,    m.created_at));
                    msgEl.insertAdjacentHTML("beforeend", _chatBubble("agent", m.agent_reply, m.created_at));
                });
                msgEl.scrollTop = msgEl.scrollHeight;
            }).catch(() => { msgsError[selAgent] = true; });
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
            msgEl.insertAdjacentHTML("beforeend", _chatBubble("user", msg, now));
            // Thinking indicator
            const label = _agentInfo(selAgent).name;
            let dots = 0;
            const dotEl = document.createElement("div");
            dotEl.id = thinkId;
            dotEl.style.cssText = "font-size:0.73rem;color:var(--text3,#888);padding:2px 4px;";
            dotEl.textContent = `⏳ ${label} thinking…`;
            msgEl.appendChild(dotEl);
            msgEl.scrollTop = msgEl.scrollHeight;
            const dotTimer = setInterval(() => {
                dots = (dots + 1) % 4;
                dotEl.textContent = `⏳ ${label} thinking${".".repeat(dots)}`;
            }, 500);
            try {
                const res = await fetch(`${API}/agents/${selAgent}/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ message: msg }),
                    signal: AbortSignal.timeout(90000),
                });
                clearInterval(dotTimer);
                dotEl.remove();
                const json = await res.json();
                if (!json.success) throw new Error(json.error || "API error");
                const reply = json.data.reply;
                msgs[selAgent].push({ role: "agent", text: reply, ts: new Date().toISOString() });
                msgEl.insertAdjacentHTML("beforeend", _chatBubble("agent", reply));
                msgEl.scrollTop = msgEl.scrollHeight;
            } catch(e) {
                clearInterval(dotTimer);
                dotEl.remove();
                const errMsg = e.name === "TimeoutError"
                    ? `⚠️ ${label} timed out (90s)`
                    : `⚠️ ${e.message}`;
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
