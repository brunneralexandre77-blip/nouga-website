/* ============================================================
   Nouga Mission Control — Dashboard JS  (Phase 2)
============================================================ */

const API = "http://100.77.150.110:5001/api";
const REFRESH_MS = 30000;
let activePanel = "tasks";
let refreshTimer = null;
let lastUpdate   = null;

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

function renderTasks(d) {
    _tasksData = d;
    const col = (id, title, items, colorClass) => `
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
    return `
        <div class="panel-header">
            <div class="panel-title">📋 Tasks</div>
            <div class="panel-subtitle">Drag cards between columns · click to edit</div>
        </div>
        <div class="kanban">
            ${col("todo",        "📥 To Do",      d.todo,        "gray")}
            ${col("in_progress", "🔄 In Progress", d.in_progress, "blue")}
            ${col("done",        "✅ Done",        d.done,        "green")}
        </div>
        ${d.cron_jobs?.length ? `
        <div style="margin-top:20px"><div class="card">
            <div class="card-title">Cron Jobs</div>
            <div class="terminal">${d.cron_jobs.map(j=>`<div class="t-line"><span class="t-success">$</span><span>${escHtml(j)}</span></div>`).join("")}</div>
        </div></div>` : ""}`;
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
    ["todo","in_progress","done"].forEach(s => {
        const list = container.querySelector(`#list-${s}`);
        const countEl = container.querySelector(`#count-${s}`);
        if (list && countEl) countEl.textContent = list.children.length;
    });
}

function initTasksPanel(data, container) {
    // SortableJS drag-and-drop
    if (typeof Sortable !== "undefined") {
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
                    const newStatus = evt.to.dataset.status;
                    if (evt.from === evt.to) return;
                    const fromEl = evt.from;
                    try {
                        await apiPut(`tasks/${taskId}`, { status: newStatus });
                        evt.item.dataset.status = newStatus;
                        updateKanbanCounts(container);
                    } catch(e) {
                        // Revert
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

function renderAgents(d) {
    const agentMap = {};
    (d.agents || []).forEach(a => { agentMap[a.id] = a; });

    const orgNode = (a, isRoot) => `
        <div class="org-node${isRoot ? "" : " org-child"}">
            <button class="org-node-btn${_selectedAgent === a.id ? " active" : ""}" data-agent-id="${a.id}">
                <span class="org-emoji">${a.emoji}</span>
                <span class="org-name">${a.name}</span>
                <span class="org-title">${a.role.split(" ").slice(0,3).join(" ")}</span>
            </button>
        </div>`;

    const alexNode = `
        <div class="org-node">
            <button class="org-node-btn" data-agent-id="alex" style="border-color:var(--yellow);min-width:110px">
                <span class="org-emoji">👔</span>
                <span class="org-name">Alex</span>
                <span class="org-title">CEO</span>
            </button>
        </div>`;

    const milfred = d.agents?.find(a => a.id === "milfred");
    const ernst   = d.agents?.find(a => a.id === "ernst");
    const reports = (d.agents || []).filter(a => ["gordon","lara","claude"].includes(a.id));

    const detailHTML = _selectedAgent
        ? renderAgentDetail(d.agents?.find(a => a.id === _selectedAgent), d)
        : `<div style="padding:24px;text-align:center;color:var(--text3);font-size:0.85rem">
               Click an agent node to view details
           </div>`;

    return `
        <div class="panel-header">
            <div class="panel-title">🤖 Agents</div>
            <div class="panel-subtitle">
                OpenClaw: ${d.openclaw_running ? badge("online","green") : badge("offline","red")}
                · Max concurrent: ${d.max_concurrent}
            </div>
        </div>
        <div class="agents-layout">
            <div>
                <div class="card" style="margin-bottom:16px">
                    <div class="card-title">Org Chart</div>
                    <div class="org-chart">
                        <div class="org-level">${alexNode}</div>
                        <div class="org-line-v"></div>
                        <div class="org-children" id="org-l2" style="gap:24px">
                            ${milfred ? orgNode(milfred, false) : ""}
                            ${ernst   ? orgNode(ernst, false) : ""}
                        </div>
                        <div style="display:flex;justify-content:flex-start;padding-left:0;gap:24px;margin-top:0" id="org-l3-wrap">
                            <div style="display:flex;flex-direction:column;align-items:center">
                                <div class="org-line-v"></div>
                                <div class="org-children" style="gap:10px">
                                    ${reports.map(a => orgNode(a, false)).join("")}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-title">Workflow Agents</div>
                    <table class="table">
                        <thead><tr><th>Category</th><th>Count</th><th>Status</th></tr></thead>
                        <tbody>
                            ${Object.entries(d.workflow_counts || {}).map(([k,v]) => `
                                <tr><td>${k}</td><td>${v}</td><td>${badge("ready","green")}</td></tr>`).join("")}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="agent-detail-panel" id="agent-detail">
                ${detailHTML}
            </div>
        </div>`;
}

function renderAgentDetail(agent, d) {
    if (!agent) return `<div style="padding:20px;color:var(--text3);font-size:0.85rem">Agent not found</div>`;
    const models = ["kimi-k2.5","kimi-k2-thinking","claude-sonnet-4-6","claude-haiku-4-5-20251001","gemini-2.5-pro"];
    return `
        <div class="agent-detail-header">
            <div class="agent-avatar" style="width:48px;height:48px;font-size:1.5rem">${agent.emoji}</div>
            <div>
                <div style="font-weight:700;font-size:1rem;color:#fff">${agent.name}</div>
                <div style="font-size:0.8rem;color:var(--blue2)">${agent.role}</div>
                ${badge(agent.status || "idle", agent.status === "active" ? "green" : agent.status === "busy" ? "blue" : "gray")}
            </div>
        </div>
        <div class="agent-detail-section">
            <div class="agent-detail-label">LLM Model</div>
            <select class="form-select" id="model-select-${agent.id}">
                ${models.map(m => `<option value="${m}"${agent.model===m?" selected":""}>${m}</option>`).join("")}
            </select>
            <button class="btn btn-primary" id="model-save-${agent.id}" style="margin-top:8px;width:100%">
                Save Model
            </button>
        </div>
        <div class="agent-detail-section">
            <div class="agent-detail-label">Role / Soul</div>
            <div style="font-size:0.8rem;color:var(--text2);background:var(--bg2);border-radius:7px;padding:10px;line-height:1.6;font-family:monospace;max-height:120px;overflow-y:auto">
                ${escHtml(agent.soul_excerpt || "(No SOUL.md found)")}
            </div>
        </div>
        <div class="agent-detail-section">
            <div class="agent-detail-label">Quick Chat</div>
            <div style="display:flex;gap:8px">
                <input class="form-input" id="chat-input-${agent.id}" placeholder="Message ${agent.name}…">
                <button class="btn btn-ghost" id="chat-send-${agent.id}">→</button>
            </div>
            <div id="chat-reply-${agent.id}" style="margin-top:8px;font-size:0.8rem;color:var(--text3)"></div>
        </div>`;
}

function initAgentsPanel(data, container) {
    // Org node clicks
    container.querySelectorAll(".org-node-btn[data-agent-id]").forEach(btn => {
        btn.addEventListener("click", () => {
            const agentId = btn.dataset.agentId;
            _selectedAgent = (_selectedAgent === agentId) ? null : agentId;
            // Re-render just the detail panel
            const detailEl = container.querySelector("#agent-detail");
            if (detailEl) {
                const agent = data.agents?.find(a => a.id === agentId);
                detailEl.innerHTML = _selectedAgent
                    ? renderAgentDetail(agent, data)
                    : `<div style="padding:24px;text-align:center;color:var(--text3);font-size:0.85rem">Click an agent node to view details</div>`;
                if (_selectedAgent) wireAgentDetail(agentId, container);
            }
            container.querySelectorAll(".org-node-btn").forEach(b => b.classList.toggle("active", b.dataset.agentId === _selectedAgent));
        });
    });
    if (_selectedAgent) wireAgentDetail(_selectedAgent, container);
}

function wireAgentDetail(agentId, container) {
    const saveBtn = container.querySelector(`#model-save-${agentId}`);
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const sel = container.querySelector(`#model-select-${agentId}`);
            if (!sel) return;
            saveBtn.disabled = true; saveBtn.textContent = "Saving…";
            try {
                await apiPut(`agents/${agentId}/model`, { model: sel.value });
                saveBtn.textContent = "✓ Saved";
                setTimeout(() => { saveBtn.textContent = "Save Model"; saveBtn.disabled = false; }, 2000);
            } catch(e) {
                saveBtn.textContent = "Error"; saveBtn.disabled = false;
            }
        };
    }
    const chatSend = container.querySelector(`#chat-send-${agentId}`);
    if (chatSend) {
        chatSend.onclick = () => {
            const inp = container.querySelector(`#chat-input-${agentId}`);
            const rep = container.querySelector(`#chat-reply-${agentId}`);
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
// Office — 2D Visual Layout
// ──────────────────────────────────────────────────────────────────────────────
function renderOffice(d) {
    const deskMap = {};
    (d.desks || []).forEach(dk => { deskMap[dk.agent.toLowerCase()] = dk; });

    const deskEl = (agentKey, gridArea) => {
        const dk = deskMap[agentKey];
        if (!dk) return "";
        const status = dk.status || "idle";
        return `
            <div class="desk-2d ${status} ${gridArea ? `desk-${agentKey}` : ""}" data-agent="${agentKey}">
                <div class="desk-2d-emoji">${dk.emoji}</div>
                <div class="desk-2d-name">${dk.agent}</div>
                <div class="desk-2d-role">${dk.desk}</div>
                ${badge(status, status==="busy"?"blue":status==="active"?"green":"gray")}
                <div class="desk-tooltip">${escHtml(dk.activity)}</div>
            </div>`;
    };

    // Night mode
    const hour = new Date().getHours();
    if (hour >= 18 || hour < 6) document.body.classList.add("night");
    else document.body.classList.remove("night");

    return `
        <div class="panel-header">
            <div class="panel-title">🏢 Virtual Office</div>
            <div class="panel-subtitle">Live agent status · hover for current task${(hour >= 18 || hour < 6) ? " · 🌙 Night mode" : ""}</div>
        </div>
        <div class="office2d" style="margin-bottom:16px">
            ${deskEl("milfred", true)}
            ${deskEl("ernst", true)}
            <div class="meeting-room">
                <span style="font-size:1.5rem">🗓️</span>
                <div style="font-size:0.75rem;font-weight:700;color:var(--text2)">Meeting Room</div>
                <div style="font-size:0.65rem;color:var(--text3)">Available</div>
            </div>
            ${deskEl("gordon", true)}
            ${deskEl("lara", true)}
            <div class="coffee-area" id="coffee-machine">
                <span style="font-size:1.5rem">☕</span>
                <div style="font-size:0.75rem;font-weight:700;color:var(--yellow)">Coffee</div>
                <div style="font-size:0.63rem;color:var(--text3)">Click for chat</div>
            </div>
            <div class="desk-2d active desk-ceo" data-agent="alex">
                <div class="desk-2d-emoji">👔</div>
                <div class="desk-2d-name">Alex</div>
                <div class="desk-2d-role">CEO</div>
                ${badge("active","green")}
                <div class="desk-tooltip">Strategic oversight</div>
            </div>
            ${deskEl("claude", true)}
        </div>
        <div class="card">
            <div class="card-title" id="feed-title">Activity Feed</div>
            <div class="activity-feed" id="activity-feed">
                ${(d.activity_feed || []).map(f => `
                    <div class="feed-item">
                        <span class="feed-time">${f.time}</span>
                        <span class="feed-agent">${f.agent}</span>
                        <span class="feed-action">${escHtml(f.action)}</span>
                    </div>`).join("")}
            </div>
        </div>`;
}

function initOfficePanel(data, container) {
    container.querySelector("#coffee-machine")?.addEventListener("click", () => {
        const feed  = container.querySelector("#activity-feed");
        const title = container.querySelector("#feed-title");
        if (!feed) return;
        title.textContent = "☕ Water Cooler Chat";
        const lines = [
            { time: "now",  agent: "Gordon",  action: "BTC looking bullish this morning ☕" },
            { time: "1m",   agent: "Lara",    action: "Still waiting on FB verification 😤" },
            { time: "3m",   agent: "Ernst",   action: "Security scan clean — all good 🛡️" },
            { time: "5m",   agent: "Claude",  action: "Dashboard Phase 2 looking sharp 🚀" },
            { time: "8m",   agent: "Milfred", action: "Team sync at 14:00 — don't forget" },
        ];
        feed.innerHTML = lines.map(f => `
            <div class="feed-item">
                <span class="feed-time">${f.time}</span>
                <span class="feed-agent">${f.agent}</span>
                <span class="feed-action">${escHtml(f.action)}</span>
            </div>`).join("");
    });
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
function renderFactory(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🏭 Automation Workshop</div>
            <div class="panel-subtitle">${d.total_agents} agent configs · ${d.workflows?.length || 0} workflows</div>
        </div>
        <div class="grid-2" style="margin-bottom:16px">
            <div class="card">
                <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
                    Workflows
                    <button class="btn btn-primary" id="new-workflow-btn" style="padding:4px 10px;font-size:0.75rem">+ New</button>
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
                            <button class="btn btn-ghost" style="padding:4px 8px;font-size:0.72rem" onclick="event.stopPropagation()">▶ Run</button>
                        </div>`).join("")}
                </div>
            </div>
            <div class="card">
                <div class="card-title">Installed Skills</div>
                ${(d.skills || []).map(s => `
                    <div class="service-row">
                        <div class="service-left"><div>
                            <div class="service-name">${escHtml(s.name)}</div>
                            <div class="service-port">${s.category}</div>
                        </div></div>
                        ${badge(s.status,"green")}
                    </div>`).join("")}
            </div>
        </div>
        <div class="card">
            <div class="card-title">Antfarm</div>
            <div style="display:flex;gap:16px;align-items:center">
                <div style="font-size:0.88rem;color:var(--text2)">Database: <code style="color:var(--blue2)">${d.antfarm_db_size} bytes</code></div>
                ${badge(d.antfarm_status, d.antfarm_status==="active"?"green":"gray")}
            </div>
        </div>`;
}

function initFactoryPanel(data, container) {
    // Sortable workflow list
    if (typeof Sortable !== "undefined") {
        const list = container.querySelector("#workflows-list");
        if (list) Sortable.create(list, { animation: 150, ghostClass: "sortable-ghost" });
    }

    // New workflow button
    container.querySelector("#new-workflow-btn")?.addEventListener("click", () => showWorkflowModal());

    // Run buttons
    container.querySelectorAll("#workflows-list .btn").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const item = btn.closest(".step-item");
            const name = item?.dataset.workflow || "workflow";
            btn.textContent = "⏳ Running…";
            btn.disabled = true;
            setTimeout(() => { btn.textContent = "▶ Run"; btn.disabled = false; }, 2500);
        });
    });
}

function showWorkflowModal() {
    const stepTypes = ["Trigger","Action","Condition","Delay"];
    const modal = createModal({
        title: "New Workflow",
        body: `
            <div class="form-field"><label class="form-label">Workflow Name</label>
                <input class="form-input" id="wf-name" placeholder="e.g. daily-sync"></div>
            <div class="form-field"><label class="form-label">Steps</label>
                <div id="wf-steps" class="steps-list">
                    <div style="color:var(--text3);font-size:0.8rem;text-align:center;padding:8px">Drag steps to reorder</div>
                </div>
            </div>
            <div class="form-field"><label class="form-label">Add Step</label>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    ${stepTypes.map(t => `<button class="btn badge chip-${t.toLowerCase()}" data-step-type="${t}" style="cursor:pointer">${t}</button>`).join("")}
                </div>
            </div>`,
        footer: `
            <button class="btn btn-ghost" id="wf-cancel">Cancel</button>
            <button class="btn btn-primary" id="wf-save">Create</button>`,
    });

    const stepsEl = modal.querySelector("#wf-steps");
    if (typeof Sortable !== "undefined") Sortable.create(stepsEl, { animation: 150, ghostClass: "sortable-ghost" });

    let stepCount = 0;
    modal.querySelectorAll("[data-step-type]").forEach(btn => {
        btn.addEventListener("click", () => {
            const type = btn.dataset.stepType;
            const div  = document.createElement("div");
            stepCount++;
            div.className = "step-item";
            div.innerHTML = `
                <span class="step-number">${stepCount}</span>
                <span class="badge chip-${type.toLowerCase()}">${type}</span>
                <input class="form-input" placeholder="${type} description…" style="flex:1">
                <button class="task-action-btn" onclick="this.closest('.step-item').remove()">✕</button>`;
            // Remove placeholder text
            const placeholder = stepsEl.querySelector("div");
            if (placeholder) placeholder.remove();
            stepsEl.appendChild(div);
        });
    });

    modal.querySelector("#wf-cancel").onclick = () => modal.remove();
    modal.querySelector("#wf-save").onclick = () => {
        const name = modal.querySelector("#wf-name").value.trim();
        if (!name) return;
        modal.remove();
        // Refresh panel to show "created" feedback (in real app, POST to API)
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
    navigate("tasks");
    startRefresh();
    checkHealth();
    setInterval(updateClock,      1000);
    setInterval(updateStatusBar,  5000);
    setInterval(checkHealth,     60000);
    updateClock();
});
