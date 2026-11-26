// Strictly read-only real-time ComfyUI workflow monitor.

const TOKEN_STORAGE_KEY = "Comfy.liveViewToken";
const HEADER_HEIGHT = 30;
const SLOT_HEIGHT = 20;
const WIDGET_ROW_HEIGHT = 22;
const NODE_PADDING = 10;
const CURSOR_SEND_INTERVAL_MS = 32;

const SLOT_TYPE_COLORS = {
    MODEL: "#b39ddb",
    CLIP: "#ffd54f",
    VAE: "#ff8a65",
    CONDITIONING: "#ffb74d",
    LATENT: "#f48fb1",
    IMAGE: "#64b5f6",
    MASK: "#81c784",
    CONTROL_NET: "#4db6ac",
    STYLE_MODEL: "#dce775",
    CLIP_VISION: "#a1887f",
    CLIP_VISION_OUTPUT: "#ba68c8",
    GLIGEN: "#ffab91",
    UPSCALE_MODEL: "#aed581",
    INT: "#4dd0e1",
    FLOAT: "#4fc3f7",
    STRING: "#80cbc4",
    BOOLEAN: "#a5d6a7",
    AUDIO: "#ce93d8",
    VIDEO: "#90caf9",
    "*": "#b0bec5",
};

const state = {
    token: "",
    requiresToken: false,
    multiUser: true,
    ws: null,
    wsReconnectDelay: 1000,
    wsReconnectTimer: null,
    connected: false,

    mode: "focus", // "focus" | "grid"
    users: [],
    queueRemaining: 0,
    selectedUserId: null,
    selectedSessionId: null,
    savedWorkflows: [],
    viewingSavedPath: null,

    snapshotsByUser: new Map(), // user_id -> snapshot
    objectInfo: null, // optional /api/object_info fallback for saved workflows

    selectedNodeId: null,
    followCamera: false,
    shareCursor: false,
    observerCursorGraphPos: null,
    lastCursorSentAt: 0,
    cursorCurrentlyShown: false,
    userCursorsByUser: new Map(), // user_id -> { visible, x, y }
    camera: { x: 80, y: 80, scale: 0.85 },
    hasUserFittedCamera: new Set(),

    imageCache: new Map(), // url -> { img, status }
    nodeLayoutCache: new Map(), // nodeId -> { x, y, topY, w, bodyH, totalH }
};

// DOM references
const el = {
    authOverlay: document.getElementById("auth-overlay"),
    authForm: document.getElementById("auth-form"),
    authInput: document.getElementById("auth-token-input"),
    authError: document.getElementById("auth-error"),
    connDot: document.getElementById("conn-dot"),
    connLabel: document.getElementById("conn-label"),
    queueBadge: document.getElementById("queue-badge"),

    btnToggleSidebar: document.getElementById("btn-toggle-sidebar"),
    btnToggleInspector: document.getElementById("btn-toggle-inspector"),
    btnCloseInspector: document.getElementById("btn-close-inspector"),
    btnLogout: document.getElementById("btn-logout"),
    btnModeFocus: document.getElementById("btn-mode-focus"),
    btnModeGrid: document.getElementById("btn-mode-grid"),
    focusControls: document.getElementById("focus-controls"),

    tabSelect: document.getElementById("tab-select"),
    nodeSearch: document.getElementById("node-search"),
    btnShareCursor: document.getElementById("btn-share-cursor"),
    btnShareCursorLabel: document.getElementById("btn-share-cursor-label"),
    btnFollow: document.getElementById("btn-follow"),
    btnFit: document.getElementById("btn-fit"),
    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
    zoomLabel: document.getElementById("zoom-label"),

    sidebar: document.getElementById("sidebar"),
    usersCount: document.getElementById("users-count"),
    userFilter: document.getElementById("user-filter"),
    usersList: document.getElementById("users-list"),
    savedSection: document.getElementById("saved-section"),
    savedList: document.getElementById("saved-list"),
    btnRefreshSaved: document.getElementById("btn-refresh-saved"),

    savedBanner: document.getElementById("saved-banner"),
    savedBannerText: document.getElementById("saved-banner-text"),
    btnBackLive: document.getElementById("btn-back-live"),
    activeUserBar: document.getElementById("active-user-bar"),
    activeStatusDot: document.getElementById("active-status-dot"),
    activeUsername: document.getElementById("active-username"),
    activeWorkflowName: document.getElementById("active-workflow-name"),
    activeCounts: document.getElementById("active-counts"),
    activeExecMeta: document.getElementById("active-exec-meta"),

    focusStage: document.getElementById("focus-stage"),
    canvas: document.getElementById("graph-canvas"),
    emptyState: document.getElementById("empty-state"),
    emptyTitle: document.getElementById("empty-title"),
    emptyDesc: document.getElementById("empty-desc"),

    gridStage: document.getElementById("grid-stage"),
    gridContainer: document.getElementById("grid-container"),

    inspector: document.getElementById("inspector"),
    inspectorTitle: document.getElementById("inspector-title"),
    inspectorBody: document.getElementById("inspector-body"),

    lightbox: document.getElementById("lightbox"),
    lightboxImg: document.getElementById("lightbox-img"),
    lightboxCaption: document.getElementById("lightbox-caption"),
    lightboxClose: document.getElementById("lightbox-close"),
};

const ctx = el.canvas.getContext("2d");

function getAuthHeaders() {
    const headers = {};
    if (state.token) {
        headers["Authorization"] = `Bearer ${state.token}`;
    }
    return headers;
}

async function apiFetchJson(url) {
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (res.status === 401) {
        showAuthOverlay("Invalid or expired token.");
        throw new Error("Unauthorized");
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
}

function showAuthOverlay(errorMsg = "") {
    el.authOverlay.classList.remove("hidden");
    if (errorMsg) {
        el.authError.textContent = errorMsg;
        el.authError.classList.remove("hidden");
    } else {
        el.authError.classList.add("hidden");
    }
    el.authInput.focus();
}

function hideAuthOverlay() {
    el.authOverlay.classList.add("hidden");
    el.authError.classList.add("hidden");
}

function setConnectionUi(status, text) {
    el.connDot.className = "brand-dot" + (status ? ` ${status}` : "");
    el.connLabel.textContent = text;
}

function formatTimeAgo(ms) {
    if (!ms) return "never";
    const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diff < 5) return "just now";
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function buildViewUrl(file) {
    const params = new URLSearchParams();
    params.set("filename", file.filename);
    if (file.subfolder) params.set("subfolder", file.subfolder);
    if (file.type) params.set("type", file.type);
    return `/view?${params.toString()}`;
}

function getCachedImage(url) {
    let entry = state.imageCache.get(url);
    if (!entry) {
        const img = new Image();
        entry = { img, status: "loading" };
        state.imageCache.set(url, entry);
        // Cap image cache size so long sessions stay bounded.
        if (state.imageCache.size > 80) {
            const firstKey = state.imageCache.keys().next().value;
            state.imageCache.delete(firstKey);
        }
        img.onload = () => {
            entry.status = "loaded";
            requestRender();
        };
        img.onerror = () => {
            entry.status = "error";
        };
        img.src = url;
    }
    return entry;
}

function parsePair(val, fallbackA, fallbackB) {
    if (Array.isArray(val) && val.length >= 2) {
        return [Number(val[0]) || fallbackA, Number(val[1]) || fallbackB];
    }
    if (val && typeof val === "object" && "0" in val && "1" in val) {
        return [Number(val[0]) || fallbackA, Number(val[1]) || fallbackB];
    }
    return [fallbackA, fallbackB];
}

function parseLinks(workflow) {
    const rawLinks = workflow?.links;
    if (!Array.isArray(rawLinks)) return [];
    const parsed = [];
    for (const item of rawLinks) {
        if (Array.isArray(item) && item.length >= 5) {
            parsed.push({
                id: item[0],
                origin_id: item[1],
                origin_slot: item[2],
                target_id: item[3],
                target_slot: item[4],
                type: item[5] || "*",
            });
        } else if (item && typeof item === "object") {
            parsed.push({
                id: item.id,
                origin_id: item.origin_id,
                origin_slot: item.origin_slot ?? 0,
                target_id: item.target_id,
                target_slot: item.target_slot ?? 0,
                type: item.type || "*",
            });
        }
    }
    return parsed;
}

function slotColor(type) {
    if (!type) return SLOT_TYPE_COLORS["*"];
    const key = String(type).toUpperCase();
    return SLOT_TYPE_COLORS[key] || "#9aa5b1";
}

function inferWidgetListFromObjectInfo(node) {
    const values = node.widgets_values;
    if (!values) return [];

    if (!Array.isArray(values) && typeof values === "object") {
        return Object.entries(values).map(([name, value]) => ({ name, value }));
    }

    if (!Array.isArray(values) || values.length === 0) return [];

    const def = state.objectInfo?.[node.type];
    if (!def?.input) {
        return values.map((v, i) => ({ name: `param_${i + 1}`, value: v }));
    }

    const linkedNames = new Set(
        (node.inputs || [])
            .filter((inp) => inp && inp.link !== null && inp.link !== undefined && !inp.widget)
            .map((inp) => inp.name)
    );

    const widgetInputNames = [];
    const order = def.input_order || {};
    for (const group of ["required", "optional"]) {
        const groupDefs = def.input[group];
        if (!groupDefs || typeof groupDefs !== "object") continue;
        const keys = Array.isArray(order[group]) ? order[group] : Object.keys(groupDefs);
        for (const name of keys) {
            const spec = groupDefs[name];
            if (!Array.isArray(spec) || spec.length === 0) continue;
            const typeOrChoices = spec[0];
            const isPrimitive =
                Array.isArray(typeOrChoices) ||
                ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"].includes(typeOrChoices);
            if (!isPrimitive || linkedNames.has(name)) continue;
            widgetInputNames.push(name);
            const opts = spec[1] || {};
            if (
                typeOrChoices === "INT" &&
                (name === "seed" || name === "noise_seed" || opts.control_after_generate)
            ) {
                widgetInputNames.push("control_after_generate");
            }
        }
    }

    return values.map((value, idx) => ({
        name: widgetInputNames[idx] || `param_${idx + 1}`,
        value,
    }));
}

function getNodeWidgets(node, nodeMetaMap) {
    const meta = nodeMetaMap?.[String(node.id)];
    if (meta && Array.isArray(meta.widgets) && meta.widgets.length > 0) {
        return meta.widgets;
    }
    return inferWidgetListFromObjectInfo(node);
}

function getNodeTitle(node, nodeMetaMap) {
    const meta = nodeMetaMap?.[String(node.id)];
    if (meta?.title) return meta.title;
    if (typeof node.title === "string" && node.title) return node.title;
    return node.type || `Node #${node.id}`;
}

function getNodeImages(node, nodeMetaMap, execution) {
    const urls = [];
    const nid = String(node.id);
    if (execution?.preview && execution.preview.node_id === nid && execution.preview.data_url) {
        urls.push(execution.preview.data_url);
    }
    const execOutputs = execution?.outputs?.[nid];
    if (Array.isArray(execOutputs)) {
        for (const item of execOutputs) {
            if (item.media === "image") {
                urls.push(buildViewUrl(item));
            }
        }
    }
    const metaImgs = nodeMetaMap?.[nid]?.imgs;
    if (Array.isArray(metaImgs)) {
        for (const u of metaImgs) {
            if (!urls.includes(u)) urls.push(u);
        }
    }
    return urls;
}

function formatWidgetShortValue(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === "boolean") return val ? "true" : "false";
    if (typeof val === "number") {
        return Number.isInteger(val) ? String(val) : String(Math.round(val * 1000) / 1000);
    }
    const s = String(val).replace(/\s+/g, " ").trim();
    return s.length > 44 ? s.slice(0, 43) + "…" : s;
}

function drawRoundedRect(c, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + radius, y);
    c.lineTo(x + w - radius, y);
    c.quadraticCurveTo(x + w, y, x + w, y + radius);
    c.lineTo(x + w, y + h - radius);
    c.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    c.lineTo(x + radius, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - radius);
    c.lineTo(x, y + radius);
    c.quadraticCurveTo(x, y, x + radius, y);
    c.closePath();
}

function computeWorkflowBounds(workflow) {
    const nodes = workflow?.nodes;
    const groups = workflow?.groups;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    if (Array.isArray(nodes)) {
        for (const node of nodes) {
            const [x, y] = parsePair(node.pos, 0, 0);
            const [w, h] = parsePair(node.size, 220, 120);
            const collapsed = Boolean(node.flags?.collapsed);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y - HEADER_HEIGHT);
            maxX = Math.max(maxX, x + Math.max(w, 160));
            maxY = Math.max(maxY, collapsed ? y : y + Math.max(h, 60));
        }
    }
    if (Array.isArray(groups)) {
        for (const g of groups) {
            if (!Array.isArray(g.bounding) || g.bounding.length < 4) continue;
            minX = Math.min(minX, g.bounding[0]);
            minY = Math.min(minY, g.bounding[1]);
            maxX = Math.max(maxX, g.bounding[0] + g.bounding[2]);
            maxY = Math.max(maxY, g.bounding[1] + g.bounding[3]);
        }
    }
    if (!Number.isFinite(minX)) {
        return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
    }
    return { minX, minY, maxX, maxY };
}

function drawPointerMarker(targetCtx, gx, gy, scale, fillColor, strokeColor, labelText) {
    const inv = 1 / Math.max(scale, 0.08);
    targetCtx.save();
    targetCtx.translate(gx, gy);
    targetCtx.scale(inv, inv);

    targetCtx.beginPath();
    targetCtx.moveTo(0, 0);
    targetCtx.lineTo(5.5, 16.5);
    targetCtx.lineTo(8.5, 10.8);
    targetCtx.lineTo(14.8, 8.2);
    targetCtx.closePath();
    targetCtx.fillStyle = fillColor;
    targetCtx.fill();
    targetCtx.lineWidth = 1.6;
    targetCtx.strokeStyle = strokeColor;
    targetCtx.lineJoin = "round";
    targetCtx.stroke();

    if (labelText) {
        targetCtx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
        const tw = targetCtx.measureText(labelText).width;
        const px = 13;
        const py = 14;
        drawRoundedRect(targetCtx, px, py, tw + 12, 18, 9);
        targetCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
        targetCtx.fill();
        targetCtx.lineWidth = 1;
        targetCtx.strokeStyle = fillColor;
        targetCtx.stroke();
        targetCtx.fillStyle = "#f8fafc";
        targetCtx.textBaseline = "middle";
        targetCtx.fillText(labelText, px + 6, py + 9.5);
    }

    targetCtx.restore();
}

function renderWorkflowToCanvas(targetCtx, width, height, snapshot, camera, options = {}) {
    const {
        selectedNodeId = null,
        interactiveLayoutOut = null,
        mini = false,
    } = options;

    targetCtx.save();
    targetCtx.fillStyle = "#111318";
    targetCtx.fillRect(0, 0, width, height);

    const workflow = snapshot?.workflow;
    const nodeMeta = snapshot?.node_meta || {};
    const execution = snapshot?.execution || null;

    // Background dot grid
    if (!mini && camera.scale > 0.2) {
        const step = 40 * camera.scale;
        const startX = ((camera.x % step) + step) % step;
        const startY = ((camera.y % step) + step) % step;
        targetCtx.fillStyle = "rgba(148, 163, 184, 0.14)";
        for (let gx = startX; gx < width; gx += step) {
            for (let gy = startY; gy < height; gy += step) {
                targetCtx.fillRect(gx, gy, 1.5, 1.5);
            }
        }
    }

    if (!workflow || !Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
        targetCtx.restore();
        return;
    }

    targetCtx.translate(camera.x, camera.y);
    targetCtx.scale(camera.scale, camera.scale);

    // 1. Groups
    if (Array.isArray(workflow.groups)) {
        for (const g of workflow.groups) {
            if (!Array.isArray(g.bounding) || g.bounding.length < 4) continue;
            const [gx, gy, gw, gh] = g.bounding;
            const baseColor = g.color || "#3f789e";
            targetCtx.save();
            drawRoundedRect(targetCtx, gx, gy, gw, gh, 8);
            targetCtx.fillStyle = baseColor;
            targetCtx.globalAlpha = 0.14;
            targetCtx.fill();
            targetCtx.globalAlpha = 0.55;
            targetCtx.lineWidth = 1.5;
            targetCtx.strokeStyle = baseColor;
            targetCtx.stroke();
            targetCtx.globalAlpha = 0.9;
            if (!mini && g.title) {
                const fs = Math.min(Math.max(g.font_size || 20, 13), 30);
                targetCtx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`;
                targetCtx.fillStyle = "#dce3f0";
                targetCtx.fillText(String(g.title), gx + 10, gy + fs + 6);
            }
            targetCtx.restore();
        }
    }

    // Precompute node boxes and slot anchors matching LiteGraph coordinates
    // (title bar occupies [y - HEADER_HEIGHT, y]; body occupies [y, y + bodyH]).
    const nodeMap = new Map();
    const layoutMap = new Map();
    if (interactiveLayoutOut) interactiveLayoutOut.clear();

    for (const node of workflow.nodes) {
        const [x, y] = parsePair(node.pos, 0, 0);
        const [rawW, rawH] = parsePair(node.size, 220, 100);
        const collapsed = Boolean(node.flags?.collapsed);
        const inputs = Array.isArray(node.inputs) ? node.inputs : [];
        const outputs = Array.isArray(node.outputs) ? node.outputs : [];
        const widgets = mini ? [] : getNodeWidgets(node, nodeMeta);
        const images = mini ? [] : getNodeImages(node, nodeMeta, execution);

        const slotRows = Math.max(inputs.length, outputs.length);
        const visibleWidgets = widgets.slice(0, 12);
        const textBlockCount = visibleWidgets.filter(
            (w) => typeof w.value === "string" && w.value.length > 48
        ).length;
        const estimatedBodyH =
            8 +
            slotRows * SLOT_HEIGHT +
            (visibleWidgets.length > 0 ? 6 + visibleWidgets.length * WIDGET_ROW_HEIGHT + textBlockCount * 22 : 0) +
            (images.length > 0 ? 136 : 0) +
            NODE_PADDING;

        const w = collapsed ? Math.max(150, Math.min(rawW, 220)) : Math.max(rawW, 175);
        const topY = y - HEADER_HEIGHT;
        const bodyH = collapsed ? 0 : Math.max(rawH, estimatedBodyH);
        const totalH = HEADER_HEIGHT + bodyH;

        const rect = { x, y, topY, w, bodyH, totalH, collapsed, inputs, outputs, widgets, images };
        nodeMap.set(node.id, node);
        layoutMap.set(node.id, rect);
        if (interactiveLayoutOut) {
            interactiveLayoutOut.set(String(node.id), rect);
        }
    }

    const getInputPos = (nodeId, slotIndex) => {
        const r = layoutMap.get(nodeId);
        if (!r) return null;
        if (r.collapsed) return [r.x, r.topY + HEADER_HEIGHT / 2];
        return [r.x, r.y + 10 + slotIndex * SLOT_HEIGHT];
    };

    const getOutputPos = (nodeId, slotIndex) => {
        const r = layoutMap.get(nodeId);
        if (!r) return null;
        if (r.collapsed) return [r.x + r.w, r.topY + HEADER_HEIGHT / 2];
        return [r.x + r.w, r.y + 10 + slotIndex * SLOT_HEIGHT];
    };

    // 2. Links
    const links = parseLinks(workflow);
    for (const link of links) {
        const p1 = getOutputPos(link.origin_id, link.origin_slot);
        const p2 = getInputPos(link.target_id, link.target_slot);
        if (!p1 || !p2) continue;

        const isHighlighted =
            selectedNodeId !== null &&
            (String(link.origin_id) === String(selectedNodeId) ||
                String(link.target_id) === String(selectedNodeId));

        const dx = Math.max(Math.abs(p2[0] - p1[0]) * 0.45, 55);
        targetCtx.beginPath();
        targetCtx.moveTo(p1[0], p1[1]);
        targetCtx.bezierCurveTo(p1[0] + dx, p1[1], p2[0] - dx, p2[1], p2[0], p2[1]);
        targetCtx.strokeStyle = slotColor(link.type);
        targetCtx.lineWidth = isHighlighted ? 3.5 : (mini ? 2.5 : 2.2);
        targetCtx.globalAlpha = isHighlighted ? 1.0 : (selectedNodeId !== null ? 0.35 : 0.8);
        targetCtx.stroke();
    }
    targetCtx.globalAlpha = 1.0;

    // 3. Nodes
    const runningNodeId = execution?.running ? (execution.display_node || execution.executing_node) : null;
    const errorNodeId = execution?.error?.node_id || null;
    const progress = execution?.running ? execution.progress : null;

    for (const node of workflow.nodes) {
        const r = layoutMap.get(node.id);
        if (!r) continue;

        const nidStr = String(node.id);
        const isRunning = runningNodeId !== null && String(runningNodeId) === nidStr;
        const isError = errorNodeId !== null && String(errorNodeId) === nidStr;
        const isSelected = selectedNodeId !== null && String(selectedNodeId) === nidStr;
        const isMuted = node.mode === 2;
        const isBypassed = node.mode === 4;

        targetCtx.save();
        if (isMuted) targetCtx.globalAlpha = 0.55;

        // Node body
        drawRoundedRect(targetCtx, r.x, r.topY, r.w, r.totalH, 8);
        targetCtx.fillStyle = isBypassed ? "#2d2138" : (node.bgcolor || "#212530");
        targetCtx.fill();

        // Header bar
        targetCtx.save();
        drawRoundedRect(targetCtx, r.x, r.topY, r.w, r.totalH, 8);
        targetCtx.clip();
        targetCtx.fillStyle = isBypassed
            ? "#5b3278"
            : isMuted
                ? "#333949"
                : (node.color || "#2d3343");
        targetCtx.fillRect(r.x, r.topY, r.w, HEADER_HEIGHT);
        targetCtx.restore();

        // Border / execution glow
        drawRoundedRect(targetCtx, r.x, r.topY, r.w, r.totalH, 8);
        if (isRunning) {
            targetCtx.lineWidth = 3.2;
            targetCtx.strokeStyle = "#4ade80";
            targetCtx.shadowColor = "rgba(74, 222, 128, 0.75)";
            targetCtx.shadowBlur = 14;
            targetCtx.stroke();
            targetCtx.shadowBlur = 0;
        } else if (isError) {
            targetCtx.lineWidth = 3;
            targetCtx.strokeStyle = "#f87171";
            targetCtx.stroke();
        } else if (isSelected) {
            targetCtx.lineWidth = 2.5;
            targetCtx.strokeStyle = "#60a5fa";
            targetCtx.stroke();
        } else {
            targetCtx.lineWidth = 1.2;
            targetCtx.strokeStyle = "#3a4256";
            targetCtx.stroke();
        }

        // Title
        if (!mini || camera.scale > 0.16) {
            const title = getNodeTitle(node, nodeMeta);
            targetCtx.save();
            targetCtx.beginPath();
            targetCtx.rect(r.x + 8, r.topY, r.w - 38, HEADER_HEIGHT);
            targetCtx.clip();
            targetCtx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
            targetCtx.fillStyle = "#eef2fa";
            targetCtx.textBaseline = "middle";
            targetCtx.fillText(title, r.x + 10, r.topY + HEADER_HEIGHT / 2 + 0.5);
            targetCtx.restore();

            if (!mini) {
                targetCtx.font = "500 10px ui-monospace, monospace";
                targetCtx.fillStyle = "rgba(226, 232, 240, 0.55)";
                targetCtx.textAlign = "right";
                targetCtx.textBaseline = "middle";
                const tag = isBypassed ? "BYP" : isMuted ? "MUTE" : `#${node.id}`;
                targetCtx.fillText(tag, r.x + r.w - 8, r.topY + HEADER_HEIGHT / 2 + 0.5);
                targetCtx.textAlign = "left";
            }
        }

        if (r.collapsed || mini) {
            if (mini && isRunning && progress && progress.max > 0) {
                const pct = Math.max(0, Math.min(1, progress.value / progress.max));
                targetCtx.fillStyle = "#4ade80";
                targetCtx.fillRect(r.x, r.topY + r.totalH - 5, r.w * pct, 5);
            }
            targetCtx.restore();
            continue;
        }

        // Slots
        targetCtx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
        targetCtx.textBaseline = "middle";

        for (let i = 0; i < r.inputs.length; i++) {
            const inp = r.inputs[i];
            const sy = r.y + 10 + i * SLOT_HEIGHT;
            const linked = inp.link !== null && inp.link !== undefined;
            targetCtx.beginPath();
            targetCtx.arc(r.x, sy, 4.5, 0, Math.PI * 2);
            targetCtx.fillStyle = linked ? slotColor(inp.type) : "#1a1e28";
            targetCtx.fill();
            targetCtx.lineWidth = 1.5;
            targetCtx.strokeStyle = slotColor(inp.type);
            targetCtx.stroke();

            targetCtx.fillStyle = "#cbd5e1";
            targetCtx.fillText(String(inp.label || inp.name || ""), r.x + 10, sy);
        }

        targetCtx.textAlign = "right";
        for (let i = 0; i < r.outputs.length; i++) {
            const out = r.outputs[i];
            const sy = r.y + 10 + i * SLOT_HEIGHT;
            const linked = Array.isArray(out.links) && out.links.length > 0;
            targetCtx.beginPath();
            targetCtx.arc(r.x + r.w, sy, 4.5, 0, Math.PI * 2);
            targetCtx.fillStyle = linked ? slotColor(out.type) : "#1a1e28";
            targetCtx.fill();
            targetCtx.lineWidth = 1.5;
            targetCtx.strokeStyle = slotColor(out.type);
            targetCtx.stroke();

            targetCtx.fillStyle = "#cbd5e1";
            targetCtx.fillText(String(out.label || out.name || ""), r.x + r.w - 10, sy);
        }
        targetCtx.textAlign = "left";

        // Widgets
        let curY = r.y + 8 + Math.max(r.inputs.length, r.outputs.length) * SLOT_HEIGHT + 2;
        const maxWidgetBottom = r.y + r.bodyH - (r.images.length > 0 ? 132 : 8);

        for (const w of r.widgets.slice(0, 12)) {
            const valStr = typeof w.value === "string" ? w.value : "";
            const isLongText = valStr.length > 48 || valStr.includes("\n");
            const boxH = isLongText ? 40 : 18;
            if (curY + boxH > maxWidgetBottom) break;

            drawRoundedRect(targetCtx, r.x + 8, curY, r.w - 16, boxH, 4);
            targetCtx.fillStyle = "rgba(13, 15, 20, 0.7)";
            targetCtx.fill();
            targetCtx.lineWidth = 1;
            targetCtx.strokeStyle = "rgba(71, 85, 105, 0.45)";
            targetCtx.stroke();

            targetCtx.save();
            targetCtx.beginPath();
            targetCtx.rect(r.x + 11, curY, r.w - 22, boxH);
            targetCtx.clip();

            const wLabel = w.label || w.name || "";
            if (isLongText) {
                targetCtx.font = "10.5px ui-monospace, monospace";
                targetCtx.fillStyle = "#d4dce9";
                targetCtx.textBaseline = "top";
                const cleanText = valStr.replace(/\s+/g, " ").trim();
                const charsPerLine = Math.max(18, Math.floor((r.w - 26) / 6.3));
                const line1 = cleanText.slice(0, charsPerLine);
                const line2 = cleanText.slice(charsPerLine, charsPerLine * 2);
                targetCtx.fillText(line1, r.x + 13, curY + 6);
                if (line2) {
                    targetCtx.fillText(
                        cleanText.length > charsPerLine * 2 ? line2.slice(0, -1) + "…" : line2,
                        r.x + 13,
                        curY + 21
                    );
                }
            } else {
                targetCtx.font = "10.5px -apple-system, BlinkMacSystemFont, sans-serif";
                targetCtx.textBaseline = "middle";
                targetCtx.fillStyle = "#8a96ad";
                targetCtx.fillText(wLabel, r.x + 13, curY + boxH / 2 + 0.5);

                targetCtx.font = "10.5px ui-monospace, monospace";
                targetCtx.fillStyle = "#e2e8f0";
                targetCtx.textAlign = "right";
                targetCtx.fillText(formatWidgetShortValue(w.value), r.x + r.w - 13, curY + boxH / 2 + 0.5);
                targetCtx.textAlign = "left";
            }
            targetCtx.restore();
            curY += boxH + 4;
        }

        // Inline image preview (latest output or live sampler preview)
        if (r.images.length > 0) {
            const imgAreaH = Math.max(80, r.y + r.bodyH - curY - 10);
            const imgAreaW = r.w - 16;
            if (imgAreaH >= 50) {
                const entry = getCachedImage(r.images[0]);
                drawRoundedRect(targetCtx, r.x + 8, curY, imgAreaW, imgAreaH, 5);
                targetCtx.fillStyle = "#0b0d12";
                targetCtx.fill();
                if (entry.status === "loaded" && entry.img.naturalWidth > 0) {
                    const scale = Math.min(
                        imgAreaW / entry.img.naturalWidth,
                        imgAreaH / entry.img.naturalHeight
                    );
                    const dw = entry.img.naturalWidth * scale;
                    const dh = entry.img.naturalHeight * scale;
                    const dx = r.x + 8 + (imgAreaW - dw) / 2;
                    const dy = curY + (imgAreaH - dh) / 2;
                    targetCtx.drawImage(entry.img, dx, dy, dw, dh);
                }
            }
        }

        // Live node progress bar
        if (isRunning && progress && progress.max > 0) {
            const pct = Math.max(0, Math.min(1, progress.value / progress.max));
            targetCtx.fillStyle = "rgba(15, 23, 42, 0.85)";
            targetCtx.fillRect(r.x + 1, r.y - 3, r.w - 2, 4);
            targetCtx.fillStyle = "#4ade80";
            targetCtx.fillRect(r.x + 1, r.y - 3, (r.w - 2) * pct, 4);
        }

        targetCtx.restore();
    }

    // 4. User's current screen window boundary (when cursor sharing is active)
    if (
        !mini &&
        state.shareCursor &&
        !state.viewingSavedPath &&
        snapshot?.viewport?.width > 0 &&
        snapshot?.viewport?.height > 0 &&
        snapshot.viewport.scale > 0 &&
        Array.isArray(snapshot.viewport.offset)
    ) {
        const vp = snapshot.viewport;
        const winX = -vp.offset[0];
        const winY = -vp.offset[1];
        const winW = vp.width / vp.scale;
        const winH = vp.height / vp.scale;
        const obs = state.observerCursorGraphPos;
        const isOutside =
            obs !== null &&
            (obs.x < winX || obs.x > winX + winW || obs.y < winY || obs.y > winY + winH);

        const inv = 1 / Math.max(camera.scale, 0.08);
        targetCtx.save();
        targetCtx.strokeStyle = isOutside ? "rgba(255, 107, 43, 0.85)" : "rgba(96, 165, 250, 0.55)";
        targetCtx.lineWidth = 1.6 * inv;
        targetCtx.setLineDash([7 * inv, 5 * inv]);
        targetCtx.strokeRect(winX, winY, winW, winH);
        targetCtx.setLineDash([]);

        targetCtx.font = `600 ${11 * inv}px -apple-system, BlinkMacSystemFont, sans-serif`;
        targetCtx.fillStyle = isOutside ? "#ff9f6b" : "#93c5fd";
        targetCtx.textBaseline = "bottom";
        targetCtx.fillText(
            isOutside ? "User's Screen (Edge Light Active)" : "User's Screen",
            winX + 6 * inv,
            winY - 5 * inv
        );
        targetCtx.restore();
    }

    // 5. Watched user's live mouse cursor in shared graph coordinates
    if (!mini && !state.viewingSavedPath && snapshot?.user_id) {
        const userCursor = state.userCursorsByUser.get(snapshot.user_id);
        if (userCursor && userCursor.visible && typeof userCursor.x === "number" && typeof userCursor.y === "number") {
            drawPointerMarker(
                targetCtx,
                userCursor.x,
                userCursor.y,
                camera.scale,
                "#4ade80",
                "#0f172a",
                snapshot.username || "User"
            );
        }
    }

    targetCtx.restore();
}

let renderQueued = false;
function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        if (state.mode === "focus") {
            renderFocusCanvas();
        } else {
            renderGridCanvases();
        }
    });
}

function getActiveSnapshot() {
    if (!state.selectedUserId) return null;
    return state.snapshotsByUser.get(state.selectedUserId) || null;
}

function resizeFocusCanvas() {
    const rect = el.focusStage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (el.canvas.width !== Math.floor(w * dpr) || el.canvas.height !== Math.floor(h * dpr)) {
        el.canvas.width = Math.floor(w * dpr);
        el.canvas.height = Math.floor(h * dpr);
    }
    return { w, h, dpr };
}

function renderFocusCanvas() {
    const { w, h, dpr } = resizeFocusCanvas();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const snapshot = getActiveSnapshot();
    const hasNodes = Boolean(snapshot?.workflow?.nodes && snapshot.workflow.nodes.length > 0);
    el.emptyState.classList.toggle("hidden", hasNodes);

    if (!hasNodes) {
        if (state.selectedUserId) {
            const user = state.users.find((u) => u.user_id === state.selectedUserId);
            el.emptyTitle.textContent = user ? `${user.username} has no active workflow` : "No workflow data";
            el.emptyDesc.textContent = user?.online
                ? "Their canvas is currently empty. Nodes will appear here live as soon as they add or load a workflow."
                : "This user is currently offline. Pick a saved workflow from the left sidebar or wait for them to connect.";
        } else {
            el.emptyTitle.textContent = "Waiting for user workflows";
            el.emptyDesc.textContent = "Select a user from the left panel or wait for someone to open ComfyUI. Live workflow changes appear here automatically in read-only mode.";
        }
    }

    renderWorkflowToCanvas(ctx, w, h, snapshot, state.camera, {
        selectedNodeId: state.selectedNodeId,
        interactiveLayoutOut: state.nodeLayoutCache,
        mini: false,
    });
    ctx.restore();
    el.zoomLabel.textContent = `${Math.round(state.camera.scale * 100)}%`;
}

function fitWorkflowInView(snapshot = getActiveSnapshot()) {
    if (!snapshot?.workflow) return;
    const rect = el.focusStage.getBoundingClientRect();
    const w = Math.max(rect.width, 300);
    const h = Math.max(rect.height, 200);
    const b = computeWorkflowBounds(snapshot.workflow);
    const bw = Math.max(b.maxX - b.minX, 200);
    const bh = Math.max(b.maxY - b.minY, 150);
    const pad = 64;
    const scale = Math.max(0.12, Math.min(1.4, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
    state.camera.scale = scale;
    state.camera.x = (w - bw * scale) / 2 - b.minX * scale;
    state.camera.y = (h - bh * scale) / 2 - b.minY * scale;
    requestRender();
}

function applyUserViewport(viewport) {
    if (!viewport || !state.followCamera) return;
    if (typeof viewport.scale !== "number" || !Array.isArray(viewport.offset)) return;
    // LiteGraph ds.offset is in graph units; screen = (graph + offset) * scale.
    state.camera.scale = Math.max(0.08, Math.min(3.5, viewport.scale));
    state.camera.x = viewport.offset[0] * state.camera.scale;
    state.camera.y = viewport.offset[1] * state.camera.scale;
    requestRender();
}

function centerOnNode(nodeId) {
    const r = state.nodeLayoutCache.get(String(nodeId));
    if (!r) return;
    const rect = el.focusStage.getBoundingClientRect();
    state.followCamera = false;
    el.btnFollow.classList.remove("active");
    state.camera.scale = Math.max(state.camera.scale, 0.75);
    state.camera.x = rect.width / 2 - (r.x + r.w / 2) * state.camera.scale;
    state.camera.y = rect.height / 2 - (r.topY + r.totalH / 2) * state.camera.scale;
    state.selectedNodeId = String(nodeId);
    renderInspector();
    requestRender();
}

function renderUsersSidebar() {
    const query = (el.userFilter.value || "").trim().toLowerCase();
    const onlineCount = state.users.filter((u) => u.online).length;
    el.usersCount.textContent = `${onlineCount}/${state.users.length}`;
    el.queueBadge.textContent = `Queue: ${state.queueRemaining}`;
    el.queueBadge.className = state.queueRemaining > 0 ? "badge badge-running" : "badge badge-neutral";

    const filtered = state.users.filter((u) => {
        if (!query) return true;
        return (
            u.username.toLowerCase().includes(query) ||
            (u.workflow_name || "").toLowerCase().includes(query)
        );
    });

    el.usersList.innerHTML = "";
    if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.style.padding = "14px 8px";
        empty.style.color = "var(--text-muted)";
        empty.style.textAlign = "center";
        empty.textContent = state.users.length === 0 ? "No users yet" : "No matching users";
        el.usersList.appendChild(empty);
        return;
    }

    for (const user of filtered) {
        const item = document.createElement("div");
        item.className = "user-item" + (user.user_id === state.selectedUserId ? " selected" : "");
        item.addEventListener("click", () => selectUser(user.user_id));

        const top = document.createElement("div");
        top.className = "user-item-top";

        const nameWrap = document.createElement("div");
        nameWrap.className = "user-name-wrap";

        const dot = document.createElement("span");
        dot.className = "status-dot" + (user.running ? " running" : user.online ? " online" : "");

        const name = document.createElement("span");
        name.className = "user-name";
        name.textContent = user.username;
        nameWrap.append(dot, name);

        const rightBadge = document.createElement("span");
        if (user.running) {
            rightBadge.className = "badge badge-running";
            rightBadge.textContent = user.progress?.max
                ? `${Math.round((user.progress.value / user.progress.max) * 100)}%`
                : "Running";
        } else if (user.has_error) {
            rightBadge.className = "badge badge-error";
            rightBadge.textContent = "Error";
        } else if (user.online) {
            rightBadge.className = "badge badge-neutral";
            rightBadge.textContent = user.session_count > 1 ? `${user.session_count} tabs` : "Live";
        } else {
            rightBadge.className = "user-stat";
            rightBadge.textContent = user.updated_at ? formatTimeAgo(user.updated_at) : "Offline";
        }
        top.append(nameWrap, rightBadge);

        const sub = document.createElement("div");
        sub.className = "user-sub";

        const wf = document.createElement("span");
        wf.className = "user-wf";
        wf.textContent = user.workflow_name || (user.online ? "Empty canvas" : "No live session");

        const stat = document.createElement("span");
        stat.className = "user-stat";
        stat.textContent = user.node_count > 0 ? `${user.node_count}n` : "";

        sub.append(wf, stat);
        item.append(top, sub);

        if (user.running && user.progress?.max > 0) {
            const barWrap = document.createElement("div");
            barWrap.className = "mini-progress";
            const bar = document.createElement("div");
            bar.className = "mini-progress-bar";
            bar.style.width = `${Math.min(100, Math.round((user.progress.value / user.progress.max) * 100))}%`;
            barWrap.appendChild(bar);
            item.appendChild(barWrap);
        }

        el.usersList.appendChild(item);
    }
}

function renderActiveUserBar() {
    if (state.mode !== "focus" || !state.selectedUserId) {
        el.activeUserBar.classList.add("hidden");
        el.tabSelect.classList.add("hidden");
        return;
    }
    const user = state.users.find((u) => u.user_id === state.selectedUserId);
    const snap = getActiveSnapshot();
    const exec = snap?.execution;

    el.activeUserBar.classList.remove("hidden");
    el.activeUsername.textContent = snap?.username || user?.username || state.selectedUserId;
    el.activeWorkflowName.textContent = state.viewingSavedPath
        ? state.viewingSavedPath
        : (snap?.workflow_name || user?.workflow_name || "No workflow");

    const nCount = snap?.workflow?.nodes?.length ?? user?.node_count ?? 0;
    const lCount = snap?.workflow?.links?.length ?? user?.link_count ?? 0;
    el.activeCounts.textContent = `${nCount} nodes · ${lCount} links`;

    const isRunning = Boolean(exec?.running || user?.running);
    const isOnline = Boolean(snap?.online || user?.online);
    el.activeStatusDot.className = "status-dot" + (isRunning ? " running" : isOnline ? " online" : "");

    el.activeExecMeta.innerHTML = "";
    if (isRunning) {
        const badge = document.createElement("span");
        badge.className = "badge badge-running";
        const prog = exec?.progress || user?.progress;
        const nodeLabel = exec?.display_node ? `Node #${exec.display_node}` : "Executing";
        badge.textContent = prog?.max ? `${nodeLabel} · ${prog.value}/${prog.max}` : nodeLabel;
        el.activeExecMeta.appendChild(badge);
    } else if (exec?.error) {
        const badge = document.createElement("span");
        badge.className = "badge badge-error";
        badge.textContent = `Error${exec.error.node_id ? ` on #${exec.error.node_id}` : ""}`;
        el.activeExecMeta.appendChild(badge);
    } else if (snap?.updated_at) {
        const ts = document.createElement("span");
        ts.className = "muted-meta";
        ts.textContent = isOnline ? `Updated ${formatTimeAgo(snap.updated_at)}` : `Offline · Last seen ${formatTimeAgo(snap.updated_at)}`;
        el.activeExecMeta.appendChild(ts);
    }

    // Tabs selector if user has multiple browser tabs open
    const tabs = user?.tabs || [];
    if (!state.viewingSavedPath && tabs.length > 1) {
        el.tabSelect.classList.remove("hidden");
        el.tabSelect.innerHTML = "";
        tabs.forEach((tab, idx) => {
            const opt = document.createElement("option");
            opt.value = tab.session_id;
            opt.textContent = `Tab ${idx + 1}: ${tab.workflow_name || "Untitled"}`;
            if (tab.session_id === (state.selectedSessionId || snap?.session_id)) {
                opt.selected = true;
            }
            el.tabSelect.appendChild(opt);
        });
    } else {
        el.tabSelect.classList.add("hidden");
    }
}

function renderSavedWorkflowsList() {
    if (!state.selectedUserId) {
        el.savedSection.classList.add("hidden");
        return;
    }
    el.savedSection.classList.remove("hidden");
    el.savedList.innerHTML = "";

    if (state.savedWorkflows.length === 0) {
        const empty = document.createElement("div");
        empty.style.padding = "6px 8px";
        empty.style.color = "var(--text-muted)";
        empty.style.fontSize = "11px";
        empty.textContent = "No saved workflow files";
        el.savedList.appendChild(empty);
        return;
    }

    for (const file of state.savedWorkflows) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "saved-item" + (state.viewingSavedPath === file.path ? " active" : "");
        btn.title = `${file.path} (${Math.round(file.size / 1024)} KB)`;
        btn.addEventListener("click", () => loadSavedWorkflow(state.selectedUserId, file.path));

        const nameSpan = document.createElement("span");
        nameSpan.className = "saved-item-name";
        nameSpan.textContent = file.path;

        btn.appendChild(nameSpan);
        el.savedList.appendChild(btn);
    }
}

function openLightbox(url, caption) {
    el.lightboxImg.src = url;
    el.lightboxCaption.textContent = caption || "";
    el.lightbox.classList.remove("hidden");
}

function renderInspector() {
    const snap = getActiveSnapshot();
    el.inspectorBody.innerHTML = "";

    if (!snap || !snap.workflow) {
        el.inspectorTitle.textContent = "Overview";
        const msg = document.createElement("div");
        msg.style.color = "var(--text-muted)";
        msg.textContent = "Select a user and click any node to inspect its parameters and outputs in read-only mode.";
        el.inspectorBody.appendChild(msg);
        return;
    }

    const nodes = snap.workflow.nodes || [];
    const selectedNode = state.selectedNodeId !== null
        ? nodes.find((n) => String(n.id) === String(state.selectedNodeId))
        : null;

    if (!selectedNode) {
        el.inspectorTitle.textContent = "Workflow Overview";
        const metaSec = document.createElement("div");
        metaSec.className = "insp-section";
        const metaTitle = document.createElement("div");
        metaTitle.className = "insp-section-title";
        metaTitle.textContent = "Session Info";
        metaSec.appendChild(metaTitle);

        const rows = [
            ["User", snap.username || snap.user_id],
            ["Mode", state.viewingSavedPath ? "Saved File (Read-Only)" : (snap.online ? "Live (Read-Only)" : "Offline Snapshot")],
            ["Workflow", state.viewingSavedPath || snap.workflow_name || "Unsaved"],
            ["Nodes", String(nodes.length)],
            ["Links", String((snap.workflow.links || []).length)],
            ["Groups", String((snap.workflow.groups || []).length)],
        ];
        for (const [k, v] of rows) {
            const kv = document.createElement("div");
            kv.className = "insp-kv";
            const kEl = document.createElement("span");
            kEl.className = "insp-k";
            kEl.textContent = k;
            const vEl = document.createElement("span");
            vEl.className = "insp-v";
            vEl.textContent = v;
            kv.append(kEl, vEl);
            metaSec.appendChild(kv);
        }
        el.inspectorBody.appendChild(metaSec);

        if (snap.execution?.error) {
            const errSec = document.createElement("div");
            errSec.className = "insp-section";
            const t = document.createElement("div");
            t.className = "insp-section-title";
            t.textContent = "Last Error";
            const box = document.createElement("div");
            box.className = "insp-error-box";
            box.textContent = `${snap.execution.error.node_type || "Node"} #${snap.execution.error.node_id || "?"}\n${snap.execution.error.message}`;
            errSec.append(t, box);
            el.inspectorBody.appendChild(errSec);
        }

        // Collect all outputs & live preview across nodes
        const mediaItems = [];
        if (snap.execution?.preview?.data_url) {
            mediaItems.push({ url: snap.execution.preview.data_url, label: `Live Preview (Node #${snap.execution.preview.node_id || "?"})` });
        }
        if (snap.execution?.outputs) {
            for (const [nid, items] of Object.entries(snap.execution.outputs)) {
                for (const item of items) {
                    if (item.media === "image") {
                        mediaItems.push({ url: buildViewUrl(item), label: `Node #${nid} · ${item.filename}` });
                    }
                }
            }
        }
        if (mediaItems.length > 0) {
            const galSec = document.createElement("div");
            galSec.className = "insp-section";
            const t = document.createElement("div");
            t.className = "insp-section-title";
            t.textContent = "Recent Outputs & Previews";
            const gal = document.createElement("div");
            gal.className = "insp-gallery";
            for (const item of mediaItems.slice(0, 12)) {
                const img = document.createElement("img");
                img.className = "insp-thumb";
                img.src = item.url;
                img.title = item.label;
                img.addEventListener("click", () => openLightbox(item.url, item.label));
                gal.appendChild(img);
            }
            galSec.append(t, gal);
            el.inspectorBody.appendChild(galSec);
        }

        const hint = document.createElement("div");
        hint.style.color = "var(--text-muted)";
        hint.style.fontSize = "12px";
        hint.textContent = "Click any node on the canvas to inspect its full prompt, widgets, and links.";
        el.inspectorBody.appendChild(hint);
        return;
    }

    // Selected node view (strictly read-only)
    const title = getNodeTitle(selectedNode, snap.node_meta);
    el.inspectorTitle.textContent = `${title} (#${selectedNode.id})`;

    const infoSec = document.createElement("div");
    infoSec.className = "insp-section";
    const infoTitle = document.createElement("div");
    infoTitle.className = "insp-section-title";
    infoTitle.textContent = "Node";
    infoSec.appendChild(infoTitle);

    const modeLabel = selectedNode.mode === 2 ? "Muted" : selectedNode.mode === 4 ? "Bypassed" : "Active";
    for (const [k, v] of [
        ["Type", selectedNode.type || "Unknown"],
        ["ID", `#${selectedNode.id}`],
        ["State", modeLabel],
    ]) {
        const kv = document.createElement("div");
        kv.className = "insp-kv";
        const kEl = document.createElement("span");
        kEl.className = "insp-k";
        kEl.textContent = k;
        const vEl = document.createElement("span");
        vEl.className = "insp-v";
        vEl.textContent = v;
        kv.append(kEl, vEl);
        infoSec.appendChild(kv);
    }
    el.inspectorBody.appendChild(infoSec);

    if (snap.execution?.error && String(snap.execution.error.node_id) === String(selectedNode.id)) {
        const errBox = document.createElement("div");
        errBox.className = "insp-error-box";
        errBox.textContent = snap.execution.error.message;
        el.inspectorBody.appendChild(errBox);
    }

    // Widgets / Parameters
    const widgets = getNodeWidgets(selectedNode, snap.node_meta);
    if (widgets.length > 0) {
        const wSec = document.createElement("div");
        wSec.className = "insp-section";
        const wt = document.createElement("div");
        wt.className = "insp-section-title";
        wt.textContent = `Parameters (${widgets.length})`;
        wSec.appendChild(wt);

        for (const w of widgets) {
            const box = document.createElement("div");
            box.className = "insp-widget";
            const head = document.createElement("div");
            head.className = "insp-widget-head";
            const nm = document.createElement("span");
            nm.className = "insp-widget-name";
            nm.textContent = w.label || w.name;
            head.appendChild(nm);

            const valStr = w.value === null || w.value === undefined ? "" : String(w.value);
            if (valStr.length > 16 && navigator.clipboard) {
                const copyBtn = document.createElement("button");
                copyBtn.type = "button";
                copyBtn.className = "btn-link";
                copyBtn.textContent = "Copy";
                copyBtn.addEventListener("click", () => {
                    navigator.clipboard.writeText(valStr).then(() => {
                        copyBtn.textContent = "Copied";
                        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
                    }).catch(() => {});
                });
                head.appendChild(copyBtn);
            }

            const pre = document.createElement("pre");
            pre.className = "insp-widget-val";
            pre.textContent = valStr;
            box.append(head, pre);
            wSec.appendChild(box);
        }
        el.inspectorBody.appendChild(wSec);
    }

    // Node images
    const nodeImgs = getNodeImages(selectedNode, snap.node_meta, snap.execution);
    if (nodeImgs.length > 0) {
        const imgSec = document.createElement("div");
        imgSec.className = "insp-section";
        const it = document.createElement("div");
        it.className = "insp-section-title";
        it.textContent = "Images";
        const gal = document.createElement("div");
        gal.className = "insp-gallery";
        for (const url of nodeImgs) {
            const img = document.createElement("img");
            img.className = "insp-thumb";
            img.src = url;
            img.addEventListener("click", () => openLightbox(url, `${title} (#${selectedNode.id})`));
            gal.appendChild(img);
        }
        imgSec.append(it, gal);
        el.inspectorBody.appendChild(imgSec);
    }

    // Connections
    const links = parseLinks(snap.workflow);
    const incoming = links.filter((l) => String(l.target_id) === String(selectedNode.id));
    const outgoing = links.filter((l) => String(l.origin_id) === String(selectedNode.id));
    if (incoming.length > 0 || outgoing.length > 0) {
        const cSec = document.createElement("div");
        cSec.className = "insp-section";
        const ct = document.createElement("div");
        ct.className = "insp-section-title";
        ct.textContent = "Connections";
        cSec.appendChild(ct);

        const nodeById = new Map(nodes.map((n) => [String(n.id), n]));
        for (const l of incoming) {
            const src = nodeById.get(String(l.origin_id));
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "insp-conn-btn";
            btn.addEventListener("click", () => centerOnNode(l.origin_id));
            const left = document.createElement("span");
            left.textContent = `← ${src ? getNodeTitle(src, snap.node_meta) : "#" + l.origin_id}`;
            const right = document.createElement("span");
            right.className = "muted-meta";
            right.textContent = l.type || "";
            btn.append(left, right);
            cSec.appendChild(btn);
        }
        for (const l of outgoing) {
            const dst = nodeById.get(String(l.target_id));
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "insp-conn-btn";
            btn.addEventListener("click", () => centerOnNode(l.target_id));
            const left = document.createElement("span");
            left.textContent = `→ ${dst ? getNodeTitle(dst, snap.node_meta) : "#" + l.target_id}`;
            const right = document.createElement("span");
            right.className = "muted-meta";
            right.textContent = l.type || "";
            btn.append(left, right);
            cSec.appendChild(btn);
        }
        el.inspectorBody.appendChild(cSec);
    }
}

// Grid Overview rendering
function renderGridLayout() {
    el.gridContainer.innerHTML = "";
    const activeUsers = state.users.filter((u) => u.online || u.has_workflow);
    const list = activeUsers.length > 0 ? activeUsers : state.users;

    if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-card";
        empty.style.margin = "40px auto";
        empty.innerHTML = "<h3>No active users yet</h3><p>When users open ComfyUI, their live workflows will appear here in real time.</p>";
        el.gridContainer.appendChild(empty);
        return;
    }

    for (const user of list) {
        const card = document.createElement("div");
        card.className = "grid-card" + (user.running ? " running" : "");
        card.dataset.userId = user.user_id;
        card.addEventListener("click", () => {
            setMode("focus");
            selectUser(user.user_id);
        });

        const header = document.createElement("div");
        header.className = "grid-card-header";

        const nameWrap = document.createElement("div");
        nameWrap.className = "user-name-wrap";
        const dot = document.createElement("span");
        dot.className = "status-dot" + (user.running ? " running" : user.online ? " online" : "");
        const name = document.createElement("span");
        name.className = "user-name";
        name.textContent = user.username;
        nameWrap.append(dot, name);

        const badge = document.createElement("span");
        badge.className = user.running ? "badge badge-running" : "badge badge-neutral";
        badge.textContent = user.running
            ? (user.progress?.max ? `${user.progress.value}/${user.progress.max}` : "Running")
            : user.online ? "Live" : "Offline";
        header.append(nameWrap, badge);

        const wrap = document.createElement("div");
        wrap.className = "grid-card-canvas-wrap";
        const miniCanvas = document.createElement("canvas");
        miniCanvas.className = "grid-card-canvas";
        miniCanvas.dataset.userId = user.user_id;
        wrap.appendChild(miniCanvas);

        const footer = document.createElement("div");
        footer.className = "grid-card-footer";
        const wf = document.createElement("span");
        wf.className = "workflow-name";
        wf.textContent = user.workflow_name || "Empty canvas";
        const count = document.createElement("span");
        count.className = "muted-meta";
        count.textContent = `${user.node_count} nodes`;
        footer.append(wf, count);

        card.append(header, wrap, footer);
        el.gridContainer.appendChild(card);
    }
    requestRender();
}

function renderGridCanvases() {
    const canvases = el.gridContainer.querySelectorAll("canvas.grid-card-canvas");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    for (const c of canvases) {
        const uid = c.dataset.userId;
        const rect = c.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
            c.width = Math.floor(w * dpr);
            c.height = Math.floor(h * dpr);
        }
        const mctx = c.getContext("2d");
        mctx.save();
        mctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const snap = state.snapshotsByUser.get(uid);
        if (snap?.workflow?.nodes?.length) {
            const b = computeWorkflowBounds(snap.workflow);
            const bw = Math.max(b.maxX - b.minX, 200);
            const bh = Math.max(b.maxY - b.minY, 150);
            const pad = 20;
            const scale = Math.max(0.05, Math.min(0.8, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
            const cam = {
                scale,
                x: (w - bw * scale) / 2 - b.minX * scale,
                y: (h - bh * scale) / 2 - b.minY * scale,
            };
            renderWorkflowToCanvas(mctx, w, h, snap, cam, { mini: true });
        } else {
            mctx.fillStyle = "#111318";
            mctx.fillRect(0, 0, w, h);
            mctx.fillStyle = "#6c758a";
            mctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
            mctx.textAlign = "center";
            mctx.textBaseline = "middle";
            mctx.fillText("No workflow yet", w / 2, h / 2);
        }
        mctx.restore();
    }
}

// Subscriptions & Navigation
function sendWsSubscribe() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (state.mode === "grid") {
        state.ws.send(JSON.stringify({ type: "subscribe", mode: "grid" }));
    } else if (state.selectedUserId) {
        state.ws.send(JSON.stringify({
            type: "subscribe",
            mode: "focus",
            user_id: state.selectedUserId,
            session_id: state.selectedSessionId,
        }));
    }
}

async function fetchSavedWorkflows(userId) {
    try {
        const data = await apiFetchJson(`/live-view/api/users/${encodeURIComponent(userId)}/workflows`);
        if (state.selectedUserId === userId) {
            state.savedWorkflows = Array.isArray(data.workflows) ? data.workflows : [];
            renderSavedWorkflowsList();
        }
    } catch {
        state.savedWorkflows = [];
        renderSavedWorkflowsList();
    }
}

function sendObserverCursor(gx, gy, force = false) {
    if (
        !state.shareCursor ||
        state.mode !== "focus" ||
        state.viewingSavedPath ||
        !state.selectedUserId ||
        !state.ws ||
        state.ws.readyState !== WebSocket.OPEN
    ) {
        return;
    }
    const now = Date.now();
    if (!force && now - state.lastCursorSentAt < CURSOR_SEND_INTERVAL_MS) return;
    state.lastCursorSentAt = now;
    state.cursorCurrentlyShown = true;
    try {
        state.ws.send(JSON.stringify({
            type: "cursor",
            user_id: state.selectedUserId,
            session_id: state.selectedSessionId,
            visible: true,
            x: Math.round(gx * 10) / 10,
            y: Math.round(gy * 10) / 10,
        }));
    } catch {
        // Ignore send errors.
    }
}

function hideObserverCursor() {
    state.observerCursorGraphPos = null;
    if (state.cursorCurrentlyShown && state.ws && state.ws.readyState === WebSocket.OPEN) {
        try {
            state.ws.send('{"type":"cursor","visible":false}');
        } catch {
            // Ignore send errors.
        }
    }
    state.cursorCurrentlyShown = false;
}

function setShareCursor(enabled) {
    state.shareCursor = Boolean(enabled);
    el.btnShareCursor.classList.toggle("cursor-active", state.shareCursor);
    el.btnShareCursorLabel.textContent = state.shareCursor ? "Cursor: ON" : "Show My Cursor";
    if (!state.shareCursor) {
        hideObserverCursor();
    } else if (state.observerCursorGraphPos) {
        sendObserverCursor(state.observerCursorGraphPos.x, state.observerCursorGraphPos.y, true);
    }
    requestRender();
}

async function loadSavedWorkflow(userId, relPath) {
    try {
        const encodedPath = relPath.split("/").map(encodeURIComponent).join("/");
        const data = await apiFetchJson(`/live-view/api/users/${encodeURIComponent(userId)}/workflow/${encodedPath}`);
        if (state.selectedUserId !== userId) return;
        hideObserverCursor();
        state.viewingSavedPath = relPath;
        state.selectedNodeId = null;
        state.followCamera = false;
        el.btnFollow.classList.remove("active");

        const existing = state.snapshotsByUser.get(userId);
        state.snapshotsByUser.set(userId, {
            ...(existing || { user_id: userId, username: userId, online: false }),
            workflow_name: relPath,
            workflow: data.workflow,
            node_meta: {},
            execution: null,
        });

        el.savedBannerText.textContent = `Viewing saved workflow: ${relPath} (Read-Only)`;
        el.savedBanner.classList.remove("hidden");
        renderSavedWorkflowsList();
        renderActiveUserBar();
        fitWorkflowInView();
        renderInspector();
    } catch {
        // Ignore missing/unreadable workflow.
    }
}

function returnToLiveView() {
    state.viewingSavedPath = null;
    state.selectedNodeId = null;
    el.savedBanner.classList.add("hidden");
    renderSavedWorkflowsList();
    sendWsSubscribe();
    renderActiveUserBar();
    renderInspector();
    requestRender();
}

function selectUser(userId, sessionId = null) {
    const changedUser = state.selectedUserId !== userId;
    if (changedUser || state.selectedSessionId !== sessionId) {
        hideObserverCursor();
    }
    state.selectedUserId = userId;
    state.selectedSessionId = sessionId;
    state.viewingSavedPath = null;
    state.selectedNodeId = null;
    el.savedBanner.classList.add("hidden");

    if (state.mode !== "focus") {
        setMode("focus", false);
    }

    sendWsSubscribe();
    renderUsersSidebar();
    renderActiveUserBar();
    renderInspector();

    if (changedUser) {
        fetchSavedWorkflows(userId);
    }
    const snap = getActiveSnapshot();
    if (snap?.workflow) {
        fitWorkflowInView(snap);
    } else {
        requestRender();
    }
}

function setMode(mode, notify = true) {
    state.mode = mode;
    el.btnModeFocus.classList.toggle("active", mode === "focus");
    el.btnModeGrid.classList.toggle("active", mode === "grid");
    el.focusControls.classList.toggle("hidden", mode !== "focus");
    el.focusStage.classList.toggle("hidden", mode !== "focus");
    el.gridStage.classList.toggle("hidden", mode !== "grid");

    if (mode === "grid") {
        hideObserverCursor();
        el.activeUserBar.classList.add("hidden");
        el.savedBanner.classList.add("hidden");
        renderGridLayout();
    } else {
        renderActiveUserBar();
        if (state.viewingSavedPath) el.savedBanner.classList.remove("hidden");
        requestRender();
    }
    if (notify) sendWsSubscribe();
}

function handleSnapshotPayload(snap, isInitial = false) {
    if (!snap || !snap.user_id) return;
    if (state.viewingSavedPath && snap.user_id === state.selectedUserId) {
        return;
    }
    const existing = state.snapshotsByUser.get(snap.user_id);
    const merged = {
        ...existing,
        ...snap,
        execution: snap.execution !== undefined ? snap.execution : existing?.execution,
    };
    state.snapshotsByUser.set(snap.user_id, merged);

    if (state.mode === "focus" && snap.user_id === state.selectedUserId) {
        if (isInitial || !state.hasUserFittedCamera.has(snap.user_id)) {
            if (merged.workflow?.nodes?.length) {
                state.hasUserFittedCamera.add(snap.user_id);
                if (state.followCamera && merged.viewport) {
                    applyUserViewport(merged.viewport);
                } else {
                    fitWorkflowInView(merged);
                }
            }
        } else if (state.followCamera && merged.viewport) {
            applyUserViewport(merged.viewport);
        }
        renderActiveUserBar();
        renderInspector();
    }
    requestRender();
}

function handleWsMessage(msg) {
    const { type, data } = msg || {};
    if (!type || !data) return;

    if (type === "init" || type === "users_summary") {
        state.multiUser = Boolean(data.multi_user);
        state.users = Array.isArray(data.users) ? data.users : [];
        state.queueRemaining = data.queue_remaining || 0;

        if (!state.selectedUserId && state.users.length > 0) {
            const firstActive = state.users.find((u) => u.running || u.online) || state.users[0];
            state.selectedUserId = firstActive.user_id;
            fetchSavedWorkflows(state.selectedUserId);
            sendWsSubscribe();
        } else if (type === "init" && state.selectedUserId) {
            sendWsSubscribe();
        }

        renderUsersSidebar();
        renderActiveUserBar();
        if (state.mode === "grid") {
            renderGridLayout();
        }
    } else if (type === "workflow_snapshot") {
        handleSnapshotPayload(data, true);
    } else if (type === "workflow_update") {
        handleSnapshotPayload(data, false);
    } else if (type === "grid_snapshots") {
        const list = Array.isArray(data.snapshots) ? data.snapshots : [];
        for (const snap of list) {
            state.snapshotsByUser.set(snap.user_id, snap);
        }
        renderGridLayout();
    } else if (type === "viewport_update") {
        const existing = state.snapshotsByUser.get(data.user_id);
        if (existing) {
            existing.viewport = data.viewport;
            if (
                state.mode === "focus" &&
                data.user_id === state.selectedUserId &&
                !state.viewingSavedPath
            ) {
                if (state.followCamera) {
                    applyUserViewport(data.viewport);
                } else if (state.shareCursor) {
                    requestRender();
                }
            }
        }
    } else if (type === "user_cursor_update") {
        state.userCursorsByUser.set(data.user_id, data.cursor);
        if (state.mode === "focus" && data.user_id === state.selectedUserId && !state.viewingSavedPath) {
            requestRender();
        }
    } else if (type === "execution_update") {
        const existing = state.snapshotsByUser.get(data.user_id) || { user_id: data.user_id };
        existing.execution = data.execution;
        state.snapshotsByUser.set(data.user_id, existing);

        if (state.mode === "focus" && data.user_id === state.selectedUserId && !state.viewingSavedPath) {
            renderActiveUserBar();
            renderInspector();
        }
        requestRender();
    } else if (type === "preview_update") {
        const existing = state.snapshotsByUser.get(data.user_id) || { user_id: data.user_id };
        if (!existing.execution) existing.execution = {};
        existing.execution.preview = data.preview;
        state.snapshotsByUser.set(data.user_id, existing);

        if (state.mode === "focus" && data.user_id === state.selectedUserId && !state.viewingSavedPath) {
            requestRender();
        }
    }
}

function connectObserverWs() {
    if (state.wsReconnectTimer) {
        clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = null;
    }
    if (state.ws) {
        try { state.ws.close(); } catch {}
        state.ws = null;
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    let url = `${proto}//${window.location.host}/live-view/ws`;
    if (state.token) {
        url += `?token=${encodeURIComponent(state.token)}`;
    }

    setConnectionUi("", "Connecting...");
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.addEventListener("open", () => {
        state.connected = true;
        state.wsReconnectDelay = 1000;
        setConnectionUi("connected", "Live");
    });

    ws.addEventListener("message", (ev) => {
        try {
            handleWsMessage(JSON.parse(ev.data));
        } catch {
            // Ignore malformed messages.
        }
    });

    ws.addEventListener("close", async (ev) => {
        const wasConnected = state.connected;
        state.connected = false;
        state.cursorCurrentlyShown = false;
        state.ws = null;
        if (ev.code === 1008 || ev.code === 4401) {
            setConnectionUi("error", "Locked");
            showAuthOverlay("Authentication required.");
            return;
        }
        if (!wasConnected) {
            try {
                const res = await fetch("/live-view/api/auth-status", { headers: getAuthHeaders() });
                if (res.ok) {
                    const status = await res.json();
                    if (status.requires_token && !status.authenticated) {
                        setConnectionUi("", "Locked");
                        showAuthOverlay("Authentication required.");
                        return;
                    }
                }
            } catch {
                // Server may be restarting; fall through to reconnect timer.
            }
        }
        setConnectionUi("error", "Reconnecting...");
        state.wsReconnectTimer = setTimeout(() => {
            state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 1.5, 8000);
            connectObserverWs();
        }, state.wsReconnectDelay);
    });

    ws.addEventListener("error", () => {
        try { ws.close(); } catch {}
    });
}

async function fetchObjectInfoFallback() {
    try {
        const res = await fetch("/api/object_info");
        if (res.ok) {
            state.objectInfo = await res.json();
            requestRender();
            renderInspector();
        }
    } catch {
        // Optional fallback only.
    }
}

async function checkAuthAndStart() {
    // Check ?token= URL query parameter once, then strip it from address bar.
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
        state.token = urlToken.trim();
        try { sessionStorage.setItem(TOKEN_STORAGE_KEY, state.token); } catch {}
        params.delete("token");
        const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
        window.history.replaceState({}, "", cleanUrl);
    } else {
        try { state.token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || ""; } catch {}
    }

    try {
        const res = await fetch("/live-view/api/auth-status", { headers: getAuthHeaders() });
        const status = await res.json();
        state.requiresToken = Boolean(status.requires_token);
        state.multiUser = Boolean(status.multi_user);
        el.btnLogout.classList.toggle("hidden", !state.requiresToken);

        if (state.requiresToken && !status.authenticated) {
            setConnectionUi("", "Locked");
            showAuthOverlay(state.token ? "Invalid token. Please try again." : "");
            return;
        }
        hideAuthOverlay();
        connectObserverWs();
        fetchObjectInfoFallback();
    } catch {
        setConnectionUi("error", "Server unreachable");
        setTimeout(checkAuthAndStart, 2500);
    }
}

// Canvas Pan, Zoom & Read-Only Click-to-Inspect
function bindCanvasInteractions() {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let camStartX = 0;
    let camStartY = 0;

    el.canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        camStartX = state.camera.x;
        camStartY = state.camera.y;
        el.canvas.classList.add("dragging");
        el.canvas.setPointerCapture(e.pointerId);
    });

    el.canvas.addEventListener("pointermove", (e) => {
        if (dragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                moved = true;
                if (state.followCamera) {
                    state.followCamera = false;
                    el.btnFollow.classList.remove("active");
                }
            }
            state.camera.x = camStartX + dx;
            state.camera.y = camStartY + dy;
            requestRender();
        }

        const rect = el.canvas.getBoundingClientRect();
        const gx = (e.clientX - rect.left - state.camera.x) / state.camera.scale;
        const gy = (e.clientY - rect.top - state.camera.y) / state.camera.scale;
        if (Number.isFinite(gx) && Number.isFinite(gy)) {
            state.observerCursorGraphPos = { x: gx, y: gy };
            if (state.shareCursor) {
                sendObserverCursor(gx, gy);
                if (!dragging) requestRender();
            }
        }
    });

    el.canvas.addEventListener("pointerleave", () => {
        hideObserverCursor();
        if (state.shareCursor) requestRender();
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        el.canvas.classList.remove("dragging");
        if (!moved) {
            // Hit-test node for strictly read-only inspection
            const rect = el.canvas.getBoundingClientRect();
            const gx = (e.clientX - rect.left - state.camera.x) / state.camera.scale;
            const gy = (e.clientY - rect.top - state.camera.y) / state.camera.scale;
            let hitId = null;
            for (const [nid, box] of state.nodeLayoutCache.entries()) {
                if (gx >= box.x && gx <= box.x + box.w && gy >= box.topY && gy <= box.topY + box.totalH) {
                    hitId = nid;
                }
            }
            state.selectedNodeId = hitId;
            if (hitId && el.inspector.classList.contains("collapsed")) {
                el.inspector.classList.remove("collapsed");
            }
            renderInspector();
            requestRender();
        }
    };

    el.canvas.addEventListener("pointerup", endDrag);
    el.canvas.addEventListener("pointercancel", () => {
        dragging = false;
        el.canvas.classList.remove("dragging");
    });

    el.canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (state.followCamera) {
            state.followCamera = false;
            el.btnFollow.classList.remove("active");
        }
        const rect = el.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const nextScale = Math.max(0.08, Math.min(3.5, state.camera.scale * factor));
        const ratio = nextScale / state.camera.scale;
        state.camera.x = mx - (mx - state.camera.x) * ratio;
        state.camera.y = my - (my - state.camera.y) * ratio;
        state.camera.scale = nextScale;
        if (state.shareCursor) {
            const gx = (mx - state.camera.x) / state.camera.scale;
            const gy = (my - state.camera.y) / state.camera.scale;
            state.observerCursorGraphPos = { x: gx, y: gy };
            sendObserverCursor(gx, gy, true);
        }
        requestRender();
    }, { passive: false });
}

function zoomByFactor(factor) {
    const rect = el.focusStage.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const nextScale = Math.max(0.08, Math.min(3.5, state.camera.scale * factor));
    const ratio = nextScale / state.camera.scale;
    state.camera.x = cx - (cx - state.camera.x) * ratio;
    state.camera.y = cy - (cy - state.camera.y) * ratio;
    state.camera.scale = nextScale;
    requestRender();
}

// UI event bindings
el.authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const candidate = (el.authInput.value || "").trim();
    if (!candidate) return;
    state.token = candidate;
    try {
        const res = await fetch("/live-view/api/auth-status", { headers: getAuthHeaders() });
        const status = await res.json();
        if (status.authenticated) {
            try { sessionStorage.setItem(TOKEN_STORAGE_KEY, state.token); } catch {}
            el.authInput.value = "";
            hideAuthOverlay();
            connectObserverWs();
            fetchObjectInfoFallback();
        } else {
            state.token = "";
            showAuthOverlay("Incorrect token.");
        }
    } catch {
        showAuthOverlay("Unable to reach server.");
    }
});

el.btnLogout.addEventListener("click", () => {
    state.token = "";
    try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch {}
    if (state.ws) {
        try { state.ws.close(); } catch {}
        state.ws = null;
    }
    setConnectionUi("", "Locked");
    showAuthOverlay();
});

el.btnToggleSidebar.addEventListener("click", () => {
    el.sidebar.classList.toggle("collapsed");
    requestRender();
});

el.btnToggleInspector.addEventListener("click", () => {
    el.inspector.classList.toggle("collapsed");
    requestRender();
});

el.btnCloseInspector.addEventListener("click", () => {
    el.inspector.classList.add("collapsed");
    requestRender();
});

el.btnModeFocus.addEventListener("click", () => setMode("focus"));
el.btnModeGrid.addEventListener("click", () => setMode("grid"));
el.btnFit.addEventListener("click", () => fitWorkflowInView());
el.btnZoomIn.addEventListener("click", () => zoomByFactor(1.2));
el.btnZoomOut.addEventListener("click", () => zoomByFactor(1 / 1.2));
el.btnBackLive.addEventListener("click", returnToLiveView);

el.btnShareCursor.addEventListener("click", () => {
    setShareCursor(!state.shareCursor);
});

el.btnFollow.addEventListener("click", () => {
    state.followCamera = !state.followCamera;
    el.btnFollow.classList.toggle("active", state.followCamera);
    if (state.followCamera) {
        const snap = getActiveSnapshot();
        if (snap?.viewport) applyUserViewport(snap.viewport);
    }
});

el.tabSelect.addEventListener("change", () => {
    if (!state.selectedUserId) return;
    hideObserverCursor();
    state.selectedSessionId = el.tabSelect.value || null;
    sendWsSubscribe();
});

el.userFilter.addEventListener("input", renderUsersSidebar);
el.btnRefreshSaved.addEventListener("click", () => {
    if (state.selectedUserId) fetchSavedWorkflows(state.selectedUserId);
});

el.nodeSearch.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = (el.nodeSearch.value || "").trim().toLowerCase();
    if (!q) return;
    const snap = getActiveSnapshot();
    const nodes = snap?.workflow?.nodes || [];
    const match = nodes.find((n) => {
        const title = getNodeTitle(n, snap.node_meta).toLowerCase();
        const type = String(n.type || "").toLowerCase();
        return String(n.id) === q || title.includes(q) || type.includes(q);
    });
    if (match) {
        centerOnNode(match.id);
    }
});

el.lightboxClose.addEventListener("click", () => el.lightbox.classList.add("hidden"));
el.lightbox.addEventListener("click", (e) => {
    if (e.target === el.lightbox) el.lightbox.classList.add("hidden");
});

window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "f" || e.key === "F") {
        fitWorkflowInView();
    } else if (e.key === "c" || e.key === "C") {
        if (state.mode === "focus") setShareCursor(!state.shareCursor);
    } else if (e.key === "Escape") {
        el.lightbox.classList.add("hidden");
        state.selectedNodeId = null;
        renderInspector();
        requestRender();
    }
});

window.addEventListener("resize", requestRender);

// Refresh relative timestamps every 10s
setInterval(() => {
    if (state.connected) {
        renderUsersSidebar();
        renderActiveUserBar();
    }
}, 10000);

bindCanvasInteractions();
checkAuthAndStart();
