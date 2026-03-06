/* ============================================================
   Nouga Mission Control — Dashboard JS
============================================================ */

const API = "http://100.77.150.110:5000/api";
const REFRESH_MS = 30000;
let activePanel = "tasks";
let refreshTimer = null;
let lastUpdate = null;

// ──────────────────────────────────────────────────────────────────────────────
// API fetch with error handling
// ──────────────────────────────────────────────────────────────────────────────
async function fetchData(endpoint) {
    const res = await fetch(`${API}/${endpoint}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function loading() {
    return `<div class="loading"><div class="spinner"></div> Loading...</div>`;
}

function errorBox(msg) {
    return `<div class="error-box">⚠️ ${msg}</div>`;
}

function badge(text, color) {
    return `<span class="badge badge-${color}">${text}</span>`;
}

function statusBadge(s) {
    if (!s) return badge("unknown", "gray");
    s = String(s).toLowerCase();
    if (["green","live","ok","active","online","running","complete","approved","installed"].includes(s))
        return badge(s, "green");
    if (["yellow","warning","pending","waiting","blocked","partial","ready"].includes(s))
        return badge(s, "yellow");
    if (["red","error","offline","critical","urgent","failed"].includes(s))
        return badge(s, "red");
    if (["blue","in_progress","in progress","busy"].includes(s))
        return badge(s, "blue");
    return badge(s, "gray");
}

function progressBar(pct, color = "blue") {
    const cls = pct >= 80 ? "green" : pct >= 40 ? "blue" : "yellow";
    return `
        <div style="display:flex;align-items:center;gap:10px">
            <div class="progress-wrap" style="flex:1">
                <div class="progress-bar ${cls}" style="width:${pct}%"></div>
            </div>
            <span style="font-size:0.75rem;color:var(--text2);min-width:30px">${pct}%</span>
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Panel renderers
// ──────────────────────────────────────────────────────────────────────────────

function renderTasks(d) {
    const col = (title, items, color) => `
        <div class="kanban-col">
            <div class="kanban-header">
                <span>${title}</span>
                <span class="kanban-count">${items.length}</span>
            </div>
            <div class="kanban-body">
                ${items.map(t => `
                    <div class="task-card">
                        <div class="task-title">${t.title}</div>
                        <div class="task-meta">
                            <span class="tag">${t.tag || ""}</span>
                            <span class="task-assignee">👤 ${t.assignee}</span>
                            ${badge(t.priority, t.priority === "high" ? "red" : t.priority === "medium" ? "yellow" : "gray")}
                        </div>
                    </div>`).join("")}
            </div>
        </div>`;

    return `
        <div class="panel-header">
            <div class="panel-title">📋 Tasks</div>
            <div class="panel-subtitle">Kanban board — all active work</div>
        </div>
        <div class="kanban">
            ${col("To Do", d.todo, "gray")}
            ${col("In Progress", d.in_progress, "blue")}
            ${col("Done", d.done, "green")}
        </div>
        ${d.cron_jobs?.length ? `
        <div style="margin-top:20px">
            <div class="card">
                <div class="card-title">Cron Jobs</div>
                <div class="terminal">
                    ${d.cron_jobs.map(j => `<div class="t-line"><span class="t-success">$</span><span>${j}</span></div>`).join("")}
                </div>
            </div>
        </div>` : ""}`;
}

function renderAgents(d) {
    const statusColor = s => s === "active" ? "green" : s === "busy" ? "blue" : "gray";
    return `
        <div class="panel-header">
            <div class="panel-title">🤖 Agents</div>
            <div class="panel-subtitle">OpenClaw: ${d.openclaw_running ? badge("online","green") : badge("offline","red")} · Max concurrent: ${d.max_concurrent}</div>
        </div>
        <div class="grid-3">
            ${d.agents.map(a => `
                <div class="agent-card">
                    <div style="display:flex;align-items:center;gap:12px">
                        <div class="agent-avatar">${a.emoji}</div>
                        <div>
                            <div class="agent-name">${a.name}</div>
                            <div class="agent-role">${a.role}</div>
                            <div class="agent-model">${a.model}</div>
                        </div>
                    </div>
                    ${badge(a.status, statusColor(a.status))}
                </div>`).join("")}
        </div>
        <div style="margin-top:20px">
            <div class="card">
                <div class="card-title">Workflow Agents</div>
                <table class="table">
                    <thead><tr><th>Workflow</th><th>Steps</th><th>Count</th><th>Status</th></tr></thead>
                    <tbody>
                        ${Object.entries(d.workflow_counts).map(([k,v]) => `
                            <tr><td>${k}</td><td>${v}</td><td>${v} agents</td><td>${badge("ready","green")}</td></tr>`).join("")}
                    </tbody>
                </table>
            </div>
        </div>`;
}

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
                ${badge(d.instagram.status_label, "yellow")}
                <div style="margin-top:12px;font-size:0.82rem;color:var(--text2)">
                    Submitted: ${d.instagram.submitted}<br>
                    ETA: ${d.instagram.eta}
                </div>
            </div>
            <div class="card">
                <div class="card-title">🌐 Website</div>
                <div style="font-size:0.9rem;font-weight:600;color:#fff;margin-bottom:8px">${d.website.url}</div>
                ${statusBadge(d.website.status)}
                <div style="margin-top:12px;font-size:0.82rem;color:var(--text2)">
                    Last deploy: ${d.website.last_deploy}
                </div>
            </div>
        </div>
        <div style="margin-top:16px">
            <div class="card">
                <div class="card-title">📦 Recent Commits — ${d.github.repo}</div>
                ${d.github.recent_commits.slice(0,6).map(c => `
                    <div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.82rem">
                        <code style="color:var(--blue2);flex-shrink:0">${c.hash}</code>
                        <span style="color:var(--text)">${c.message}</span>
                    </div>`).join("")}
            </div>
        </div>
        <div style="margin-top:16px">
            <div class="card">
                <div class="card-title">🎬 Qwen Content Pipeline</div>
                <div style="display:flex;align-items:center;justify-content:space-between">
                    <div>
                        <div style="font-size:0.9rem;font-weight:600;color:#fff">99.8% cost reduction</div>
                        <div style="font-size:0.8rem;color:var(--text2);margin-top:4px">${d.qwen_pipeline.location}</div>
                    </div>
                    ${statusBadge(d.qwen_pipeline.status)}
                </div>
            </div>
        </div>`;
}

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
                        <div style="font-weight:600;color:#fff;font-size:0.9rem">${a.title}</div>
                        ${badge(a.priority, a.priority === "high" ? "red" : "yellow")}
                    </div>
                    <div style="font-size:0.82rem;color:var(--text2);margin-bottom:8px">${a.description}</div>
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
                    <span style="font-size:0.85rem;color:var(--text)">${a.title}</span>
                    <div style="display:flex;gap:8px;align-items:center;font-size:0.75rem;color:var(--text3)">
                        ${a.approved_on}
                        ${badge("approved","green")}
                    </div>
                </div>`).join("")}
        </div>`;
}

function renderCouncil(d) {
    const statusColor = s => s === "completed" ? "green" : s === "in_progress" ? "blue" : "gray";
    return `
        <div class="panel-header">
            <div class="panel-title">🏛️ LLM Council</div>
            <div class="panel-subtitle">Members: ${d.council_members.join(", ")}</div>
        </div>
        ${d.decisions.map(dec => `
            <div class="card" style="margin-bottom:14px">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
                    <div style="font-weight:700;color:#fff;font-size:0.95rem">${dec.topic}</div>
                    ${statusBadge(dec.status)}
                </div>
                <div style="margin-bottom:10px">
                    <span style="font-size:0.78rem;font-weight:700;color:var(--blue2);text-transform:uppercase;letter-spacing:0.05em">${dec.outcome}</span>
                </div>
                <div style="font-size:0.85rem;color:var(--text2);line-height:1.6">${dec.summary}</div>
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                    ${dec.models.map(m => `<span class="tag">${m}</span>`).join("")}
                    <span style="font-size:0.75rem;color:var(--text3);margin-left:auto">${dec.date}</span>
                </div>
            </div>`).join("")}`;
}

function renderCalendar(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">📅 Calendar</div>
            <div class="panel-subtitle">${d.cron_jobs.length} scheduled jobs</div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-title">⚙️ Cron Jobs</div>
                ${d.cron_jobs.map(j => `
                    <div class="service-row">
                        <div class="service-left">
                            <span style="font-size:1.2rem">${j.emoji}</span>
                            <div>
                                <div class="service-name">${j.name}</div>
                                <div class="service-port">${j.schedule_label}</div>
                            </div>
                        </div>
                        <div style="text-align:right">
                            ${badge("active","green")}
                            <div style="font-size:0.72rem;color:var(--text3);margin-top:3px">${j.category}</div>
                        </div>
                    </div>`).join("")}
            </div>
            <div class="card">
                <div class="card-title">📌 Upcoming</div>
                ${d.upcoming.map(e => `
                    <div class="service-row">
                        <div class="service-left">
                            <span style="font-size:1.1rem">${e.emoji}</span>
                            <div>
                                <div class="service-name">${e.event}</div>
                                <div class="service-port">${e.time}</div>
                            </div>
                        </div>
                        <span class="tag">${e.type}</span>
                    </div>`).join("")}
            </div>
        </div>`;
}

function renderProjects(d) {
    const statusColor = s => s === "green" ? "green" : s === "yellow" ? "yellow" : "red";
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
                            <div style="font-weight:700;color:#fff;font-size:0.95rem">${p.name}</div>
                            <div style="font-size:0.78rem;color:var(--text2);margin-top:2px">${p.phase}</div>
                        </div>
                    </div>
                    ${badge(p.label, statusColor(p.status))}
                </div>
                ${progressBar(p.progress)}
                <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:0.78rem;color:var(--text3)">
                    <span>${p.details}</span>
                    <span>👤 ${p.owner}</span>
                </div>
            </div>`).join("")}`;
}

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
                    <div style="font-size:0.8rem;color:var(--text2);line-height:1.6;white-space:pre-wrap">${e.preview.slice(0,200)}${e.preview.length > 200 ? "…" : ""}</div>
                </div>`).join("")}
        </div>`;
}

function renderDocs(d) {
    const catColor = c => c === "security" ? "red" : "blue";
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
                            <td style="font-weight:600">📄 ${doc.name}</td>
                            <td>${badge(doc.category, catColor(doc.category))}</td>
                            <td style="color:var(--text2);font-size:0.8rem">${doc.modified}</td>
                            <td style="color:var(--text3);font-size:0.78rem">${doc.size} chars</td>
                        </tr>`).join("")}
                </tbody>
            </table>
        </div>`;
}

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

function renderOffice(d) {
    const statusColor = s => s === "busy" ? "blue" : s === "active" ? "green" : "gray";
    return `
        <div class="panel-header">
            <div class="panel-title">🏢 Virtual Office</div>
            <div class="panel-subtitle">Live activity feed</div>
        </div>
        <div class="office-grid">
            ${d.desks.map(desk => `
                <div class="desk-card">
                    <div class="desk-emoji">${desk.emoji}</div>
                    <div>
                        <div class="desk-name">${desk.agent}</div>
                        <div class="desk-task">${desk.activity}</div>
                        <div style="margin-top:5px">${badge(desk.status, statusColor(desk.status))}</div>
                    </div>
                </div>`).join("")}
        </div>
        <div class="card">
            <div class="card-title">Activity Feed</div>
            <div class="activity-feed">
                ${d.activity_feed.map(f => `
                    <div class="feed-item">
                        <span class="feed-time">${f.time}</span>
                        <span class="feed-agent">${f.agent}</span>
                        <span class="feed-action">${f.action}</span>
                    </div>`).join("")}
            </div>
        </div>`;
}

function renderTeam(d) {
    const renderNode = (node, indent = 0) => {
        if (!node) return "";
        const reports = (node.reports || []).map(r => renderNode(r, indent + 1)).join("");
        return `
            <div style="margin-left:${indent * 24}px;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:4px">
                    <span style="font-weight:700;color:#fff;font-size:0.88rem">${node.name || node.ceo?.name || ""}</span>
                    <span style="font-size:0.75rem;color:var(--text2)">${node.title || node.ceo?.title || ""}</span>
                </div>
                ${reports}
            </div>`;
    };

    return `
        <div class="panel-header">
            <div class="panel-title">🏗️ Team</div>
            <div class="panel-subtitle">Headcount: ${d.headcount} · Org structure</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Mission</div>
            <div style="font-size:0.92rem;color:var(--text);line-height:1.7;font-style:italic">"${d.mission}"</div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-title">Org Chart</div>
                ${renderNode({ name: d.org_chart.ceo.name, title: d.org_chart.ceo.title, reports: d.org_chart.reports })}
            </div>
            <div class="card">
                <div class="card-title">2026 Goals</div>
                <ul class="checklist">
                    ${d.goals.map(g => `
                        <li class="check-item">
                            <span class="check-icon">🎯</span>
                            <span style="font-size:0.85rem">${g}</span>
                        </li>`).join("")}
                </ul>
            </div>
        </div>`;
}

function renderSystem(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">⚙️ System</div>
            <div class="panel-subtitle">Services, uptime, resources</div>
        </div>
        <div class="grid-4" style="margin-bottom:16px">
            <div class="stat-card">
                <div class="stat-label">Tailscale IP</div>
                <div style="font-size:0.95rem;font-weight:700;color:var(--blue2);font-family:monospace;margin-top:4px">${d.tailscale_ip}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Hostname</div>
                <div style="font-size:0.88rem;font-weight:600;color:#fff;margin-top:4px">${d.hostname}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Disk Used</div>
                <div style="font-size:1rem;font-weight:700;color:#fff;margin-top:4px">${d.disk.used || "—"} / ${d.disk.total || "—"}</div>
                <div class="stat-sub">${d.disk.percent || ""} used</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Uptime</div>
                <div style="font-size:0.78rem;color:var(--text2);margin-top:4px">${(d.uptime || "").slice(0,60)}</div>
            </div>
        </div>
        <div class="card">
            <div class="card-title">Services</div>
            ${d.services.map(s => `
                <div class="service-row">
                    <div class="service-left">
                        <span style="font-size:1.1rem">${s.emoji}</span>
                        <div>
                            <div class="service-name">${s.name}</div>
                            <div class="service-port">port ${s.port}</div>
                        </div>
                    </div>
                    ${badge(s.status, s.up ? "green" : "red")}
                </div>`).join("")}
        </div>`;
}

function renderRadar(d) {
    const scoreColor = s => s >= 8 ? "var(--green)" : s >= 5 ? "var(--yellow)" : "var(--red)";
    return `
        <div class="panel-header">
            <div class="panel-title">🛡️ Radar</div>
            <div class="panel-subtitle">Threat monitoring · Last scan: ${d.last_scan}</div>
        </div>
        <div class="grid-2" style="margin-bottom:16px">
            <div class="card" style="text-align:center">
                <div class="card-title">Security Score</div>
                <div style="font-size:4rem;font-weight:900;color:${scoreColor(d.score)};line-height:1;margin:12px 0">${d.score}</div>
                <div style="font-size:0.8rem;color:var(--text2)">out of ${d.score_max}</div>
                <div style="margin-top:8px">${badge("monitor " + d.monitor_status, "green")}</div>
            </div>
            <div class="card">
                <div class="card-title">✅ Implemented (${d.implemented.length})</div>
                <ul class="checklist">
                    ${d.implemented.map(i => `
                        <li class="check-item"><span class="check-icon">✅</span><span style="font-size:0.82rem">${i}</span></li>`).join("")}
                </ul>
            </div>
        </div>
        <div class="grid-2">
            <div class="card">
                <div class="card-title">⏳ Pending Actions (${d.pending.length})</div>
                <ul class="checklist">
                    ${d.pending.map(i => `
                        <li class="check-item"><span class="check-icon">⚠️</span><span style="font-size:0.82rem">${i}</span></li>`).join("")}
                </ul>
            </div>
            <div class="card">
                <div class="card-title">Recent Alerts</div>
                ${d.alerts.length ? d.alerts.slice(-8).map(a => `
                    <div class="alert-row">
                        <span class="alert-time">${a.timestamp}</span>
                        <span class="alert-level">${badge(a.level, a.level === "CRITICAL" ? "red" : a.level === "WARNING" ? "yellow" : "blue")}</span>
                        <span class="alert-msg">${a.message}</span>
                    </div>`).join("") : `<div style="font-size:0.85rem;color:var(--text3);padding:12px 0">No alerts recorded.</div>`}
            </div>
        </div>`;
}

function renderFactory(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🏭 Factory</div>
            <div class="panel-subtitle">Automation workflows · ${d.total_agents} agent configs</div>
        </div>
        <div class="grid-2" style="margin-bottom:16px">
            <div class="card">
                <div class="card-title">Workflows</div>
                ${d.workflows.map(w => `
                    <div class="service-row">
                        <div class="service-left">
                            <span style="font-size:1.1rem">${w.emoji}</span>
                            <div>
                                <div class="service-name">${w.name}</div>
                                <div class="service-port">${w.steps} steps · last: ${w.last_run}</div>
                            </div>
                        </div>
                        ${statusBadge(w.status)}
                    </div>`).join("")}
            </div>
            <div class="card">
                <div class="card-title">Installed Skills</div>
                ${d.skills.map(s => `
                    <div class="service-row">
                        <div class="service-left">
                            <div>
                                <div class="service-name">${s.name}</div>
                                <div class="service-port">${s.category}</div>
                            </div>
                        </div>
                        ${badge(s.status,"green")}
                    </div>`).join("")}
            </div>
        </div>
        <div class="card">
            <div class="card-title">Antfarm</div>
            <div style="display:flex;gap:16px;align-items:center">
                <div style="font-size:0.88rem;color:var(--text2)">Database: <code style="color:var(--blue2)">${d.antfarm_db_size} bytes</code></div>
                ${badge(d.antfarm_status, d.antfarm_status === "active" ? "green" : "gray")}
            </div>
        </div>`;
}

function renderPipeline(d) {
    return `
        <div class="panel-header">
            <div class="panel-title">🚀 Pipeline</div>
            <div class="panel-subtitle">${d.repo} → ${d.site_url}</div>
        </div>
        <div class="card" style="margin-bottom:16px">
            <div class="card-title">Deployment Pipeline</div>
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
                    <span style="font-size:0.85rem;color:var(--text)">${c.message}</span>
                </div>`).join("")}
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Panel map
// ──────────────────────────────────────────────────────────────────────────────
const PANELS = {
    tasks:     { fn: renderTasks,     endpoint: "tasks"     },
    agents:    { fn: renderAgents,    endpoint: "agents"    },
    content:   { fn: renderContent,   endpoint: "content"   },
    approvals: { fn: renderApprovals, endpoint: "approvals" },
    council:   { fn: renderCouncil,   endpoint: "council"   },
    calendar:  { fn: renderCalendar,  endpoint: "calendar"  },
    projects:  { fn: renderProjects,  endpoint: "projects"  },
    memory:    { fn: renderMemory,    endpoint: "memory"    },
    docs:      { fn: renderDocs,      endpoint: "docs"      },
    people:    { fn: renderPeople,    endpoint: "people"    },
    office:    { fn: renderOffice,    endpoint: "office"    },
    team:      { fn: renderTeam,      endpoint: "team"      },
    system:    { fn: renderSystem,    endpoint: "system"    },
    radar:     { fn: renderRadar,     endpoint: "radar"     },
    factory:   { fn: renderFactory,   endpoint: "factory"   },
    pipeline:  { fn: renderPipeline,  endpoint: "pipeline"  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Navigation
// ──────────────────────────────────────────────────────────────────────────────
function navigate(panelId) {
    activePanel = panelId;

    // Update nav
    document.querySelectorAll(".nav-item").forEach(el => {
        el.classList.toggle("active", el.dataset.panel === panelId);
    });

    // Show panel
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
        lastUpdate = new Date();
        updateStatusBar();
    } catch (e) {
        el.innerHTML = errorBox(`Failed to load ${panelId}: ${e.message}`);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto-refresh
// ──────────────────────────────────────────────────────────────────────────────
function startRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (activePanel) loadPanel(activePanel);
    }, REFRESH_MS);
}

// ──────────────────────────────────────────────────────────────────────────────
// Status bar
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
    const dot = $("api-status-dot");
    const label = $("api-status-label");
    try {
        const d = await fetchData("health");
        if (dot) dot.style.background = "var(--green)";
        if (label) label.textContent = "API online";
    } catch {
        if (dot) dot.style.background = "var(--red)";
        if (label) label.textContent = "API offline";
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    // Wire up nav
    document.querySelectorAll(".nav-item").forEach(el => {
        el.addEventListener("click", () => navigate(el.dataset.panel));
    });

    // Start
    navigate("tasks");
    startRefresh();
    checkHealth();
    setInterval(updateClock, 1000);
    setInterval(updateStatusBar, 5000);
    setInterval(checkHealth, 60000);
    updateClock();
});
