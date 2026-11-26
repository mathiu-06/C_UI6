import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STATE_DEBOUNCE_MS = 220;
const VIEWPORT_MIN_INTERVAL_MS = 120;
const POLL_INTERVAL_MS = 900;
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_WIDGET_STRING_LEN = 4000;

function getTabId() {
    const key = "Comfy.liveViewTabId";
    try {
        let id = sessionStorage.getItem(key);
        if (!id) {
            id = (typeof crypto !== "undefined" && crypto.randomUUID)
                ? crypto.randomUUID()
                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
            sessionStorage.setItem(key, id);
        }
        return id;
    } catch {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
}

function getUserId() {
    try {
        if (api && typeof api.user === "string" && api.user.trim()) {
            return api.user.trim();
        }
    } catch {
        // Ignore if api.user is unavailable during early startup.
    }
    try {
        const stored = localStorage.getItem("Comfy.userId");
        if (stored && stored.trim()) {
            return stored.trim();
        }
    } catch {
        // Ignore storage errors in restricted contexts.
    }
    return "";
}

function getClientId() {
    try {
        return api.clientId || api.initialClientId || sessionStorage.getItem("Comfy.clientId") || "";
    } catch {
        return "";
    }
}

function getWorkflowName() {
    try {
        const active =
            app.extensionManager?.workflow?.activeWorkflow ||
            app.workflowManager?.activeWorkflow;
        const candidate = active?.filename || active?.name || active?.path || active?.key;
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim().replace(/^workflows\//, "");
        }
    } catch {
        // Fallback to document title below.
    }

    const title = (document.title || "").trim();
    if (title && title !== "ComfyUI") {
        const cleaned = title.replace(/\s*[-–|]\s*ComfyUI$/i, "").replace(/^\*\s*/, "").trim();
        if (cleaned) return cleaned;
    }
    return "Unsaved Workflow";
}

function getViewport() {
    try {
        const ds = app.canvas?.ds;
        if (ds && typeof ds.scale === "number" && ds.offset && ds.offset.length >= 2) {
            return {
                scale: Math.round(ds.scale * 1000) / 1000,
                offset: [
                    Math.round(ds.offset[0] * 10) / 10,
                    Math.round(ds.offset[1] * 10) / 10,
                ],
            };
        }
    } catch {
        // Ignore missing canvas state.
    }
    return null;
}

function safeWidgetValue(value) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "number" || t === "boolean") return value;
    if (t === "string") {
        return value.length > MAX_WIDGET_STRING_LEN
            ? value.slice(0, MAX_WIDGET_STRING_LEN) + "..."
            : value;
    }
    if (t === "object") {
        try {
            const s = JSON.stringify(value);
            if (!s) return "";
            return s.length > 500 ? s.slice(0, 500) + "..." : s;
        } catch {
            return String(value).slice(0, 200);
        }
    }
    return String(value).slice(0, 200);
}

function extractNodeMeta(graph) {
    const meta = {};
    const nodes = graph?._nodes;
    if (!Array.isArray(nodes)) return meta;

    for (const node of nodes) {
        if (!node || node.id === undefined || node.id === null) continue;
        const entry = {};
        if (typeof node.title === "string" && node.title) {
            entry.title = node.title;
        }
        if (Array.isArray(node.widgets) && node.widgets.length > 0) {
            const widgets = [];
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                if (w.type === "button" || w.type === "converted-widget" || w.hidden) continue;
                const item = {
                    name: String(w.name),
                    value: safeWidgetValue(w.value),
                };
                if (typeof w.label === "string" && w.label && w.label !== w.name) {
                    item.label = w.label;
                }
                if (typeof w.type === "string" && w.type) {
                    item.type = w.type;
                }
                widgets.push(item);
            }
            if (widgets.length > 0) {
                entry.widgets = widgets;
            }
        }
        if (Array.isArray(node.imgs) && node.imgs.length > 0) {
            const imgs = [];
            for (const img of node.imgs) {
                const src = img?.currentSrc || img?.src;
                if (typeof src !== "string") continue;
                try {
                    const u = new URL(src, window.location.origin);
                    if (u.pathname === "/view" || u.pathname === "/api/view") {
                        imgs.push(u.pathname + u.search);
                    }
                } catch {
                    // Skip invalid URLs.
                }
                if (imgs.length >= 6) break;
            }
            if (imgs.length > 0) {
                entry.imgs = imgs;
            }
        }
        meta[String(node.id)] = entry;
    }
    return meta;
}

function getReportWsUrl() {
    const httpUrl = new URL("../../live-view/report", import.meta.url);
    httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    return httpUrl.toString();
}

app.registerExtension({
    name: "Comfy.LiveViewReporter",
    async setup() {
        const tabId = getTabId();
        const wsUrl = getReportWsUrl();

        let ws = null;
        let reconnectDelay = 1000;
        let reconnectTimer = null;
        let debounceTimer = null;
        let lastSentFingerprint = "";
        let lastViewportKey = "";
        let lastViewportSentAt = 0;
        let hookedGraph = null;

        function buildStatePayload() {
            const graph = app.graph;
            if (!graph || typeof graph.serialize !== "function") return null;
            let workflow;
            try {
                workflow = graph.serialize();
            } catch {
                return null;
            }
            if (!workflow || typeof workflow !== "object") return null;

            return {
                type: "state",
                user_id: getUserId(),
                client_id: getClientId(),
                tab_id: tabId,
                workflow_name: getWorkflowName(),
                workflow,
                node_meta: extractNodeMeta(graph),
                viewport: getViewport(),
            };
        }

        function sendState(force = false) {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const payload = buildStatePayload();
            if (!payload) return;

            let fingerprint;
            try {
                fingerprint = JSON.stringify({
                    user_id: payload.user_id,
                    client_id: payload.client_id,
                    workflow_name: payload.workflow_name,
                    workflow: payload.workflow,
                    node_meta: payload.node_meta,
                });
            } catch {
                return;
            }
            if (!force && fingerprint === lastSentFingerprint) {
                sendViewportIfChanged();
                return;
            }
            let serialized;
            try {
                serialized = JSON.stringify(payload);
            } catch {
                return;
            }
            lastSentFingerprint = fingerprint;
            const vp = payload.viewport;
            if (vp) {
                lastViewportKey = `${vp.scale}:${vp.offset[0]}:${vp.offset[1]}`;
                lastViewportSentAt = Date.now();
            }
            try {
                ws.send(serialized);
            } catch {
                // Socket errors handled by onclose reconnect.
            }
        }

        function sendViewportIfChanged() {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const now = Date.now();
            if (now - lastViewportSentAt < VIEWPORT_MIN_INTERVAL_MS) return;
            const vp = getViewport();
            if (!vp) return;
            const key = `${vp.scale}:${vp.offset[0]}:${vp.offset[1]}`;
            if (key === lastViewportKey) return;
            lastViewportKey = key;
            lastViewportSentAt = now;
            try {
                ws.send(JSON.stringify({ type: "viewport", viewport: vp }));
            } catch {
                // Ignore send errors.
            }
        }

        function scheduleSend() {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                sendState(false);
            }, STATE_DEBOUNCE_MS);
        }

        function hookGraphInstance() {
            const graph = app.graph;
            if (!graph || graph === hookedGraph) return;
            hookedGraph = graph;

            for (const hookName of ["onAfterChange", "onNodeAdded", "onNodeRemoved", "onConnectionChange"]) {
                const orig = graph[hookName];
                graph[hookName] = function (...args) {
                    const res = typeof orig === "function" ? orig.apply(this, args) : undefined;
                    scheduleSend();
                    return res;
                };
            }
        }

        function hookLoadGraphData() {
            if (typeof app.loadGraphData !== "function") return;
            const origLoad = app.loadGraphData.bind(app);
            app.loadGraphData = async function (...args) {
                const res = await origLoad(...args);
                hookGraphInstance();
                scheduleSend();
                return res;
            };
        }

        function connect() {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                return;
            }
            try {
                ws = new WebSocket(wsUrl);
            } catch {
                scheduleReconnect();
                return;
            }

            ws.addEventListener("open", () => {
                reconnectDelay = 1000;
                lastSentFingerprint = "";
                hookGraphInstance();
                sendState(true);
            });

            ws.addEventListener("close", () => {
                ws = null;
                scheduleReconnect();
            });

            ws.addEventListener("error", () => {
                try {
                    ws?.close();
                } catch {
                    // Ignore close errors.
                }
            });
        }

        function scheduleReconnect() {
            if (reconnectTimer) return;
            const delay = document.hidden ? Math.max(reconnectDelay, 5000) : reconnectDelay;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
                connect();
            }, delay);
        }

        hookGraphInstance();
        hookLoadGraphData();
        connect();

        // Catch canvas drags, prompt typing, widget edits, and zoom/pan smoothly.
        window.addEventListener("pointerup", scheduleSend, true);
        window.addEventListener("keyup", scheduleSend, true);
        window.addEventListener("change", scheduleSend, true);
        window.addEventListener("input", scheduleSend, true);
        window.addEventListener("wheel", () => {
            setTimeout(sendViewportIfChanged, 60);
        }, { passive: true, capture: true });

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    reconnectDelay = 1000;
                    connect();
                } else {
                    sendState(false);
                }
            }
        });

        window.addEventListener("pagehide", () => {
            try {
                ws?.close(1000, "pagehide");
            } catch {
                // Ignore errors during unload.
            }
        });

        // Periodic diff check catches Vue-rendered widget edits, workflow tab switches, and user switches.
        setInterval(() => {
            hookGraphInstance();
            sendState(false);
        }, POLL_INTERVAL_MS);

        setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send('{"type":"ping"}');
                } catch {
                    // Ignore heartbeat errors.
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
    },
});
