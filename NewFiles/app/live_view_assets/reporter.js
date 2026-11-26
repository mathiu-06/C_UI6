import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const REPORTER_VERSION = 4;
const STATE_DEBOUNCE_MS = 220;
const VIEWPORT_MIN_INTERVAL_MS = 100;
const USER_CURSOR_MIN_INTERVAL_MS = 45;
const POLL_INTERVAL_MS = 900;
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_WIDGET_STRING_LEN = 4000;
const EDGE_INDICATOR_PAD = 26;

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

function getComfyCanvas() {
    return app?.canvas || window.app?.canvas || null;
}

function getCanvasElement() {
    const comfyCanvas = getComfyCanvas();
    const direct = comfyCanvas?.canvas || comfyCanvas?.bgcanvas;
    if (direct && direct.isConnected) {
        const r = direct.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return direct;
    }
    const byId = document.querySelector("canvas#graph-canvas");
    if (byId) return byId;
    const inContainer = document.querySelector(".graph-canvas-container canvas");
    if (inContainer) return inContainer;

    // Pick the largest visible canvas so tiny minimap/widget canvases are never chosen.
    let best = null;
    let bestArea = 0;
    for (const c of document.querySelectorAll("canvas")) {
        const r = c.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
            bestArea = area;
            best = c;
        }
    }
    return best;
}

function getViewport() {
    try {
        const ds = getComfyCanvas()?.ds;
        if (ds && typeof ds.scale === "number" && ds.scale > 0 && ds.offset && ds.offset.length >= 2) {
            const vp = {
                scale: Math.round(ds.scale * 1000) / 1000,
                offset: [
                    Math.round(ds.offset[0] * 10) / 10,
                    Math.round(ds.offset[1] * 10) / 10,
                ],
            };
            const canvasEl = getCanvasElement();
            if (canvasEl) {
                const rect = canvasEl.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    vp.width = Math.round(rect.width);
                    vp.height = Math.round(rect.height);
                }
            }
            return vp;
        }
    } catch {
        // Ignore missing canvas state.
    }
    return null;
}

function clientToGraphCoords(clientX, clientY) {
    try {
        const ds = getComfyCanvas()?.ds;
        const canvasEl = getCanvasElement();
        if (!ds || !canvasEl || typeof ds.scale !== "number" || ds.scale <= 0) return null;
        const rect = canvasEl.getBoundingClientRect();
        if (
            clientX < rect.left ||
            clientX > rect.right ||
            clientY < rect.top ||
            clientY > rect.bottom
        ) {
            return null;
        }
        const gx = (clientX - rect.left) / ds.scale - ds.offset[0];
        const gy = (clientY - rect.top) / ds.scale - ds.offset[1];
        if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
        return {
            x: Math.round(gx * 10) / 10,
            y: Math.round(gy * 10) / 10,
        };
    } catch {
        return null;
    }
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
    const proto = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${httpUrl.host}${httpUrl.pathname}${httpUrl.search}`;
}

function ensureObserverOverlayStyles() {
    if (document.getElementById("comfy-live-view-cursor-styles")) return;
    const style = document.createElement("style");
    style.id = "comfy-live-view-cursor-styles";
    style.textContent = `
        #comfy-live-view-cursor-layer {
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: 2147483647;
            overflow: hidden;
        }
        .clv-cursor {
            position: fixed;
            top: 0;
            left: 0;
            pointer-events: none;
            will-change: transform;
            display: none;
        }
        .clv-cursor-svg {
            display: block;
            filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.55));
        }
        .clv-cursor-tag {
            position: absolute;
            top: 19px;
            left: 15px;
            padding: 2px 7px;
            border-radius: 999px;
            background: rgba(15, 23, 42, 0.92);
            border: 1px solid #ff6b2b;
            color: #fff7ed;
            font: 600 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            white-space: nowrap;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
        }
        .clv-offscreen {
            position: fixed;
            top: 0;
            left: 0;
            width: 0;
            height: 0;
            pointer-events: none;
            will-change: transform;
            display: none;
        }
        .clv-beacon-wrap {
            position: absolute;
            top: 0;
            left: 0;
            transform: translate(-50%, -50%);
            width: 34px;
            height: 34px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .clv-beacon-ring {
            position: absolute;
            width: 26px;
            height: 26px;
            border-radius: 50%;
            border: 2px solid #ff6b2b;
            animation: clvBeaconRipple 1.1s ease-out infinite;
        }
        .clv-beacon-led {
            position: relative;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #ff6b2b;
            border: 2px solid #fff7ed;
            box-shadow: 0 0 12px 3px rgba(255, 107, 43, 0.95);
            animation: clvBeaconBlink 0.75s ease-in-out infinite;
        }
        .clv-beacon-arrow {
            position: absolute;
            top: 50%;
            left: 50%;
            width: 34px;
            height: 34px;
            margin-top: -17px;
            margin-left: -17px;
            will-change: transform;
        }
        .clv-beacon-arrow::after {
            content: "";
            position: absolute;
            right: -7px;
            top: 50%;
            transform: translateY(-50%);
            width: 0;
            height: 0;
            border-top: 6px solid transparent;
            border-bottom: 6px solid transparent;
            border-left: 10px solid #ff6b2b;
            filter: drop-shadow(0 0 4px rgba(255, 107, 43, 0.9));
        }
        @keyframes clvBeaconBlink {
            0%, 100% {
                opacity: 1;
                transform: scale(1.12);
                box-shadow: 0 0 14px 4px rgba(255, 107, 43, 0.98);
            }
            50% {
                opacity: 0.25;
                transform: scale(0.82);
                box-shadow: 0 0 3px 1px rgba(255, 107, 43, 0.35);
            }
        }
        @keyframes clvBeaconRipple {
            0% {
                opacity: 0.9;
                transform: scale(0.55);
            }
            100% {
                opacity: 0;
                transform: scale(1.75);
            }
        }
    `;
    document.head.appendChild(style);
}

function createObserverCursorRenderer() {
    ensureObserverOverlayStyles();

    function getLayer() {
        ensureObserverOverlayStyles();
        let layer = document.getElementById("comfy-live-view-cursor-layer");
        if (!layer) {
            layer = document.createElement("div");
            layer.id = "comfy-live-view-cursor-layer";
            layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;";
        }
        if (!layer.isConnected && document.body) {
            document.body.appendChild(layer);
        }
        return layer;
    }

    const cursors = new Map(); // observer_id -> { x, y, cursorEl, offscreenEl, arrowEl }
    let rafId = null;

    function createEntryElements() {
        const layer = getLayer();
        const cursorEl = document.createElement("div");
        cursorEl.className = "clv-cursor";
        cursorEl.innerHTML = `
            <svg class="clv-cursor-svg" width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M3.5 2.5L10.4 20.5L13.1 13.6L20 10.9L3.5 2.5Z" fill="#ff6b2b" stroke="#0f172a" stroke-width="2" stroke-linejoin="round"/>
                <path d="M4.6 4.2L10.3 18.6L12.5 13L18.1 10.8L4.6 4.2Z" fill="none" stroke="#fff7ed" stroke-width="0.9" stroke-linejoin="round"/>
            </svg>
            <span class="clv-cursor-tag">Live View</span>
        `;

        const offscreenEl = document.createElement("div");
        offscreenEl.className = "clv-offscreen";
        const wrap = document.createElement("div");
        wrap.className = "clv-beacon-wrap";
        const ring = document.createElement("div");
        ring.className = "clv-beacon-ring";
        const led = document.createElement("div");
        led.className = "clv-beacon-led";
        const arrowEl = document.createElement("div");
        arrowEl.className = "clv-beacon-arrow";
        wrap.append(ring, arrowEl, led);
        offscreenEl.appendChild(wrap);

        layer.append(cursorEl, offscreenEl);
        return { cursorEl, offscreenEl, arrowEl };
    }

    function renderFrame() {
        rafId = null;
        if (cursors.size === 0) return;

        getLayer();
        const comfyCanvas = getComfyCanvas();
        const canvasEl = getCanvasElement();
        const ds = comfyCanvas?.ds;
        if (!canvasEl || !ds || typeof ds.scale !== "number" || ds.scale <= 0 || !ds.offset) {
            rafId = requestAnimationFrame(renderFrame);
            return;
        }

        const rect = canvasEl.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            rafId = requestAnimationFrame(renderFrame);
            return;
        }

        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const hw = Math.max(12, cx - EDGE_INDICATOR_PAD);
        const hh = Math.max(12, cy - EDGE_INDICATOR_PAD);

        for (const entry of cursors.values()) {
            // Exact LiteGraph world -> canvas CSS pixel transform.
            let sx = (entry.x + ds.offset[0]) * ds.scale;
            let sy = (entry.y + ds.offset[1]) * ds.scale;
            if (typeof ds.convertOffsetToCanvas === "function") {
                try {
                    const converted = ds.convertOffsetToCanvas([entry.x, entry.y]);
                    if (
                        converted &&
                        converted.length >= 2 &&
                        Number.isFinite(converted[0]) &&
                        Number.isFinite(converted[1])
                    ) {
                        sx = converted[0];
                        sy = converted[1];
                    }
                } catch {
                    // Keep formula fallback.
                }
            }
            const isInside = sx >= 0 && sx <= rect.width && sy >= 0 && sy <= rect.height;

            if (isInside) {
                entry.offscreenEl.style.display = "none";
                entry.cursorEl.style.display = "block";
                entry.cursorEl.style.transform = `translate3d(${rect.left + sx}px, ${rect.top + sy}px, 0)`;
            } else {
                entry.cursorEl.style.display = "none";
                entry.offscreenEl.style.display = "block";

                const dx = sx - cx;
                const dy = sy - cy;
                const tx = Math.abs(dx) > 1e-4 ? hw / Math.abs(dx) : Infinity;
                const ty = Math.abs(dy) > 1e-4 ? hh / Math.abs(dy) : Infinity;
                const t = Math.min(tx, ty);
                const edgeX = rect.left + cx + dx * t;
                const edgeY = rect.top + cy + dy * t;
                const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

                entry.offscreenEl.style.transform = `translate3d(${edgeX}px, ${edgeY}px, 0)`;
                entry.arrowEl.style.transform = `rotate(${angleDeg}deg)`;
            }
        }

        rafId = requestAnimationFrame(renderFrame);
    }

    function ensureLoop() {
        if (rafId === null && cursors.size > 0) {
            rafId = requestAnimationFrame(renderFrame);
        }
    }

    function update(data) {
        if (!data || typeof data.observer_id !== "string") return;
        const id = data.observer_id;
        if (!data.visible || typeof data.x !== "number" || typeof data.y !== "number") {
            const existing = cursors.get(id);
            if (existing) {
                existing.cursorEl.remove();
                existing.offscreenEl.remove();
                cursors.delete(id);
            }
            if (cursors.size === 0 && rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            return;
        }

        let entry = cursors.get(id);
        if (!entry) {
            const els = createEntryElements();
            entry = { x: data.x, y: data.y, ...els };
            cursors.set(id, entry);
        } else {
            entry.x = data.x;
            entry.y = data.y;
        }
        ensureLoop();
    }

    function clearAll() {
        for (const entry of cursors.values()) {
            entry.cursorEl.remove();
            entry.offscreenEl.remove();
        }
        cursors.clear();
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    return { update, clearAll };
}

app.registerExtension({
    name: "Comfy.LiveViewReporter",
    async setup() {
        const tabId = getTabId();
        const wsUrl = getReportWsUrl();
        const observerOverlay = createObserverCursorRenderer();

        let ws = null;
        let reconnectDelay = 1000;
        let reconnectTimer = null;
        let debounceTimer = null;
        let lastSentFingerprint = "";
        let lastViewportKey = "";
        let lastViewportSentAt = 0;
        let lastUserCursorSentAt = 0;
        let lastUserCursorVisible = false;
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
                reporter_version: REPORTER_VERSION,
                user_id: getUserId(),
                client_id: getClientId(),
                tab_id: tabId,
                workflow_name: getWorkflowName(),
                workflow,
                node_meta: extractNodeMeta(graph),
                viewport: getViewport(),
            };
        }

        function viewportKey(vp) {
            return `${vp.scale}:${vp.offset[0]}:${vp.offset[1]}:${vp.width || 0}:${vp.height || 0}`;
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
                lastViewportKey = viewportKey(vp);
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
            const key = viewportKey(vp);
            if (key === lastViewportKey) return;
            lastViewportKey = key;
            lastViewportSentAt = now;
            try {
                ws.send(JSON.stringify({ type: "viewport", viewport: vp }));
            } catch {
                // Ignore send errors.
            }
        }

        function sendUserCursor(visible, x = 0, y = 0) {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            if (!visible) {
                if (!lastUserCursorVisible) return;
                lastUserCursorVisible = false;
                try {
                    ws.send('{"type":"user_cursor","visible":false}');
                } catch {
                    // Ignore send errors.
                }
                return;
            }
            const now = Date.now();
            if (now - lastUserCursorSentAt < USER_CURSOR_MIN_INTERVAL_MS) return;
            lastUserCursorSentAt = now;
            lastUserCursorVisible = true;
            try {
                ws.send(JSON.stringify({ type: "user_cursor", visible: true, x, y }));
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

            ws.addEventListener("message", (ev) => {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg && msg.type === "observer_cursor") {
                        observerOverlay.update(msg.data);
                    }
                } catch {
                    // Ignore malformed messages.
                }
            });

            ws.addEventListener("close", () => {
                ws = null;
                lastUserCursorVisible = false;
                observerOverlay.clearAll();
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

        // Track user's live mouse cursor in shared graph coordinates.
        window.addEventListener("pointermove", (e) => {
            const pt = clientToGraphCoords(e.clientX, e.clientY);
            if (pt) {
                sendUserCursor(true, pt.x, pt.y);
            } else {
                sendUserCursor(false);
            }
            if (e.buttons) {
                sendViewportIfChanged();
            }
        }, { passive: true, capture: true });

        document.addEventListener("mouseleave", () => sendUserCursor(false));
        window.addEventListener("blur", () => sendUserCursor(false));

        // Catch canvas drags, prompt typing, widget edits, and zoom/pan smoothly.
        window.addEventListener("pointerup", () => {
            scheduleSend();
            sendViewportIfChanged();
        }, true);
        window.addEventListener("keyup", scheduleSend, true);
        window.addEventListener("change", scheduleSend, true);
        window.addEventListener("input", scheduleSend, true);
        window.addEventListener("wheel", () => {
            setTimeout(sendViewportIfChanged, 50);
        }, { passive: true, capture: true });
        window.addEventListener("resize", () => {
            setTimeout(sendViewportIfChanged, 100);
        }, { passive: true });

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                sendUserCursor(false);
            } else {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    reconnectDelay = 1000;
                    connect();
                } else {
                    sendState(false);
                }
            }
        });

        window.addEventListener("pagehide", () => {
            observerOverlay.clearAll();
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
