import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MODEL_WEIGHT_EXTENSIONS = [
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pt2",
    ".bin",
    ".pth",
    ".pkl",
    ".sft",
    ".gguf",
    ".onnx",
];

const downloadsById = new Map();
let allowedFolders = new Set([
    "audio_encoders",
    "background_removal",
    "checkpoints",
    "clip_vision",
    "controlnet",
    "detection",
    "diffusion_models",
    "embeddings",
    "frame_interpolation",
    "geometry_estimation",
    "gligen",
    "hypernetworks",
    "latent_upscale_models",
    "loras",
    "model_patches",
    "optical_flow",
    "photomaker",
    "style_models",
    "text_encoders",
    "upscale_models",
    "vae",
    "vae_approx",
]);
let folderAliases = {
    unet: "diffusion_models",
    clip: "text_encoders",
    t2i_adapter: "controlnet",
};
let serverOffline = false;
let panelRoot = null;
let panelList = null;
let panelTitle = null;
let pollTimer = null;
let refreshTimer = null;

function normalizeModelUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
    try {
        const parsed = new URL(rawUrl.trim(), window.location.href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
        return `${parsed.protocol}//${parsed.host.toLowerCase()}${decodeURIComponent(parsed.pathname)}`;
    } catch {
        return "";
    }
}

function getUrlBasename(rawUrl) {
    try {
        const parsed = new URL(rawUrl, window.location.href);
        const segs = decodeURIComponent(parsed.pathname || "").split("/").filter(Boolean);
        return segs.length > 0 ? segs[segs.length - 1] : "";
    } catch {
        return "";
    }
}

function hasModelWeightExtension(name) {
    const lower = (name || "").toLowerCase();
    return MODEL_WEIGHT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function normalizeFolderName(rawDir) {
    if (typeof rawDir !== "string") return "";
    let cleaned = rawDir.trim().replace(/^\/+|\/+$/g, "");
    if (cleaned.startsWith("models/")) {
        cleaned = cleaned.slice("models/".length);
    }
    if (folderAliases[cleaned]) {
        cleaned = folderAliases[cleaned];
    }
    return allowedFolders.has(cleaned) ? cleaned : "";
}

function collectWorkflowModels() {
    const byUrl = new Map();
    const byName = new Map();
    const visitedGraphs = new Set();

    const recordModel = (entry) => {
        if (!entry || typeof entry !== "object") return;
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        const directory = normalizeFolderName(entry.directory || entry.folder || "");
        if (!url || !directory) return;

        const record = {
            url,
            name: name || getUrlBasename(url),
            directory,
        };
        const normUrl = normalizeModelUrl(url);
        if (normUrl) byUrl.set(normUrl, record);
        if (record.name) {
            const base = record.name.replace(/\\/g, "/").split("/").pop().toLowerCase();
            if (base && !byName.has(base)) {
                byName.set(base, record);
            }
        }
    };

    const walkGraph = (graph) => {
        if (!graph || typeof graph !== "object" || visitedGraphs.has(graph)) return;
        visitedGraphs.add(graph);

        const nodes = Array.isArray(graph._nodes)
            ? graph._nodes
            : Array.isArray(graph.nodes)
                ? graph.nodes
                : [];
        for (const node of nodes) {
            if (!node || typeof node !== "object") continue;
            const models = node.properties?.models;
            if (Array.isArray(models)) {
                for (const m of models) recordModel(m);
            }
            if (node.subgraph) walkGraph(node.subgraph);
        }

        for (const subContainer of [graph.subgraphs, graph._subgraphs]) {
            if (!subContainer) continue;
            const subList = subContainer instanceof Map
                ? Array.from(subContainer.values())
                : Array.isArray(subContainer)
                    ? subContainer
                    : Object.values(subContainer);
            for (const sg of subList) walkGraph(sg);
        }

        const defSubgraphs = graph.definitions?.subgraphs;
        if (Array.isArray(defSubgraphs)) {
            for (const sg of defSubgraphs) walkGraph(sg);
        }
    };

    try {
        walkGraph(app?.rootGraph);
        walkGraph(app?.graph);
        walkGraph(app?.canvas?.graph);
    } catch {
        // Ignore transient graph state during startup.
    }

    return { byUrl, byName };
}

function inferModelFromUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
    try {
        const parsed = new URL(rawUrl.trim(), window.location.href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        if (parsed.origin === window.location.origin) return null;

        const host = parsed.hostname.toLowerCase();
        const isHfFile =
            (host === "huggingface.co" || host.endsWith(".huggingface.co")) &&
            parsed.pathname.includes("/resolve/");
        if (!isHfFile) return null;

        const segments = decodeURIComponent(parsed.pathname).split("/").filter(Boolean);
        const filename = segments[segments.length - 1] || "";
        if (!hasModelWeightExtension(filename)) return null;

        for (let i = segments.length - 2; i >= 0; i--) {
            const dir = normalizeFolderName(segments[i]);
            if (dir) {
                return { url: rawUrl.trim(), name: filename, directory: dir };
            }
        }
    } catch {
        return null;
    }
    return null;
}

function matchDownloadTarget(rawUrl) {
    if (serverOffline) return null;
    const normUrl = normalizeModelUrl(rawUrl);
    if (!normUrl) return null;

    const { byUrl, byName } = collectWorkflowModels();
    if (byUrl.has(normUrl)) {
        return byUrl.get(normUrl);
    }

    const base = getUrlBasename(rawUrl).toLowerCase();
    if (base && hasModelWeightExtension(base) && byName.has(base)) {
        const matched = byName.get(base);
        return {
            url: rawUrl.trim(),
            name: matched.name,
            directory: matched.directory,
        };
    }

    return inferModelFromUrl(rawUrl);
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
        val /= 1024;
        idx += 1;
    }
    return `${val.toFixed(idx >= 2 ? 1 : 0)} ${units[idx]}`;
}

function showToast(severity, summary, detail) {
    try {
        const toast = app?.extensionManager?.toast;
        if (toast && typeof toast.add === "function") {
            toast.add({ severity, summary, detail, life: 5000 });
        }
    } catch {
        // Toast API is optional across frontend builds.
    }
}

function ensurePanel() {
    if (panelRoot) return;

    const style = document.createElement("style");
    style.id = "comfy-server-model-downloader-style";
    style.textContent = `
        #comfy-model-dl-panel {
            position: fixed;
            right: 16px;
            bottom: 16px;
            width: 360px;
            max-width: calc(100vw - 32px);
            max-height: 55vh;
            display: none;
            flex-direction: column;
            border-radius: 10px;
            background: var(--comfy-menu-bg, #1b1e27);
            color: var(--fg-color, #e5e7eb);
            border: 1px solid var(--border-color, #334155);
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12px;
            z-index: 2147483000;
            overflow: hidden;
        }
        #comfy-model-dl-panel.visible { display: flex; }
        .comfy-mdl-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 9px 12px;
            border-bottom: 1px solid var(--border-color, #334155);
            font-weight: 600;
        }
        .comfy-mdl-head-actions { display: flex; gap: 6px; }
        .comfy-mdl-btn {
            border: 1px solid var(--border-color, #475569);
            background: transparent;
            color: inherit;
            border-radius: 5px;
            padding: 2px 7px;
            font-size: 11px;
            cursor: pointer;
        }
        .comfy-mdl-btn:hover { background: rgba(148, 163, 184, 0.16); }
        .comfy-mdl-list {
            overflow-y: auto;
            padding: 8px 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .comfy-mdl-row {
            padding: 8px 9px;
            border-radius: 7px;
            border: 1px solid var(--border-color, #334155);
            background: rgba(148, 163, 184, 0.08);
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .comfy-mdl-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        .comfy-mdl-name {
            font-weight: 600;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .comfy-mdl-path {
            font-size: 11px;
            opacity: 0.72;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .comfy-mdl-bar-track {
            height: 6px;
            border-radius: 999px;
            background: rgba(148, 163, 184, 0.22);
            overflow: hidden;
        }
        .comfy-mdl-bar-fill {
            height: 100%;
            background: #2563eb;
            transition: width 0.2s linear;
        }
        .comfy-mdl-bar-fill.done { background: #16a34a; }
        .comfy-mdl-bar-fill.err { background: #dc2626; }
        .comfy-mdl-meta {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 11px;
            opacity: 0.85;
        }
        .comfy-mdl-err {
            color: var(--error-text, #ef4444);
            font-size: 11px;
            word-break: break-word;
        }
    `;
    document.head.appendChild(style);

    panelRoot = document.createElement("div");
    panelRoot.id = "comfy-model-dl-panel";

    const head = document.createElement("div");
    head.className = "comfy-mdl-head";

    panelTitle = document.createElement("span");
    panelTitle.textContent = "Server Model Downloads";

    const actions = document.createElement("div");
    actions.className = "comfy-mdl-head-actions";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "comfy-mdl-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", async () => {
        try {
            await fetch("/api/model-downloader/clear", { method: "POST" });
        } catch {}
        for (const [id, item] of downloadsById.entries()) {
            if (item.status !== "queued" && item.status !== "downloading") {
                downloadsById.delete(id);
            }
        }
        renderPanel();
    });

    actions.appendChild(clearBtn);
    head.append(panelTitle, actions);

    panelList = document.createElement("div");
    panelList.className = "comfy-mdl-list";

    panelRoot.append(head, panelList);
    document.body.appendChild(panelRoot);
}

function renderPanel() {
    ensurePanel();
    const items = Array.from(downloadsById.values()).sort(
        (a, b) => (b.created_at || 0) - (a.created_at || 0)
    );

    if (items.length === 0) {
        panelRoot.classList.remove("visible");
        stopStatusPolling();
        return;
    }

    panelRoot.classList.add("visible");
    const activeCount = items.filter(
        (i) => i.status === "queued" || i.status === "downloading"
    ).length;
    panelTitle.textContent =
        activeCount > 0
            ? `Downloading to Server (${activeCount})`
            : "Server Model Downloads";

    if (activeCount > 0) {
        startStatusPolling();
    } else {
        stopStatusPolling();
    }

    panelList.innerHTML = "";
    for (const item of items) {
        const row = document.createElement("div");
        row.className = "comfy-mdl-row";

        const top = document.createElement("div");
        top.className = "comfy-mdl-top";

        const nameEl = document.createElement("span");
        nameEl.className = "comfy-mdl-name";
        nameEl.title = item.filename;
        nameEl.textContent = item.filename;
        top.appendChild(nameEl);

        if (item.status === "queued" || item.status === "downloading") {
            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "comfy-mdl-btn";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", () => cancelServerDownload(item.id));
            top.appendChild(cancelBtn);
        } else if (item.status === "error") {
            const openBtn = document.createElement("button");
            openBtn.type = "button";
            openBtn.className = "comfy-mdl-btn";
            openBtn.textContent = "Open URL";
            openBtn.title = "Open the download URL in a browser tab";
            openBtn.addEventListener("click", () => {
                const a = document.createElement("a");
                a.href = item.url;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.dataset.comfyDirectBrowser = "1";
                a.click();
            });
            top.appendChild(openBtn);
        }

        const pathEl = document.createElement("div");
        pathEl.className = "comfy-mdl-path";
        pathEl.textContent = item.saved_path || `models/${item.directory}/${item.filename}`;

        const track = document.createElement("div");
        track.className = "comfy-mdl-bar-track";
        const fill = document.createElement("div");
        fill.className =
            "comfy-mdl-bar-fill" +
            (item.status === "completed" ? " done" : item.status === "error" ? " err" : "");
        const pct = item.status === "completed" ? 100 : Math.max(0, Math.min(100, item.percent || 0));
        fill.style.width = `${pct}%`;
        track.appendChild(fill);

        const meta = document.createElement("div");
        meta.className = "comfy-mdl-meta";

        const left = document.createElement("span");
        const right = document.createElement("span");
        if (item.status === "queued") {
            left.textContent = "Queued on server...";
        } else if (item.status === "downloading") {
            left.textContent =
                item.total_bytes > 0
                    ? `${formatBytes(item.downloaded_bytes)} / ${formatBytes(item.total_bytes)} (${pct.toFixed(1)}%)`
                    : `${formatBytes(item.downloaded_bytes)} downloaded`;
            if (item.speed_bps > 0) {
                right.textContent = `${formatBytes(item.speed_bps)}/s`;
            }
        } else if (item.status === "completed") {
            left.textContent = item.already_exists
                ? "Already on server"
                : `Saved (${formatBytes(item.downloaded_bytes || item.total_bytes)})`;
            right.textContent = "Done";
        } else if (item.status === "cancelled") {
            left.textContent = "Cancelled";
        } else {
            left.textContent = "Failed";
        }
        meta.append(left, right);

        row.append(top, pathEl, track, meta);
        if (item.status === "error" && item.error) {
            const errEl = document.createElement("div");
            errEl.className = "comfy-mdl-err";
            errEl.textContent = item.error;
            row.appendChild(errEl);
        }
        panelList.appendChild(row);
    }
}

function scheduleModelRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        refreshTimer = null;
        try {
            const cmd = app?.extensionManager?.command;
            if (cmd && typeof cmd.execute === "function") {
                await cmd.execute("Comfy.RefreshNodeDefinitions");
                return;
            }
        } catch {
            // Fall through to refreshComboInNodes.
        }
        try {
            if (typeof app?.refreshComboInNodes === "function") {
                await app.refreshComboInNodes();
            }
        } catch {
            // Ignore if graph is not ready.
        }
    }, 350);
}

function upsertTask(task) {
    if (!task || !task.id) return;
    const prev = downloadsById.get(task.id);
    downloadsById.set(task.id, task);

    if (task.status === "completed" && prev?.status !== "completed") {
        showToast(
            "success",
            task.already_exists ? "Model already on server" : "Model downloaded to server",
            task.saved_path || `${task.directory}/${task.filename}`
        );
        scheduleModelRefresh();
    } else if (task.status === "error" && prev?.status !== "error") {
        showToast("error", "Server model download failed", `${task.filename}: ${task.error || "Unknown error"}`);
    }
    renderPanel();
}

async function startServerDownload(model) {
    try {
        const res = await fetch("/api/model-downloader/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: model.url,
                directory: model.directory,
                filename: model.name,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast("error", "Model download rejected", data.error || `HTTP ${res.status}`);
            return;
        }
        upsertTask(data);
        if (data.status === "queued" || data.status === "downloading") {
            showToast(
                "info",
                "Downloading directly to server",
                `${data.saved_path || model.name}`
            );
        }
    } catch (err) {
        showToast("error", "Model download request failed", String(err));
    }
}

async function cancelServerDownload(id) {
    try {
        const res = await fetch("/api/model-downloader/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
        });
        if (res.ok) {
            const data = await res.json();
            upsertTask(data);
        }
    } catch {}
}

async function syncStatusFromServer() {
    try {
        const res = await fetch("/api/model-downloader/status");
        if (!res.ok) return;
        const data = await res.json();
        serverOffline = Boolean(data.offline);
        if (Array.isArray(data.downloads)) {
            for (const item of data.downloads) {
                upsertTask(item);
            }
        }
    } catch {}
}

function startStatusPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(syncStatusFromServer, 2000);
}

function stopStatusPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
}

function installDownloadInterceptors() {
    if (window.__comfyServerModelDownloaderInstalled) return;
    window.__comfyServerModelDownloaderInstalled = true;

    // 1. Intercept programmatic <a download>.click() calls (used by ComfyUI's downloadFile utility).
    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (...args) {
        try {
            if (this.dataset?.comfyDirectBrowser !== "1") {
                const href = this.getAttribute("href") || this.href || "";
                const matched = matchDownloadTarget(href);
                if (matched) {
                    startServerDownload(matched);
                    return;
                }
            }
        } catch {}
        return origAnchorClick.apply(this, args);
    };

    // 2. Intercept window.open(url) when pointing to a workflow model weight download URL.
    const origWindowOpen = window.open;
    window.open = function (url, ...rest) {
        try {
            if (typeof url === "string") {
                const matched = matchDownloadTarget(url);
                if (matched) {
                    startServerDownload(matched);
                    return null;
                }
            }
        } catch {}
        return origWindowOpen.call(this, url, ...rest);
    };

    // 3. Intercept direct clicks on rendered <a href="..."> links inside Issues / Missing Models UI.
    document.addEventListener(
        "click",
        (event) => {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }
            const anchor = event.target?.closest?.("a[href]");
            if (!anchor || anchor.dataset?.comfyDirectBrowser === "1") return;

            const href = anchor.getAttribute("href") || anchor.href || "";
            const matched = matchDownloadTarget(href);
            if (!matched) return;

            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") {
                event.stopImmediatePropagation();
            }
            startServerDownload(matched);
        },
        true
    );
}

async function initServerModelDownloader() {
    installDownloadInterceptors();

    try {
        const res = await fetch("/api/model-downloader/folders");
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.folders)) {
                allowedFolders = new Set(data.folders);
            }
            if (data.aliases && typeof data.aliases === "object") {
                folderAliases = data.aliases;
            }
            serverOffline = Boolean(data.offline);
        }
    } catch {}

    try {
        api.addEventListener("model_download_progress", (event) => {
            if (event?.detail) {
                upsertTask(event.detail);
            }
        });
    } catch {}

    await syncStatusFromServer();
}

app.registerExtension({
    name: "Comfy.ServerModelDownloader",
    async setup() {
        await initServerModelDownloader();
    },
});
