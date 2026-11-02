/**
 * Lore Spoilers · Selective Edition
 * Based on the UI-only visibility approach of cha1latte/lore-spoilers (MIT).
 * Key difference: individual entry flags persist inside lorebook metadata.
 *
 * This extension DOES NOT encrypt or remove any content; it does not affect
 * prompt generation or defend against editing/exporting/inspecting the files.
 */
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { loadWorldInfo, saveWorldInfo, world_names } from "../../../world-info.js";

const EXT = "lore-spoilers-selective";
const SETTINGS_HTML_URL = new URL("./example.html", import.meta.url).href;
const FIELD = "lore_spoilers_visibility";
const HIDDEN = "hidden";
const PUBLIC = "public";
const DEFAULTS = { enabled: true, authorMode: false };

let currentBook = "";
let currentData = null;
let refreshTimer = null;
let syncing = false;
let waiting = false;
let search = "";
let noticeShown = false;

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
    select.title = "仅影响安装本扩展的玩家界面；不会删除或加密原文";
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
    title.textContent = "🔐 逐条权限 — " + book;
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
        ["检查导出风险", "audit"],
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
    caption.textContent = "“隐藏”不会阻止 AI 读取或触发条目，只在装有此扩展的界面中隐藏。标记存放在世界书条目的扩展字段内。";
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
    window.alert(
        `世界书「${currentBook}」\n共 ${entries.length} 条，其中标记隐藏 ${hidden.length} 条。\n\n` +
        "注意：本扩展不加密正文！\n导出的角色卡 PNG/JSON 与世界书 JSON 仍然包含这些隐藏条目的原始文本。\n" +
        "玩家不安装扩展、关闭扩展或查看文件/开发者工具，都可以读到原文。\n\n" +
        "若要真正对玩家保密，必须由作者的服务端保管秘密并代为调用 AI。"
    );
}

function bindEvents() {
    document.addEventListener("click", event => {
        if (event.target?.closest?.(".lsp-inline-toggle")) event.stopPropagation();
        const button = event.target?.closest?.("[data-lsp-action]");
        if (!button) return;
        event.preventDefault();
        const action = button.dataset.lspAction;
        if (action === "audit") audit();
        else if (action === HIDDEN || action === PUBLIC) {
            bulkVisibility(action).catch(error => {
                console.error(`[${EXT}] bulk failed`, error);
                notify("批量保存失败，查看控制台。", "error");
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
            notify("保存标记失败，查看控制台。", "error");
            scheduleSync();
        });
    }, true);
    document.querySelector("#world_editor_select")?.addEventListener("change", scheduleSync);
    const list = document.querySelector("#world_popup_entries_list");
    if (list) {
        const observer = new MutationObserver(mutations => {
            // Only react to changes in entry layout, not text-area input or checkbox changes.
            if (mutations.some(m => m.type === "childList")) scheduleSync();
        });
        observer.observe(list, { childList: true, subtree: true });
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
        bindEvents();
        setModeClass();
        scheduleSync();
        console.info(`[${EXT}] Loaded — selective world-info masking (NOT encryption)`);
    } catch (error) {
        console.error(`[${EXT}] Could not initialize`, error);
    }
});
