/**
 * Lore Spoilers · Selective Edition
 * Based on the UI-only visibility approach of cha1latte/lore-spoilers (MIT).
 * Key difference: individual entry flags persist inside lorebook metadata.
 *
 * This extension DOES NOT encrypt or remove any content; it does not affect
 * prompt generation or defend against editing/exporting/inspecting the files.
 */
import { extension_settings, extensionNames } from "../../../extensions.js";
import { publishCard, auditPublishedCard } from "./publisher.js?v=2.0.5";
import { readPngCard, writePngCard } from "./png-card.js?v=2.0.5";
import { saveSettingsDebounced, characters, this_chid, getRequestHeaders } from "../../../../script.js";
import { loadWorldInfo, saveWorldInfo, world_names } from "../../../world-info.js";

const EXT = "spoilers-is-unavailable"; // distinct from earlier ZIP installation
const SETTINGS_HTML_URL = new URL("./example.html", import.meta.url).href;
const FIELD = "lore_spoilers_visibility";
const HIDDEN = "hidden";
const PUBLIC = "public";
const DEFAULTS = { enabled: true, authorMode: true };

let currentBook = "";
let currentData = null;
let refreshTimer = null;
let syncing = false;
let waiting = false;
let search = "";
let noticeShown = false;
let lastSyncedBook = null;

function settings() {
    extension_settings[EXT] ??= {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (typeof extension_settings[EXT][key] !== typeof value) {
            extension_settings[EXT][key] = value;
        }
    }
    return extension_settings[EXT];
}

function bookName() {
    const value = document.querySelector("#world_editor_select")?.value;
    if (value === undefined || value === "") return "";
    const index = Number(value);
    return Number.isInteger(index) && Array.isArray(world_names) ? (world_names[index] || "") : "";
}

function isHidden(entry) {
    return entry?.extensions?.[FIELD] === HIDDEN;
}

function titleFor(entry) {
    const text = String(entry?.comment || "").trim()
        || (Array.isArray(entry?.key) ? entry.key.join(", ") : String(entry?.key || "")).trim()
        || "(未命名条目)";
    return text.length > 170 ? text.slice(0, 170) + "…" : text;
}

function setModeClass() {
    const s = settings();
    document.documentElement.classList.toggle("lsp-viewer-mode", s.enabled && !s.authorMode);
    document.querySelector("#lsp_author_mode")?.toggleAttribute("data-active", s.authorMode);
}

function notify(message, type = "info") {
    if (window.toastr?.[type]) {
        window.toastr[type](message, "世界书逐条权限");
    } else {
        console.info("[lore-spoilers-selective]", message);
    }
}

function createSelect(value, className, uid) {
    const select = document.createElement("select");
    select.className = className;
    select.dataset.uid = String(uid);
    const publicOption = new Option("🌐 公开", PUBLIC);
    const hiddenOption = new Option("🔒 隐藏 · AI可读", HIDDEN);
    select.add(publicOption);
    select.add(hiddenOption);
    select.value = value;
    select.title = "作者端标记，发布时将隐藏正文移至角色正则。不是加密。";
    return select;
}

function renderInlineEntry(entryEl, entry, authorMode) {
    const hidden = isHidden(entry);
    entryEl.classList.toggle("lsp-private", hidden);
    entryEl.classList.add("lsp-checked");

    const old = entryEl.querySelector(".lsp-inline-toggle");
    if (!authorMode) {
        old?.remove();
        return;
    }

    const uid = String(entry.uid);
    let slot = old;
    if (!slot) {
        slot = document.createElement("label");
        slot.className = "lsp-inline-toggle";
        const marker = document.createElement("span");
        marker.textContent = "玩家可见性";
        slot.append(marker, createSelect(hidden ? HIDDEN : PUBLIC, "lsp-inline-select", uid));
        const header = entryEl.querySelector(".world_entry_form_header")
            || entryEl.querySelector(".world_entry_form_control")
            || entryEl;
        header.appendChild(slot);
    }
    const select = slot.querySelector("select");
    if (select && document.activeElement !== select) select.value = hidden ? HIDDEN : PUBLIC;
}

function renderEntryList(data) {
    const list = document.querySelector("#world_popup_entries_list");
    if (!list) return;

    const authorMode = settings().enabled && settings().authorMode;
    for (const item of list.querySelectorAll(".world_entry[uid]")) {
        const uid = item.getAttribute("uid");
        const entry = data?.entries?.[uid];
        if (entry) {
            renderInlineEntry(item, entry, authorMode);
        } else {
            // Cannot classify an entry: hide by default in viewer mode.
            item.classList.remove("lsp-checked");
        }
    }
}

function buildToolbar(book, data) {
    const list = document.querySelector("#world_popup_entries_list");
    if (!list?.parentElement) return;
    let panel = document.getElementById("lsp_world_toolbar");
    const show = settings().enabled && settings().authorMode && Boolean(book);
    if (!show) {
        panel?.remove();
        return;
    }
    if (!panel) {
        panel = document.createElement("section");
        panel.id = "lsp_world_toolbar";
        panel.className = "lsp-toolbar";
        list.parentElement.insertBefore(panel, list);
    }

    // Rebuilding is harmless: toolbar is outside the observed entries list.
    panel.replaceChildren();
    const entries = Object.values(data.entries || {}).filter(entry => entry && Number.isFinite(Number(entry.uid)));
    const hiddenCount = entries.filter(isHidden).length;

    const header = document.createElement("div");
    header.className = "lsp-toolbar-head";
    const title = document.createElement("h4");
    title.textContent = "🔐 逐条权限 — " + book + " · v2.2.0";
    const count = document.createElement("span");
    count.className = "lsp-secret-count";
    count.textContent = `${hiddenCount} 隐藏 / ${entries.length} 条`;
    header.append(title, count);
    panel.append(header);

    const actions = document.createElement("div");
    actions.className = "lsp-toolbar-actions";
    const actionSpecs = [
        ["公开全部", PUBLIC],
        ["隐藏全部", HIDDEN],
        ["📦 发布防剧透 PNG", "export-png"],
        ["📄 发布防剧透 JSON", "export-json"],
        ["检查发布条件", "audit"],
    ];
    for (const [label, action] of actionSpecs) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "menu_button";
        button.textContent = label;
        button.dataset.lspAction = action;
        actions.appendChild(button);
    }
    panel.append(actions);

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "lsp-search text_pole";
    searchInput.placeholder = "搜索条目标题 / UID / 触发关键词";
    searchInput.setAttribute("aria-label", "搜索世界书条目");
    searchInput.value = search;
    panel.append(searchInput);

    const caption = document.createElement("p");
    caption.className = "lsp-toolbar-caption";
    caption.textContent = "点击发布防剧透卡，将隐藏正文替换为占位符；原文由内嵌角色正则在 AI 的 WORLD_INFO 提示词阶段还原。玩家不需安装此插件，但需要授权角色正则。此方案不是加密。";
    panel.append(caption);

    const container = document.createElement("div");
    container.className = "lsp-list";
    container.dataset.book = book;
    panel.append(container);

    function renderRows() {
        container.replaceChildren();
        const needle = search.trim().toLowerCase();
        const filtered = entries.filter(entry =>
            !needle || `${entry.uid} ${entry.comment || ""} ${(entry.key || []).join?.(" ") || ""}`.toLowerCase().includes(needle)
        );
        const limit = 250;
        const fragment = document.createDocumentFragment();
        for (const entry of filtered.slice(0, limit)) {
            const row = document.createElement("div");
            row.className = "lsp-list-item";
            const label = document.createElement("div");
            label.className = "lsp-entry-title";
            label.textContent = titleFor(entry);
            const minor = document.createElement("small");
            minor.textContent = `#${entry.uid}`;
            label.appendChild(minor);
            row.append(label, createSelect(isHidden(entry) ? HIDDEN : PUBLIC, "lsp-list-select", entry.uid));
            fragment.append(row);
        }
        container.append(fragment);
        if (filtered.length > limit) {
            const note = document.createElement("div");
            note.className = "lsp-toolbar-caption";
            note.style.padding = "10px";
            note.textContent = `显示前 ${limit} / ${filtered.length} 条；请用搜索框缩小范围。`;
            container.append(note);
        }
        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.className = "lsp-toolbar-caption";
            empty.style.padding = "10px";
            empty.textContent = "没有匹配的条目。";
            container.append(empty);
        }
    }
    searchInput.addEventListener("input", () => {
        search = searchInput.value;
        renderRows();
    });
    renderRows();
}

async function sync() {
    if (syncing) {
        waiting = true;
        return;
    }
    syncing = true;
    try {
        setModeClass();
        const book = bookName();
        currentBook = book;
        if (!settings().enabled || !book) {
            document.getElementById("lsp_world_toolbar")?.remove();
            document.querySelectorAll("#world_popup_entries_list .world_entry").forEach(item => {
                item.classList.remove("lsp-private", "lsp-checked");
                item.querySelector(".lsp-inline-toggle")?.remove();
            });
            currentData = null;
            return;
        }
        const data = await loadWorldInfo(book);
        // Ignore an older asynchronous response if the editor switched books.
        if (book !== bookName()) return;
        if (!data?.entries) return;
        currentData = data;
        renderEntryList(data);
        buildToolbar(book, data);
    } catch (error) {
        console.error(`[${EXT}] sync failed`, error);
        reportPublishError(error, "同步世界书界面");
        if (!noticeShown) {
            notify("无法同步世界书视图；请检查控制台，原文可能在界面中可见。", "warning");
            noticeShown = true;
        }
    } finally {
        syncing = false;
        if (waiting) {
            waiting = false;
            scheduleSync();
        }
    }
}

function scheduleSync() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(sync, 100);
}

async function setVisibility(uid, visibility) {
    const book = bookName();
    if (!settings().enabled || !settings().authorMode || !book) return;
    const data = await loadWorldInfo(book);
    const entry = data?.entries?.[uid];
    if (!entry) {
        notify("未找到条目；请重开世界书后再试。", "warning");
        return;
    }
    entry.extensions ??= {};
    entry.extensions[FIELD] = visibility === HIDDEN ? HIDDEN : PUBLIC;

    // Also update the original character-book representation, if available,
    // so the marker survives character-card export and reimport.
    if (Array.isArray(data.originalData?.entries)) {
        const original = data.originalData.entries.find(e => String(e.id ?? e.uid) === String(uid));
        if (original) {
            original.extensions ??= {};
            original.extensions[FIELD] = entry.extensions[FIELD];
        }
    }

    await saveWorldInfo(book, data, true);
    currentData = data;
    scheduleSync();
}

async function bulkVisibility(visibility) {
    const book = bookName();
    if (!settings().enabled || !settings().authorMode || !book) return;
    const data = await loadWorldInfo(book);
    if (!data?.entries) return;
    const count = Object.keys(data.entries).length;
    const word = visibility === HIDDEN ? "隐藏" : "公开";
    if (!window.confirm(`将「${book}」中 ${count} 个条目全部设为「${word}」？此操作将修改世界书文件。`)) return;
    for (const entry of Object.values(data.entries)) {
        if (!entry) continue;
        entry.extensions ??= {};
        entry.extensions[FIELD] = visibility;
    }
    if (Array.isArray(data.originalData?.entries)) {
        for (const entry of data.originalData.entries) {
            entry.extensions ??= {};
            entry.extensions[FIELD] = visibility;
        }
    }
    await saveWorldInfo(book, data, true);
    currentData = data;
    notify(`已将 ${count} 个条目标记为「${word}」。`, "success");
    scheduleSync();
}

function audit() {
    const entries = Object.values(currentData?.entries || {});
    const hidden = entries.filter(isHidden);
    const character = characters?.[this_chid];
    const bound = character?.data?.extensions?.world || "（未绑定）";
    window.alert(
        "世界书：" + currentBook + "\n角色：" + (character?.name || "未选择") +
        "\n绑定主世界书：" + bound + "\n隐藏：" + hidden.length + " / " + entries.length +
        "\n\n发布后世界书隐藏正文变成占位符；原文保存在卡内角色正则，AI 需要玩家授权才能还原。" +
        "\n玩家无需安装此作者插件，但能从正则里提取文本。本方案不是加密。"
    );
}

function downloadFile(data, name, mime) {
    const objectUrl = URL.createObjectURL(new Blob([data], {type: mime}));
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

async function publishSelectedCharacter(format) {
    let stage = "开始发布";
    try {
    if (!settings().enabled || !settings().authorMode) throw new Error("请启用插件及作者模式");
    const book = bookName();
    if (!book) throw new Error("请先打开并选择角色绑定的主世界书");
    const character = characters?.[this_chid];
    if (!character?.avatar) throw new Error("先选中要发布的角色");
    const attached = character.data?.extensions?.world;
    if (attached && attached !== book) {
        throw new Error("角色绑定的是「" + attached + "」，当前编辑的是「" + book + "」");
    }
    stage = "读取世界书";
    const worldData = await loadWorldInfo(book);
    if (!worldData?.entries) throw new Error("世界书没有加载成功");
    const visibility = Object.fromEntries(
        Object.entries(worldData.entries).map(([uid,entry])=>[String(uid),isHidden(entry) ? HIDDEN : PUBLIC])
    );
    const hiddenCount = Object.values(visibility).filter(v=>v===HIDDEN).length;
    if (!hiddenCount) throw new Error("请先标记需要隐藏的世界书条目");
    const approved = window.confirm(
        "即将为「" + character.name + "」生成防剧透 " + format.toUpperCase() +
        "\n隐藏正文：" + hiddenCount + " 条；作者原世界书及角色卡不会被修改。" +
        "\n\n玩家无需安装本作者插件，但必须启用并授权 SillyTavern 内置角色正则，否则 AI 不能还原。" +
        "\n角色正则本身含原文，不属于加密。继续吗？"
    );
    if (!approved) return;
    // Prefer SillyTavern's native JSON export as the source of truth.
    // The PNG is used only as a visual/image carrier and is not decoded to
    // obtain its old embedded character metadata.
    stage = "从 SillyTavern 读取角色卡 JSON";
    const response = await fetch('/api/characters/export', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar, format: 'json' }),
    });
    if (!response.ok) throw new Error("读取角色 JSON 失败，HTTP " + response.status);
    stage = "解析角色卡 JSON";
    const input = await response.json();
    stage = "生成隐藏条目与还原正则";
    const {card,report} = publishCard(input, {visibilityByUid: visibility,expectedWorld:book});
    stage = "校验隐藏条目与正则规则";
    const audit = auditPublishedCard(card);
    if(!audit.ok || audit.hiddenCount!==report.hiddenCount) {
        throw new Error("发布校验失败："+audit.issues.join("；"));
    }
    const safe = String(character.name || "Character").replace(/[\\/:*?"<>|]/g,"_").slice(0,72);
    if(format==="png") {
        stage = "向 SillyTavern 请求角色图片 PNG";
        const pngResponse = await fetch('/api/characters/export', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, format: 'png' }),
        });
        if (!pngResponse.ok) throw new Error("读取角色 PNG 失败，HTTP " + pngResponse.status);
        const original = new Uint8Array(await pngResponse.arrayBuffer());
        stage = "将防剧透内容写入 PNG";
        const image = writePngCard(original, card);
        stage = "下载防剧透 PNG";
        downloadFile(image, safe+"-防剧透版.png", "image/png");
    } else {
        stage = "下载防剧透 JSON";
        downloadFile(JSON.stringify(card,null,2),safe+"-防剧透版.json","application/json;charset=utf-8");
    }
    notify("成功导出【"+report.world+"】：隐藏 "+report.hiddenCount+" 条"
      +(report.skippedEmptyCount?"，跳过 "+report.skippedEmptyCount+" 条空白正文":"")
      +"。原文件未修改。","success");
    } catch(error) {
        const original = error instanceof Error ? error : new Error(String(error));
        const wrapped = new Error("[" + stage + "] " + original.message, { cause: original });
        wrapped.lspStage = stage;
        throw wrapped;
    }
}

function reportPublishError(error, operation = "发布角色卡") {
    // Keep diagnostics outside #lsp_world_toolbar: buildToolbar replaces its children.
    const stack = String(error?.cause?.stack || error?.stack || "(无法获取调用栈)");
    const message = String(error?.message || error);
    const diagnostics = [
        "Lore Spoilers v2.2.0 错误诊断",
        "操作：" + operation,
        "阶段：" + (error?.lspStage || "未进入导出阶段 / 其他操作"),
        "信息：" + message,
        "时间：" + new Date().toLocaleString(),
        "",
        "错误调用堆栈：",
        stack,
        "",
        "复制本报告以定位问题。无需提供任何世界书正文。"
    ].join("\n");
    console.error("[Lore Spoilers diagnostic]", diagnostics, error);
    try {
        let overlay = document.getElementById("lsp_fatal_diagnostic");
        if (!overlay) {
            overlay = document.createElement("section");
            overlay.id = "lsp_fatal_diagnostic";
            overlay.setAttribute("role", "alert");
            overlay.style.cssText = [
                "position:fixed","z-index:2147483600","top:12px","left:12px",
                "right:12px","margin:auto","max-width:740px","max-height:72vh",
                "overflow:auto","padding:16px","border:2px solid #d47d70",
                "border-radius:12px","background:#272224","color:#fff",
                "box-shadow:0 6px 40px #0008","font-size:14px"
            ].join(";");
            const heading = document.createElement("strong");
            heading.textContent = "Lore Spoilers 出错 · 诊断已保留在此窗口";
            const close = document.createElement("button");
            close.type = "button";
            close.textContent = "关闭";
            close.className = "menu_button";
            close.style.float = "right";
            close.addEventListener("click", () => overlay.remove());
            const pre = document.createElement("pre");
            pre.className = "lsp_report_body";
            pre.style.cssText = "white-space:pre-wrap;word-break:break-word;user-select:text;max-height:48vh;overflow:auto;font-size:12px;";
            const copy = document.createElement("button");
            copy.type = "button";
            copy.className = "menu_button";
            copy.textContent = "复制错误报告";
            copy.addEventListener("click", async () => {
                const body = overlay.querySelector(".lsp_report_body")?.textContent || "";
                try {
                    await navigator.clipboard.writeText(body);
                    if (typeof toastr !== "undefined") toastr.success("错误报告已复制");
                } catch {
                    window.prompt("复制以下错误报告：", body);
                }
            });
            overlay.append(heading, close, pre, copy);
        }
        overlay.querySelector(".lsp_report_body").textContent = diagnostics;
        if (!overlay.isConnected) document.body.appendChild(overlay);
    } catch (displayError) {
        console.error("[Lore Spoilers] Diagnostic UI also failed:", displayError);
        window.alert(diagnostics.slice(0, 4000));
    }
}
function bindEvents() {
    document.addEventListener("click", event => {
        if (event.target?.closest?.(".lsp-inline-toggle")) event.stopPropagation();
        const button = event.target?.closest?.("[data-lsp-action]");
        if (!button) return;
        event.preventDefault();
        const action = button.dataset.lspAction;
        if (action === "audit") audit();
        else if (action === "export-png" || action === "export-json") {
            publishSelectedCharacter(action === "export-png" ? "png" : "json").catch(error => {
                console.error("[lore-spoilers-selective] publish failed", error, error?.cause);
                reportPublishError(error, "发布防剧透角色卡");
                notify(error.message || "发布失败，请查看控制台", "error");
            });
        }
        else if (action === HIDDEN || action === PUBLIC) {
            bulkVisibility(action).catch(error => {
                console.error(`[${EXT}] bulk failed`, error);
                reportPublishError(error, "批量修改世界书可见性");
                notify("批量保存失败，查看诊断窗口", "error");
            });
        }
    }, true);
    document.addEventListener("change", event => {
        const target = event.target;
        if (!(target instanceof HTMLSelectElement)) return;
        if (!target.matches(".lsp-inline-select, .lsp-list-select")) return;
        event.stopPropagation();
        setVisibility(target.dataset.uid, target.value).catch(error => {
            console.error(`[${EXT}] set visibility failed`, error);
            reportPublishError(error, "修改单条世界书权限");
            notify("保存标记失败，查看诊断窗口", "error");
            scheduleSync();
        });
    }, true);
    document.querySelector("#world_editor_select")?.addEventListener("change", scheduleSync);
    const list = document.querySelector("#world_popup_entries_list");
    if (list) {
        const observer = new MutationObserver(mutations => {
            // Observe only actual entry row additions/removals.
            // Our own inline selector injection MUST NOT reschedule sync().
            if (mutations.some(m => [...m.addedNodes, ...m.removedNodes].some(
                node => node.nodeType === 1 && (
                    node.matches?.(".world_entry") || node.querySelector?.(".world_entry")
                )
            ))) scheduleSync();
        });
        observer.observe(list, { childList: true, subtree: false });
    }
}

jQuery(async () => {
    try {
        settings();
        const html = await jQuery.get(SETTINGS_HTML_URL);
        jQuery("#extensions_settings2").append(html);
        const enabled = document.getElementById("lsp_enabled");
        const authorMode = document.getElementById("lsp_author_mode");
        enabled.checked = settings().enabled;
        authorMode.checked = settings().authorMode;
        enabled.addEventListener("change", () => {
            settings().enabled = enabled.checked;
            saveSettingsDebounced();
            scheduleSync();
        });
        authorMode.addEventListener("change", () => {
            settings().authorMode = authorMode.checked;
            saveSettingsDebounced();
            scheduleSync();
        });
        // An earlier ZIP used a different directory, but registered the same UI
        // listeners. Two installs can run both versions at once and produce old
        // errors even after the GitHub copy was updated.
        const competing = extensionNames.filter(name =>
            /(?:^|\/)(?:lore-spoilers-selective|spoilers-is-unavailable)$/.test(name)
        );
        if (competing.length > 1) {
            reportPublishError(
                new Error("同时检测到多个 Lore Spoilers 安装：" + competing.join("、") +
                    "。请在【扩展管理】中只保留 GitHub 版本 spoilers-is-unavailable，移除旧 ZIP 版，然后刷新页面。"),
                "检测到重复安装"
            );
            return;
        }
        bindEvents();
        setModeClass();
        scheduleSync();
        console.info(`[${EXT}] Author publisher v2 ready (not encryption)`);
    } catch (error) {
        console.error(`[${EXT}] Could not initialize`, error);
        reportPublishError(error, "插件初始化");
    }
});
