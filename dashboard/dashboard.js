/* ============================================================
   Nouga Mission Control — Dashboard JS  (Phase 2)
============================================================ */

const API    = "http://100.77.150.110:5001/api";
const WS_URL = "http://100.77.150.110:5001";
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
        return;
    }
    socket = io(WS_URL, {
        transports: ["websocket", "polling"],
        reconnectionDelay: 2000,
        reconnectionAttempts: 10,
    });

    socket.on("connect", () => {
        wsConnected = true;
        _wsStatus(true);
        socket.emit("subscribe", {
            agent: "milfred",
            types: ["task", "agent", "cron", "system", "council"],
        });
        console.log("[WS] Connected to Nouga Mission Control");
    });

    socket.on("disconnect", () => {
        wsConnected = false;
        _wsStatus(false);
        console.warn("[WS] Disconnected");
    });

    socket.on("subscribed", data => {
        _addNotif({ type: "system", payload: { message: `Milfred subscribed — watching: ${data.types.join(", ")}` }, timestamp: new Date().toISOString() });
        console.log("[WS] Subscribed:", data);
    });

    socket.on("notification", notif => {
        _addNotif(notif);
        _showToast(notif);
        _bumpBadge();
        // Reload the active panel if it matches the event type
        const reload = { task: "tasks", agent: "agents", cron: "calendar", council: "council" };
        if (reload[notif.type] && activePanel === reload[notif.type]) loadPanel(activePanel);
    });
}

function _wsStatus(online) {
    const dot   = document.getElementById("ws-dot");
    const label = document.getElementById("ws-label");
    if (dot)   dot.className = online ? "dot-green" : "dot-red";
    if (label) label.textContent = online ? "Milfred online" : "WS offline";
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

function renderTasks(d) {
    _tasksData = d;
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
                <span class="kanban-count" id="count-parking_lot">…</span>
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
        <div class="kanban kanban-4col">
            ${plCol}
            ${col("todo",        "📥 To Do",      d.todo)}
            ${col("in_progress", "🔄 In Progress", d.in_progress)}
            ${col("done",        "✅ Done",        d.done)}
        </div>
        ${d.cron_jobs?.length ? `
        <div style="margin-top:20px"><div class="card">
            <div class="card-title">Cron Jobs</div>
            <div class="terminal">${d.cron_jobs.map(j=>`<div class="t-line"><span class="t-success">$</span><span>${escHtml(j)}</span></div>`).join("")}</div>
        </div></div>` : ""}`;
}

function plCard(item) {
    const stars = item.priority || "";
    const statusClass = item.status === "completed" ? "pl-card-done" : item.status === "active" ? "pl-card-active" : "";
    return `
        <div class="pl-card ${statusClass}" data-pl-id="${item.id}" data-pl-number="${item.number}">
            <div class="pl-card-num">#${item.number}</div>
            <div class="pl-card-title">${escHtml(item.title)}</div>
            ${stars ? `<div class="pl-card-stars">${stars}</div>` : ""}
            ${item.value ? `<div class="pl-card-value">💰 ${escHtml(item.value)}</div>` : ""}
            ${item.effort ? `<div class="pl-card-effort">⏱ ${escHtml(item.effort)}</div>` : ""}
            <div class="pl-card-actions">
                <button class="btn btn-ghost pl-btn-detail" data-pl-id="${item.id}" style="font-size:0.7rem;padding:3px 8px">Details</button>
                ${item.status === "parking_lot" ? `<button class="btn btn-primary pl-btn-activate" data-pl-id="${item.id}" style="font-size:0.7rem;padding:3px 8px">Activate →</button>` : ""}
            </div>
        </div>`;
}

function showPLModal(item, container) {
    const modal = createModal({
        title: `#${item.number}: ${item.title} ${item.priority || ""}`,
        body: `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
                <div><div class="form-label">Category</div><div style="color:var(--text2);font-size:0.85rem">${escHtml(item.category||"—")}</div></div>
                <div><div class="form-label">Status</div><div style="color:var(--text2);font-size:0.85rem">${escHtml(item.status)}</div></div>
                ${item.value  ? `<div><div class="form-label">Value</div><div style="color:var(--green);font-weight:600;font-size:0.9rem">${escHtml(item.value)}</div></div>` : ""}
                ${item.effort ? `<div><div class="form-label">Effort</div><div style="color:var(--yellow);font-size:0.85rem">${escHtml(item.effort)}</div></div>` : ""}
            </div>
            ${item.description ? `<div class="form-label">Description</div><div style="color:var(--text2);font-size:0.85rem;line-height:1.5;margin-top:6px">${escHtml(item.description)}</div>` : ""}`,
        footer: `
            <button class="btn btn-ghost" id="pl-m-cancel">Close</button>
            ${item.status === "parking_lot" ? `<button class="btn btn-primary" id="pl-m-activate">🚀 Activate Project</button>` : ""}
            ${item.status === "active" ? `<button class="btn btn-success" id="pl-m-complete">✅ Mark Complete</button>` : ""}`,
    });

    modal.querySelector("#pl-m-cancel").onclick = () => modal.remove();

    const activateBtn = modal.querySelector("#pl-m-activate");
    if (activateBtn) {
        activateBtn.onclick = async () => {
            activateBtn.disabled = true; activateBtn.textContent = "Activating…";
            try {
                await apiPost(`parking-lot/${item.id}/activate`, {});
                modal.remove();
                loadPanel("tasks");
            } catch(e) { activateBtn.disabled = false; activateBtn.textContent = "Activate"; alert(e.message); }
        };
    }

    const completeBtn = modal.querySelector("#pl-m-complete");
    if (completeBtn) {
        completeBtn.onclick = async () => {
            completeBtn.disabled = true; completeBtn.textContent = "Saving…";
            try {
                await apiPost(`parking-lot/${item.id}/complete`, {});
                modal.remove();
                loadPanel("tasks");
            } catch(e) { completeBtn.disabled = false; completeBtn.textContent = "Mark Complete"; alert(e.message); }
        };
    }
}

function taskCard(t) {
    const pClass = `priority-${(t.priority||"normal").toLowerCase()}`;
    return `
        <div class="task-card ${pClass}" data-id="${t.id}" data-status="${t.status}">
            <div class="task-card-actions">
                <button class="task-action-btn task-edit-btn" data-id="${t.id}" title="Edit">✎</button>
                <button class="task-action-btn task-delete-btn" data-id="${t.id}" title="Delete">✕</button>
            </div>
            <div class="task-title">${escHtml(t.title)}</div>
            <div class="task-meta">
                <span class="tag">${escHtml(t.tag || "")}</span>
                <span class="task-assignee">👤 ${escHtml(t.assignee || "")}</span>
                ${badge(t.priority || "normal", t.priority === "high" ? "red" : t.priority === "medium" ? "yellow" : "gray")}
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
    // Load parking lot async
    (async () => {
        try {
            const r = await fetch(`${API_BASE}/parking-lot`);
            const j = await r.json();
            _parkingLotData = j.data?.items || [];
            const plList = container.querySelector("#list-parking_lot");
            const plCount = container.querySelector("#count-parking_lot");
            if (plList) {
                plList.innerHTML = _parkingLotData.length
                    ? _parkingLotData.map(plCard).join("")
                    : `<div class="pl-loading" style="color:var(--text3)">No items</div>`;
            }
            if (plCount) plCount.textContent = _parkingLotData.length;

            // Wire parking lot buttons
            plList?.querySelectorAll(".pl-btn-detail").forEach(btn => {
                btn.addEventListener("click", e => {
                    e.stopPropagation();
                    const item = _parkingLotData.find(i => String(i.id) === btn.dataset.plId);
                    if (item) showPLModal(item, container);
                });
            });
            plList?.querySelectorAll(".pl-btn-activate").forEach(btn => {
                btn.addEventListener("click", async e => {
                    e.stopPropagation();
                    const item = _parkingLotData.find(i => String(i.id) === btn.dataset.plId);
                    if (!item) return;
                    btn.disabled = true; btn.textContent = "…";
                    try {
                        await apiPost(`parking-lot/${item.id}/activate`, {});
                        loadPanel("tasks");
                    } catch(err2) { btn.disabled = false; btn.textContent = "Activate →"; }
                });
            });

            // Card click → detail modal
            plList?.querySelectorAll(".pl-card").forEach(card => {
                card.addEventListener("click", e => {
                    if (e.target.closest(".pl-btn-detail, .pl-btn-activate")) return;
                    const item = _parkingLotData.find(i => String(i.id) === card.dataset.plId);
                    if (item) showPLModal(item, container);
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
                    const newStatus = evt.to.dataset.status;
                    if (evt.from === evt.to) return;
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
                <input class="form-input" id="m-assignee" value="${escHtml(task.assignee||"")}" placeholder="e.g. Claude, Milfred"></div>
            <div class="form-field"><label class="form-label">Tag</label>
                <input class="form-input" id="m-tag" value="${escHtml(task.tag||"")}" placeholder="e.g. security, dev, trading"></div>
            <input type="hidden" id="m-status" value="${escHtml(s)}">`,
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
        const r = await fetch(`${API_BASE}/models`);
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
    // Build dropdown from cached /api/models; fall back to short-id list while loading
    const modelOptions = (_availableModels && _availableModels.length)
        ? _availableModels.map(m => ({
            value: m.short_id,
            label: `${m.type === "local" ? "⚡ " : "☁️ "}${m.name}`,
          }))
        : ["kimi-k2.5","kimi-k2-thinking","claude-sonnet-4-6","claude-haiku-4-5-20251001"].map(v => ({ value: v, label: v }));
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
            <button class="agent-tab-btn" data-tab="soul">Soul</button>
            <button class="agent-tab-btn" data-tab="tools">Tools</button>
            <button class="agent-tab-btn" data-tab="memory">Memory</button>
        </div>

        <div class="agent-tab-pane active" data-pane="role">
            <div class="agent-detail-label" style="margin-bottom:6px">Identity & Responsibilities</div>
            <div style="font-size:0.8rem;color:var(--text2);background:var(--bg2);border-radius:7px;padding:10px;line-height:1.6;font-family:monospace;max-height:200px;overflow-y:auto">${escHtml(agent.soul_excerpt||"(No IDENTITY.md found)")}</div>
            <div style="display:flex;gap:8px;margin-top:10px">
                <input class="form-input" id="chat-input-${agent.id}" placeholder="Quick message to ${agent.name}…" style="font-size:0.82rem">
                <button class="btn btn-ghost" id="chat-send-${agent.id}" style="padding:0 12px">→</button>
            </div>
            <div id="chat-reply-${agent.id}" style="margin-top:6px;font-size:0.78rem;color:var(--text3)"></div>
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
    // Pre-load models so dropdown is populated when user clicks an agent
    loadAvailableModels();

    container.querySelectorAll(".org-node-btn[data-agent-id]").forEach(btn => {
        btn.addEventListener("click", () => {
            const agentId = btn.dataset.agentId;
            _selectedAgent = (_selectedAgent === agentId) ? null : agentId;
            const detailEl = container.querySelector("#agent-detail");
            if (detailEl) {
                const agent = data.agents?.find(a => a.id === agentId);
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

    // Quick chat
    const chatSend = panel.querySelector(`#chat-send-${agentId}`);
    if (chatSend) {
        chatSend.onclick = () => {
            const inp = panel.querySelector(`#chat-input-${agentId}`);
            const rep = panel.querySelector(`#chat-reply-${agentId}`);
            if (!inp || !rep || !inp.value.trim()) return;
            rep.textContent = "⚡ OpenClaw not connected — message queued.";
            inp.value = "";
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
            <canvas id="office-canvas" class="office-canvas" width="640" height="420"></canvas>
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

    const CW = 640, CH = 420;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // ── Layout constants ─────────────────────────────────────────
    const DW = 92, DSH = 28, DFH = 10, MH = 34, AH = 26;
    const HY_UP  = 75 + MH + DSH + DFH + 6;   // 153 — upper desk agent home y
    const HY_LOW = 232 + MH + DSH + DFH + 6;  // 310 — lower desk agent home y

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
        coffee:  { x: 545, y: 165, w: 54, h: 72 },
        meeting: { x: 14,  y: 226, w: 160, h: 152 },
    };

    const SCREEN_COLORS = {
        milfred:"#00ff88", ernst:"#ff4444", gordon:"#ffaa00",
        lara:"#ff44cc", claude:"#00ccff", eva:"#cc88ff", alex:"#4488ff",
    };

    const AGENT_EMOJI  = { alex:"👔", eva:"📅", milfred:"🤖", ernst:"🔒", gordon:"📈", lara:"📱", claude:"🧠" };
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
        { id:"milfred", name:"Milfred", role:"Tech Lead",     shirtC:"#16a34a", hairC:"#222",    skinC:"#c68642", hx:ZONES.upperDesks[0].x+38, hy:HY_UP  },
        { id:"ernst",   name:"Ernst",   role:"Security",      shirtC:"#dc2626", hairC:"#111",    skinC:"#f1c27d", hx:ZONES.upperDesks[1].x+38, hy:HY_UP  },
        { id:"gordon",  name:"Gordon",  role:"Trading",       shirtC:"#d97706", hairC:"#4a3728", skinC:"#c68642", hx:ZONES.upperDesks[2].x+38, hy:HY_UP  },
        { id:"lara",    name:"Lara",    role:"Growth",        shirtC:"#db2777", hairC:"#fde047", skinC:"#f1c27d", hx:ZONES.upperDesks[3].x+38, hy:HY_UP  },
        { id:"claude",  name:"Claude",  role:"AI Architect",  shirtC:"#0891b2", hairC:"#555",    skinC:"#c68642", hx:ZONES.lowerDesks[0].x+38, hy:HY_LOW },
        { id:"eva",     name:"Eva",     role:"Exec. Asst.",   shirtC:"#7c3aed", hairC:"#8B4513", skinC:"#f1c27d", hx:ZONES.lowerDesks[1].x+38, hy:HY_LOW },
        { id:"alex",    name:"Alex",    role:"CEO",           shirtC:"#1d4ed8", hairC:"#111",    skinC:"#c68642", hx:ZONES.lowerDesks[2].x+38, hy:HY_LOW },
    ];
    const agents = DEFS.map(d => ({
        ...d, x: d.hx, y: d.hy, tx: d.hx, ty: d.hy,
        state: "typing", frame: Math.floor(Math.random() * 120),
        timer: Math.random() * 3000 + 1500, moving: false, _ns: "typing",
    }));

    // ── Particles ─────────────────────────────────────────────────
    const particles = [];
    let steamTick = 0;
    function spawnSteam() {
        for (let i = 0; i < 2; i++) particles.push({
            x: ZONES.coffee.x + 18 + (Math.random() - 0.5) * 8,
            y: ZONES.coffee.y - 2,
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
    }

    // ── Drawing helpers ───────────────────────────────────────────
    function px(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

    function drawFloor() {
        for (let col = 0; col < CW; col += 40) {
            px(col, 58, 40, CH - 58, (col / 40) % 2 === 0 ? "#1a1828" : "#1c1a2c");
        }
        ctx.strokeStyle = "rgba(255,255,255,0.022)"; ctx.lineWidth = 1;
        for (let gx = 0; gx < CW; gx += 40) {
            ctx.beginPath(); ctx.moveTo(gx, 58); ctx.lineTo(gx, CH); ctx.stroke();
        }
        for (let gy = 58; gy < CH; gy += 40) {
            ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(CW, gy); ctx.stroke();
        }
    }

    function drawWall() {
        px(0, 0, CW, 58, "#13100e");
        px(0, 54, CW, 4, "#2a2016");
        const h = new Date().getHours(), day = h >= 6 && h < 19;
        [50, 192, 334, 476].forEach(wx => {
            px(wx, 3, 88, 46, day ? "#0e2a4a" : "#07091a");
            if (day) {
                px(wx + 2, 5, 84, 18, "#122d55");
                px(wx + 36, 7, 12, 12, "#ffd700");
                px(wx + 34, 9, 16, 8, "rgba(255,215,0,0.35)");
            } else {
                [[8,8],[25,14],[55,7],[70,18],[40,25],[15,30],[60,30]].forEach(([sx,sy]) =>
                    px(wx+sx, 3+sy, 2, 2, "rgba(255,255,255,0.75)"));
            }
            ctx.strokeStyle = "#2a2016"; ctx.lineWidth = 3; ctx.strokeRect(wx, 3, 88, 46);
            ctx.strokeStyle = "#1c1610"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(wx+44,3); ctx.lineTo(wx+44,49); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(wx,26);   ctx.lineTo(wx+88,26); ctx.stroke();
        });
    }

    function drawDesk(x, y, agentId) {
        const gc = SCREEN_COLORS[agentId] || "#00d4ff";
        // Shadow
        ctx.fillStyle = "rgba(0,0,0,0.26)";
        ctx.fillRect(x - 1, y + MH + DSH + DFH, DW + 2, 6);
        // Monitor stand
        px(x+34, y+MH-4, 10, 6, "#252525");
        // Monitor casing
        px(x+10, y, DW-20, MH-2, "#111");
        px(x+12, y+2, DW-24, MH-6, "#0a0a1a");
        // Screen content — animated data bars
        const bt = Math.floor(Date.now() / 350);
        for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
            if ((bt + row + col) % 3 !== 0) px(x+14+col*11, y+5+row*7, 8, 4, gc + "bb");
        }
        // Monitor glow
        ctx.fillStyle = gc + "16"; ctx.fillRect(x+8, y+MH-7, DW-16, 10);
        ctx.strokeStyle = "#333"; ctx.lineWidth = 2; ctx.strokeRect(x+10, y, DW-20, MH-2);
        // Desk surface
        px(x, y+MH, DW, DSH, "#4a3728");
        px(x+2, y+MH+2, DW-4, DSH-4, "#523e2d");
        // Keyboard
        px(x+18, y+MH+6, 38, 10, "#1c1c1c");
        px(x+20, y+MH+8, 34, 6, "#292929");
        // Mouse
        px(x+62, y+MH+7, 10, 9, "#1a1a1a");
        px(x+63, y+MH+8, 8, 7, "#222");
        // Front face + legs
        px(x, y+MH+DSH, DW, DFH, "#3a2a1c");
        px(x+4, y+MH+DSH, 6, DFH+2, "#2a1e12");
        px(x+DW-10, y+MH+DSH, 6, DFH+2, "#2a1e12");
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
        px(x, y, 160, 152, "#1e1830");
        ctx.strokeStyle = "#7c3aed"; ctx.lineWidth = 2;
        ctx.setLineDash([5,4]); ctx.strokeRect(x+1,y+1,158,150); ctx.setLineDash([]);
        ctx.fillStyle = "#a78bfa"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
        ctx.fillText("MEETING ROOM", x+80, y+14);
        // Table
        px(x+18, y+22, 124, 72, "#5c4a35");
        px(x+20, y+24, 120, 68, "#4a3828");
        // Items on table
        px(x+50, y+32, 30, 20, "#1a1a2e"); px(x+52, y+34, 26, 16, "#00aaff2a"); // laptop
        px(x+88, y+34, 20, 14, "#e8e4d8"); px(x+90, y+36, 16, 10, "#d0cac0");   // papers
        // Chairs top/bottom
        [20, 52, 84, 116].forEach(cx => {
            px(x+cx, y+17, 18, 8, "#3a2d20");  px(x+cx+2, y+19, 14, 5, "#4a3a28");
            px(x+cx, y+96, 18, 8, "#3a2d20");  px(x+cx+2, y+97, 14, 5, "#4a3a28");
        });
        ctx.fillStyle = "#10b981"; ctx.font = "7px monospace"; ctx.textAlign = "center";
        ctx.fillText("● available", x+80, y+120);
    }

    function drawAgent(a) {
        const ax = Math.round(a.x), ay = Math.round(a.y);
        const wf = Math.floor(a.frame / 6) % 4;
        const lL = a.moving ? (wf===1 ?  3 : wf===3 ? -3 : 0) : 0;
        const lR = a.moving ? (wf===1 ? -3 : wf===3 ?  3 : 0) : 0;

        // Shadow
        ctx.fillStyle = "rgba(0,0,0,0.2)";
        ctx.beginPath(); ctx.ellipse(ax+8, ay+AH+3, 9, 3, 0, 0, Math.PI*2); ctx.fill();

        // Legs / shoes
        px(ax+2,  ay+16+lL, 5, 9, "#1a1a1a"); px(ax+1,  ay+23+lL, 7, 3, "#333");
        px(ax+9,  ay+16+lR, 5, 9, "#1a1a1a"); px(ax+9,  ay+23+lR, 7, 3, "#333");

        // Body + shirt detail
        px(ax+1, ay+9, 14, 9, a.shirtC);
        px(ax+3, ay+11, 4, 3, a.shirtC + "88");

        // Arms (animated when typing)
        const ta = a.state === "typing" ? (Math.floor(a.frame/5) % 2) * 2 : 0;
        px(ax-2, ay+10+ta, 4, 7, a.shirtC);
        px(ax+14, ay+10+ta, 4, 7, a.shirtC);

        // Head + hair
        px(ax+2, ay, 12, 11, a.skinC);
        px(ax+2, ay, 12, 3, a.hairC);
        px(ax+1, ay+1, 2, 5, a.hairC);
        px(ax+13, ay+1, 2, 5, a.hairC);

        // Eyes
        px(ax+4, ay+4, 2, 2, "#111"); px(ax+10, ay+4, 2, 2, "#111");

        // Mouth: happy if coffee/idle, neutral if working
        if (a.state === "coffee" || a.state === "idle") {
            px(ax+5,ay+7,6,1,"#111"); px(ax+5,ay+8,2,1,"#111"); px(ax+9,ay+8,2,1,"#111");
        } else {
            px(ax+5, ay+7, 6, 1, "#555");
        }

        // Name tag
        ctx.font = "bold 7px monospace"; ctx.textAlign = "center";
        const tw = ctx.measureText(a.name).width;
        px(ax+8-Math.round(tw/2)-2, ay-14, Math.round(tw)+4, 11, "rgba(0,0,0,0.65)");
        ctx.fillStyle = "#fff"; ctx.fillText(a.name, ax+8, ay-5);

        // Status dot
        const dc = {typing:"#16a34a", walking:"#3b82f6", idle:"#d97706", coffee:"#f59e0b"};
        ctx.fillStyle = dc[a.state] || "#666";
        ctx.beginPath(); ctx.arc(ax+15, ay+1, 3, 0, Math.PI*2); ctx.fill();
    }

    function drawNightOverlay() {
        const h = new Date().getHours();
        if (h >= 6 && h < 18) return;
        ctx.fillStyle = "rgba(5,3,20,0.36)"; ctx.fillRect(0, 58, CW, CH-58);
        [...ZONES.upperDesks, ...ZONES.lowerDesks].forEach(d => {
            const g = ctx.createRadialGradient(d.x+46, d.y+70, 0, d.x+46, d.y+70, 72);
            g.addColorStop(0, "rgba(255,200,80,0.13)"); g.addColorStop(1, "rgba(255,200,80,0)");
            ctx.fillStyle = g; ctx.fillRect(d.x-12, d.y+15, DW+24, 100);
        });
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
        agents.forEach(a => {
            a.frame++;
            a.timer -= dt;
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
                if (r < 0.12) {
                    // Go to coffee
                    a.tx = ZONES.coffee.x + 4 + Math.random()*16;
                    a.ty = ZONES.coffee.y + ZONES.coffee.h + 3;
                    a.moving = true; a.state = "walking"; a._ns = "coffee";
                    a.timer = Math.random()*4000 + 2000;
                    addAct(a.name, ["Getting coffee ☕","Coffee break ☕","At coffee machine"][Math.floor(Math.random()*3)]);
                } else if (r < 0.24) {
                    // Return home
                    a.tx = a.hx; a.ty = a.hy;
                    a.moving = true; a.state = "walking"; a._ns = "typing";
                    a.timer = Math.random()*8000 + 5000;
                    const acts = AGENT_ACTS[a.id] || ["Working"];
                    addAct(a.name, acts[Math.floor(Math.random()*acts.length)]);
                } else if (r < 0.32) {
                    // Small wander
                    a.tx = Math.max(22, Math.min(CW-30, a.hx + (Math.random()-0.5)*44));
                    a.ty = Math.max(65, Math.min(CH-38, a.hy + (Math.random()-0.5)*28));
                    a.moving = true; a.state = "walking"; a._ns = "idle";
                    a.timer = Math.random()*3000 + 1500;
                } else {
                    a.state = r < 0.8 ? "typing" : "idle";
                    a.timer = Math.random()*5000 + 3000;
                }
            }
        });
    }

    // ── Render ────────────────────────────────────────────────────
    function render() {
        ctx.clearRect(0, 0, CW, CH);
        px(0, 0, CW, CH, "#13100e");
        drawFloor();
        drawWall();
        drawMeetingRoom(ZONES.meeting.x, ZONES.meeting.y);
        ZONES.upperDesks.forEach(d => drawDesk(d.x, d.y, d.agent));
        ZONES.lowerDesks.forEach(d => drawDesk(d.x, d.y, d.agent));
        drawCoffeeMachine(ZONES.coffee.x, ZONES.coffee.y);
        // Steam
        particles.forEach(p => {
            ctx.fillStyle = `rgba(210,190,175,${(p.life*0.5).toFixed(2)})`;
            ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.r), Math.round(p.r));
        });
        drawNightOverlay();
        [...agents].sort((a,b) => a.y-b.y).forEach(drawAgent);
        // Scanlines
        ctx.fillStyle = "rgba(0,0,0,0.05)";
        for (let sy = 0; sy < CH; sy += 4) ctx.fillRect(0, sy, CW, 1);
        // Border
        ctx.strokeStyle = "rgba(255,255,255,0.04)"; ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, CW-1, CH-1);
    }

    // ── Hit detection ─────────────────────────────────────────────
    function hitTest(mx, my) {
        const a = agents.find(a => mx >= a.x-2 && mx <= a.x+20 && my >= a.y-2 && my <= a.y+AH+5);
        if (a) return { type:"agent", a };
        const c = ZONES.coffee;
        if (mx >= c.x && mx <= c.x+c.w && my >= c.y && my <= c.y+c.h) return { type:"coffee" };
        const m = ZONES.meeting;
        if (mx >= m.x && mx <= m.x+m.w && my >= m.y && my <= m.y+m.h) return { type:"meeting" };
        const allDesks = [...ZONES.upperDesks, ...ZONES.lowerDesks];
        const d = allDesks.find(d => mx >= d.x && mx <= d.x+DW && my >= d.y && my <= d.y+MH+DSH+DFH);
        if (d) return { type:"desk", d };
        return null;
    }

    canvas.addEventListener("click", e => {
        const r = canvas.getBoundingClientRect();
        const mx = (e.clientX-r.left)*(CW/r.width), my = (e.clientY-r.top)*(CH/r.height);
        const hit = hitTest(mx, my);
        if (!hit) return;
        if (hit.type === "agent") showAgentInfo(hit.a);
        else if (hit.type === "desk") { const a = agents.find(ag => ag.id === hit.d.agent); if (a) showAgentInfo(a); }
        else if (hit.type === "coffee") showCoffeeChat();
        else if (hit.type === "meeting") showMeetingModal();
    });

    canvas.addEventListener("mousemove", e => {
        const r = canvas.getBoundingClientRect();
        const mx = (e.clientX-r.left)*(CW/r.width), my = (e.clientY-r.top)*(CH/r.height);
        canvas.style.cursor = hitTest(mx, my) ? "pointer" : "default";
    });

    // ── Info panel ────────────────────────────────────────────────
    function setInfo(html) {
        const b = document.getElementById("office-agent-info"); if (b) b.innerHTML = html;
    }

    function showAgentInfo(a) {
        const sl = {typing:"🟢 Typing",walking:"🔵 Walking",idle:"🟡 Idle",coffee:"☕ Coffee"};
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
            <div style="font-size:0.78rem;color:var(--text2);margin-bottom:4px">${sl[a.state]||a.state}</div>
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
            <div class="panel-title">🏗️ Team</div>
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
document.addEventListener("DOMContentLoaded", () => {
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
    setInterval(updateClock,      1000);
    setInterval(updateStatusBar,  5000);
    setInterval(checkHealth,     60000);
    updateClock();
});
