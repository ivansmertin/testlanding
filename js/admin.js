/**
 * Admin Panel — manages site content via GitHub Contents API.
 */
(function () {
    "use strict";

    var API_BASE = "https://api.github.com";
    var PREVIEW_KEY = "snaf-admin-preview";

    var config = (window.SNAF_CONFIG && window.SNAF_CONFIG.admin) || {};
    var repoOwner = config.repoOwner || "";
    var repoName = config.repoName || "";
    var contentPath = config.contentPath || "data/content.json";

    var state = {
        token: null,
        username: null,
        content: null,
        fileSha: null,
        activeSection: "mail",
        dirty: false
    };

    // ── DOM References ──
    var authScreen = document.getElementById("auth-screen");
    var dashboard = document.getElementById("admin-dashboard");
    var loginBtn = document.getElementById("login-btn");
    var tokenInput = document.getElementById("pat-input");
    var repoOwnerInput = document.getElementById("repo-owner");
    var repoNameInput = document.getElementById("repo-name");
    var authError = document.getElementById("auth-error");
    var usernameDisplay = document.getElementById("admin-username");
    var logoutBtn = document.getElementById("logout-btn");
    var sidebarLinks = document.querySelectorAll(".sidebar-link[data-section]");
    var sectionEditors = document.querySelectorAll(".section-editor");
    var previewBtn = document.getElementById("preview-btn");
    var publishBtn = document.getElementById("publish-btn");
    var toastEl = document.getElementById("admin-toast");
    var sidebarToggle = document.getElementById("sidebar-toggle");
    var sidebar = document.querySelector(".admin-sidebar");
    var sidebarOverlay = document.getElementById("sidebar-overlay");

    // ── Init ──
    function init() {
        // Pre-fill repo fields
        if (repoOwnerInput && repoOwner) repoOwnerInput.value = repoOwner;
        if (repoNameInput && repoName) repoNameInput.value = repoName;

        // Check for saved session
        var savedToken = sessionStorage.getItem("snaf-admin-token");
        var savedUser = sessionStorage.getItem("snaf-admin-user");
        var savedOwner = sessionStorage.getItem("snaf-admin-owner");
        var savedRepo = sessionStorage.getItem("snaf-admin-repo");

        if (savedToken && savedUser) {
            state.token = savedToken;
            state.username = savedUser;
            if (savedOwner) {
                repoOwner = savedOwner;
                if (repoOwnerInput) repoOwnerInput.value = savedOwner;
            }
            if (savedRepo) {
                repoName = savedRepo;
                if (repoNameInput) repoNameInput.value = savedRepo;
            }
            showDashboard();
            loadContent();
        }

        bindEvents();
    }

    function bindEvents() {
        if (loginBtn) loginBtn.addEventListener("click", handleLogin);
        if (tokenInput) tokenInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") handleLogin();
        });
        if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
        if (previewBtn) previewBtn.addEventListener("click", handlePreview);
        if (publishBtn) publishBtn.addEventListener("click", handlePublish);

        sidebarLinks.forEach(function (link) {
            link.addEventListener("click", function () {
                switchSection(link.getAttribute("data-section"));
                closeSidebar();
            });
        });

        if (sidebarToggle) sidebarToggle.addEventListener("click", toggleSidebar);
        if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeSidebar);
    }

    // ── Auth ──
    function handleLogin() {
        var token = tokenInput.value.trim();
        var owner = repoOwnerInput ? repoOwnerInput.value.trim() : repoOwner;
        var repo = repoNameInput ? repoNameInput.value.trim() : repoName;

        if (!token || !owner || !repo) {
            showAuthError("Заполните все поля");
            return;
        }

        loginBtn.disabled = true;
        loginBtn.innerHTML = '<span class="spinner"></span> Проверка...';

        fetch(API_BASE + "/user", {
            headers: { Authorization: "token " + token }
        })
            .then(function (r) {
                if (!r.ok) throw new Error("Invalid token");
                return r.json();
            })
            .then(function (user) {
                state.token = token;
                state.username = user.login;
                repoOwner = owner;
                repoName = repo;

                sessionStorage.setItem("snaf-admin-token", token);
                sessionStorage.setItem("snaf-admin-user", user.login);
                sessionStorage.setItem("snaf-admin-owner", owner);
                sessionStorage.setItem("snaf-admin-repo", repo);

                showDashboard();
                loadContent();
            })
            .catch(function () {
                showAuthError("Неверный токен или нет доступа");
            })
            .finally(function () {
                loginBtn.disabled = false;
                loginBtn.textContent = "Войти";
            });
    }

    function handleLogout() {
        sessionStorage.removeItem("snaf-admin-token");
        sessionStorage.removeItem("snaf-admin-user");
        sessionStorage.removeItem("snaf-admin-owner");
        sessionStorage.removeItem("snaf-admin-repo");
        state.token = null;
        state.username = null;
        state.content = null;
        state.fileSha = null;
        authScreen.hidden = false;
        dashboard.hidden = true;
    }

    function showAuthError(msg) {
        if (authError) {
            authError.textContent = msg;
            authError.hidden = false;
        }
    }

    function showDashboard() {
        authScreen.hidden = true;
        dashboard.hidden = false;
        if (usernameDisplay) usernameDisplay.textContent = state.username;
    }

    // ── Content Loading ──
    function loadContent() {
        var url = API_BASE + "/repos/" + repoOwner + "/" + repoName + "/contents/" + contentPath;

        fetch(url, {
            headers: { Authorization: "token " + state.token }
        })
            .then(function (r) {
                if (!r.ok) throw new Error("Failed to load content");
                return r.json();
            })
            .then(function (file) {
                state.fileSha = file.sha;
                var decoded = atob(file.content.replace(/\n/g, ""));
                // Handle UTF-8 properly
                var bytes = new Uint8Array(decoded.length);
                for (var i = 0; i < decoded.length; i++) {
                    bytes[i] = decoded.charCodeAt(i);
                }
                var text = new TextDecoder("utf-8").decode(bytes);
                state.content = JSON.parse(text);
                populateEditors();
                showToast("Контент загружен", "success");
            })
            .catch(function (err) {
                showToast("Ошибка загрузки: " + err.message, "error");
            });
    }

    // ── Editor Population ──
    function populateEditors() {
        if (!state.content) return;
        var data = state.content;

        // Simple fields
        var inputs = document.querySelectorAll("[data-field]");
        inputs.forEach(function (input) {
            var value = getNestedValue(data, input.getAttribute("data-field"));
            if (value !== undefined) {
                input.value = value;
            }
        });

        // List editors
        buildListEditor("benefits-list", data.benefits ? data.benefits.items : [], buildBenefitItem);
        buildListEditor("process-list", data.process ? data.process.steps : [], buildProcessItem);
        buildListEditor("pricing-list", data.pricing ? data.pricing.plans : [], buildPricingItem);
        buildListEditor("faq-list", data.faq ? data.faq.items : [], buildFaqItem);
        buildListEditor("tech-list", getTechBadges(data), buildTechItem);

        // Mark as clean
        state.dirty = false;
        trackChanges();
    }

    function getTechBadges(data) {
        if (!data.about || !data.about.stats) return [];
        var tech = data.about.stats.find(function (s) { return s.type === "tech"; });
        return tech && tech.badges ? tech.badges.map(function (b) { return { badge: b }; }) : [];
    }

    function trackChanges() {
        document.querySelectorAll("[data-field], .list-editor-container input, .list-editor-container textarea").forEach(function (el) {
            el.removeEventListener("input", markDirty);
            el.addEventListener("input", markDirty);
        });
    }

    function markDirty() {
        state.dirty = true;
        if (publishBtn) publishBtn.disabled = false;
    }

    // ── List Editor Builders ──
    function buildListEditor(containerId, items, itemBuilder) {
        var container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = "";
        items.forEach(function (item, i) {
            container.appendChild(itemBuilder(item, i, containerId));
        });
        var addBtn = document.createElement("button");
        addBtn.className = "admin-btn admin-btn--outline admin-btn--sm";
        addBtn.textContent = "+ Добавить";
        addBtn.addEventListener("click", function () {
            var newItem = itemBuilder(getDefaultItem(containerId), container.querySelectorAll(".list-editor-item").length, containerId);
            container.insertBefore(newItem, addBtn);
            markDirty();
            trackChanges();
        });
        container.appendChild(addBtn);
    }

    function getDefaultItem(containerId) {
        var defaults = {
            "benefits-list": { title: "", text: "" },
            "process-list": { number: "00", title: "", description: "", accent: false },
            "pricing-list": { name: "", range: "", price: "", features: [], accent: false, ctaLabel: "Обсудить проект", ctaStyle: "outline" },
            "faq-list": { question: "", answer: "" },
            "tech-list": { badge: "" }
        };
        return defaults[containerId] || {};
    }

    function wrapListItem(content, index, containerId) {
        var div = document.createElement("div");
        div.className = "list-editor-item";
        div.innerHTML =
            '<div class="item-header">' +
                '<span class="item-number">#' + (index + 1) + "</span>" +
                '<div class="item-actions">' +
                    '<button class="item-action-btn" data-action="up" title="Вверх">&#8593;</button>' +
                    '<button class="item-action-btn" data-action="down" title="Вниз">&#8595;</button>' +
                    '<button class="item-action-btn item-action-btn--delete" data-action="delete" title="Удалить">&#10005;</button>' +
                "</div>" +
            "</div>";
        div.appendChild(content);

        div.querySelectorAll("[data-action]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var action = btn.getAttribute("data-action");
                var container = document.getElementById(containerId);
                var items = Array.from(container.querySelectorAll(".list-editor-item"));
                var idx = items.indexOf(div);
                if (action === "delete") {
                    div.remove();
                    renumberItems(containerId);
                    markDirty();
                } else if (action === "up" && idx > 0) {
                    container.insertBefore(div, items[idx - 1]);
                    renumberItems(containerId);
                    markDirty();
                } else if (action === "down" && idx < items.length - 1) {
                    container.insertBefore(items[idx + 1], div);
                    renumberItems(containerId);
                    markDirty();
                }
            });
        });

        return div;
    }

    function renumberItems(containerId) {
        var container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll(".list-editor-item .item-number").forEach(function (el, i) {
            el.textContent = "#" + (i + 1);
        });
    }

    function buildBenefitItem(item, index, containerId) {
        var content = document.createElement("div");
        content.innerHTML =
            '<div class="form-group"><label>Заголовок</label><input class="form-input" data-list-field="title" value="' + escapeAttr(item.title) + '"></div>' +
            '<div class="form-group"><label>Текст</label><textarea class="form-input" data-list-field="text">' + escapeHtml(item.text) + "</textarea></div>";
        return wrapListItem(content, index, containerId);
    }

    function buildProcessItem(item, index, containerId) {
        var content = document.createElement("div");
        content.innerHTML =
            '<div class="form-group"><label>Номер</label><input class="form-input" data-list-field="number" value="' + escapeAttr(item.number) + '"></div>' +
            '<div class="form-group"><label>Заголовок</label><input class="form-input" data-list-field="title" value="' + escapeAttr(item.title) + '"></div>' +
            '<div class="form-group"><label>Описание</label><textarea class="form-input" data-list-field="description">' + escapeHtml(item.description) + "</textarea></div>" +
            '<div class="form-group"><label><input type="checkbox" data-list-field="accent"' + (item.accent ? " checked" : "") + '> Акцентный</label></div>';
        return wrapListItem(content, index, containerId);
    }

    function buildPricingItem(item, index, containerId) {
        var features = (item.features || []).join("\n");
        var content = document.createElement("div");
        content.innerHTML =
            '<div class="form-group"><label>Название</label><input class="form-input" data-list-field="name" value="' + escapeAttr(item.name) + '"></div>' +
            '<div class="form-group"><label>Диапазон</label><input class="form-input" data-list-field="range" value="' + escapeAttr(item.range) + '"></div>' +
            '<div class="form-group"><label>Цена</label><input class="form-input" data-list-field="price" value="' + escapeAttr(item.price) + '"></div>' +
            '<div class="form-group"><label>Особенности (каждая с новой строки)</label><textarea class="form-input" data-list-field="features">' + escapeHtml(features) + "</textarea></div>" +
            '<div class="form-group"><label>Текст кнопки</label><input class="form-input" data-list-field="ctaLabel" value="' + escapeAttr(item.ctaLabel || "Обсудить проект") + '"></div>' +
            '<div class="form-group"><label><input type="checkbox" data-list-field="accent"' + (item.accent ? " checked" : "") + '> Акцентный (выделенный)</label></div>';
        return wrapListItem(content, index, containerId);
    }

    function buildFaqItem(item, index, containerId) {
        var content = document.createElement("div");
        content.innerHTML =
            '<div class="form-group"><label>Вопрос</label><input class="form-input" data-list-field="question" value="' + escapeAttr(item.question) + '"></div>' +
            '<div class="form-group"><label>Ответ</label><textarea class="form-input" data-list-field="answer">' + escapeHtml(item.answer) + "</textarea></div>";
        return wrapListItem(content, index, containerId);
    }

    function buildTechItem(item, index, containerId) {
        var content = document.createElement("div");
        content.innerHTML =
            '<div class="form-group"><label>Технология</label><input class="form-input" data-list-field="badge" value="' + escapeAttr(item.badge) + '"></div>';
        return wrapListItem(content, index, containerId);
    }

    // ── Collect Data ──
    function collectContent() {
        var data = JSON.parse(JSON.stringify(state.content));

        // Simple fields
        document.querySelectorAll("[data-field]").forEach(function (input) {
            setNestedValue(data, input.getAttribute("data-field"), input.value);
        });

        // Lists
        data.benefits.items = collectListItems("benefits-list", ["title", "text"]);
        data.process.steps = collectListItems("process-list", ["number", "title", "description"], ["accent"]);
        data.pricing.plans = collectPricingItems();
        data.faq.items = collectListItems("faq-list", ["question", "answer"]);

        // Tech badges
        var techItems = collectListItems("tech-list", ["badge"]);
        var techStat = data.about.stats.find(function (s) { return s.type === "tech"; });
        if (techStat) {
            techStat.badges = techItems.map(function (t) { return t.badge; });
        }

        data.meta.lastModified = new Date().toISOString();
        data.meta.modifiedBy = state.username;

        return data;
    }

    function collectListItems(containerId, textFields, boolFields) {
        var container = document.getElementById(containerId);
        if (!container) return [];
        var items = [];
        container.querySelectorAll(".list-editor-item").forEach(function (el) {
            var item = {};
            (textFields || []).forEach(function (field) {
                var input = el.querySelector('[data-list-field="' + field + '"]');
                if (input) item[field] = input.value;
            });
            (boolFields || []).forEach(function (field) {
                var input = el.querySelector('[data-list-field="' + field + '"]');
                if (input) item[field] = input.checked;
            });
            items.push(item);
        });
        return items;
    }

    function collectPricingItems() {
        var container = document.getElementById("pricing-list");
        if (!container) return [];
        var items = [];
        container.querySelectorAll(".list-editor-item").forEach(function (el) {
            var item = {};
            ["name", "range", "price", "ctaLabel"].forEach(function (field) {
                var input = el.querySelector('[data-list-field="' + field + '"]');
                if (input) item[field] = input.value;
            });
            var featuresEl = el.querySelector('[data-list-field="features"]');
            item.features = featuresEl ? featuresEl.value.split("\n").filter(function (l) { return l.trim(); }) : [];
            var accentEl = el.querySelector('[data-list-field="accent"]');
            item.accent = accentEl ? accentEl.checked : false;
            item.ctaStyle = item.accent ? "primary" : "outline";
            items.push(item);
        });
        return items;
    }

    // ── Preview ──
    function handlePreview() {
        var data = collectContent();
        try {
            localStorage.setItem(PREVIEW_KEY, JSON.stringify(data));
        } catch (e) {
            showToast("Не удалось сохранить превью", "error");
            return;
        }
        window.open("index.html", "_blank");
    }

    // ── Publish ──
    function handlePublish() {
        if (!state.token) return;

        var data = collectContent();
        var json = JSON.stringify(data, null, 2);

        // Encode to base64 with UTF-8 support
        var encoded = btoa(unescape(encodeURIComponent(json)));

        publishBtn.disabled = true;
        publishBtn.innerHTML = '<span class="spinner"></span> Сохранение...';

        var url = API_BASE + "/repos/" + repoOwner + "/" + repoName + "/contents/" + contentPath;

        fetch(url, {
            method: "PUT",
            headers: {
                Authorization: "token " + state.token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: "Update site content via admin panel",
                content: encoded,
                sha: state.fileSha
            })
        })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (err) { throw new Error(err.message); });
                return r.json();
            })
            .then(function (result) {
                state.fileSha = result.content.sha;
                state.content = data;
                state.dirty = false;
                showToast("Опубликовано! Сайт обновится через 1-2 минуты.", "success");
            })
            .catch(function (err) {
                showToast("Ошибка: " + err.message, "error");
            })
            .finally(function () {
                publishBtn.disabled = false;
                publishBtn.textContent = "Сохранить и опубликовать";
            });
    }

    // ── Sidebar ──
    function switchSection(sectionId) {
        state.activeSection = sectionId;
        sidebarLinks.forEach(function (link) {
            link.classList.toggle("is-active", link.getAttribute("data-section") === sectionId);
        });
        sectionEditors.forEach(function (editor) {
            editor.classList.toggle("is-visible", editor.getAttribute("data-editor") === sectionId);
        });
    }

    function toggleSidebar() {
        sidebar.classList.toggle("is-open");
        sidebarOverlay.classList.toggle("is-visible");
    }

    function closeSidebar() {
        sidebar.classList.remove("is-open");
        sidebarOverlay.classList.remove("is-visible");
    }

    // ── Toast ──
    function showToast(message, type) {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.className = "admin-toast admin-toast--" + type + " is-visible";
        setTimeout(function () {
            toastEl.classList.remove("is-visible");
        }, 3500);
    }

    // ── Helpers ──
    function getNestedValue(obj, path) {
        return path.split(".").reduce(function (o, key) {
            return o && o[key] !== undefined ? o[key] : undefined;
        }, obj);
    }

    function setNestedValue(obj, path, value) {
        var keys = path.split(".");
        var last = keys.pop();
        var target = keys.reduce(function (o, key) {
            if (!o[key]) o[key] = {};
            return o[key];
        }, obj);
        target[last] = value;
    }

    function escapeHtml(str) {
        if (!str) return "";
        var div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        if (!str) return "";
        return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // ── Start ──
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
