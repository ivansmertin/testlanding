(function () {
    "use strict";

    var siteConfig = window.SNAF_CONFIG || {};
    var chatConfig = siteConfig.chat || {};
    var isEnabled = chatConfig.enabled !== false;
    var apiBaseUrl = trimTrailingSlash(chatConfig.apiBaseUrl || "");
    var contentPath = "data/content.json";
    var CHAT_REQUEST_TIMEOUT = 12000;
    var widget = null;
    var launcher = null;
    var panel = null;
    var bodyEl = null;
    var composerEl = null;
    var observer = null;

    var state = {
        isOpen: false,
        loading: false,
        sessionId: null,
        sessionPromise: null,
        messages: [],
        suggestions: [],
        hasInteraction: false,
        apiConfigured: Boolean(apiBaseUrl),
        leadMode: false,
        leadError: "",
        content: {
            contact: {
                telegram: "https://t.me/smrtnivn"
            },
            chatBot: {
                launcherLabel: "Р—Р°РґР°С‚СЊ РІРѕРїСЂРѕСЃ",
                greeting: "РџСЂРёРІРµС‚! РЇ РїРѕРјРѕРіСѓ Р±С‹СЃС‚СЂРѕ СЃРѕСЂРёРµРЅС‚РёСЂРѕРІР°С‚СЊСЃСЏ РїРѕ СѓСЃР»СѓРіР°Рј РЎРќРђР¤ РЎРўРЈР”РР.",
                intro: "РњРѕР¶РЅРѕ СЃРїСЂРѕСЃРёС‚СЊ РїСЂРѕ СЃС‚РѕРёРјРѕСЃС‚СЊ, СЃСЂРѕРєРё, С„РѕСЂРјР°С‚ СЂР°Р±РѕС‚С‹ РёР»Рё СЃСЂР°Р·Сѓ РѕСЃС‚Р°РІРёС‚СЊ Р·Р°СЏРІРєСѓ.",
                quickReplies: ["РЎС‚РѕРёРјРѕСЃС‚СЊ", "РЎСЂРѕРєРё", "Р§С‚Рѕ РІС‹ РґРµР»Р°РµС‚Рµ?", "РћСЃС‚Р°РІРёС‚СЊ Р·Р°СЏРІРєСѓ"],
                capturePrompt: "Р•СЃР»Рё С…РѕС‚РёС‚Рµ, СЏ РїРµСЂРµРґР°Рј РІР°С€ РІРѕРїСЂРѕСЃ РІ Р·Р°СЏРІРєРё. РћСЃС‚Р°РІСЊС‚Рµ РёРјСЏ Рё СѓРґРѕР±РЅС‹Р№ РєРѕРЅС‚Р°РєС‚, Рё СЏ СЃРІСЏР¶СѓСЃСЊ СЃ РІР°РјРё.",
                successMessage: "РЎРїР°СЃРёР±Рѕ! Р—Р°СЏРІРєР° СЃРѕС…СЂР°РЅРµРЅР°. РЇ РїРѕСЃРјРѕС‚СЂСЋ РІРѕРїСЂРѕСЃ Рё РІРµСЂРЅСѓСЃСЊ Рє РІР°Рј РїРѕ СѓРєР°Р·Р°РЅРЅРѕРјСѓ РєРѕРЅС‚Р°РєС‚Сѓ.",
                fallbackMessage: "РЎРµР№С‡Р°СЃ С‡Р°С‚ РЅРµРґРѕСЃС‚СѓРїРµРЅ. РќР°РїРёС€РёС‚Рµ РјРЅРµ РІ Telegram, Рё СЏ РѕС‚РІРµС‡Сѓ РІСЂСѓС‡РЅСѓСЋ."
            }
        },
        leadForm: {
            name: "",
            contactType: "telegram",
            contactValue: "",
            question: "",
            consent: false,
            website: ""
        }
    };

    function trimTrailingSlash(value) {
        return value.replace(/\/+$/, "");
    }

    function init() {
        if (!isEnabled || !document.body) return;
        createWidget();
        seedMessages(true);
        bindGlobalEvents();
        loadSiteContent();
        syncCookieOffset();
        render();
        primeSessionOnIdle();
    }

    function createWidget() {
        widget = document.createElement("div");
        widget.className = "chat-widget";
        widget.innerHTML =
            '<button class="chat-widget__launcher" type="button" aria-expanded="false" aria-controls="snaf-chat-panel">' +
                '<span class="chat-widget__launcher-icon" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">' +
                        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>' +
                    "</svg>" +
                "</span>" +
                '<span class="chat-widget__launcher-text">Р—Р°РґР°С‚СЊ РІРѕРїСЂРѕСЃ</span>' +
            "</button>" +
            '<section class="chat-widget__panel" id="snaf-chat-panel" aria-label="Р§Р°С‚-Р±РѕС‚ РЎРќРђР¤ РЎРўРЈР”РР">' +
                '<div class="chat-widget__header">' +
                    '<div class="chat-widget__header-copy">' +
                        '<div class="chat-widget__eyebrow">РЎРќРђР¤ РЎРўРЈР”РРЇ</div>' +
                        '<h2 class="chat-widget__title">Р§Р°С‚-Р±РѕС‚ РїРѕ СѓСЃР»СѓРіР°Рј</h2>' +
                        '<p class="chat-widget__subtitle">Р‘С‹СЃС‚СЂС‹Р№ FAQ Рё РїРµСЂРµРґР°С‡Р° Р·Р°СЏРІРєРё РІ СЂР°Р±РѕС‚Сѓ</p>' +
                    "</div>" +
                    '<button class="chat-widget__close" type="button" aria-label="Р—Р°РєСЂС‹С‚СЊ С‡Р°С‚">&times;</button>' +
                "</div>" +
                '<div class="chat-widget__body" aria-live="polite"></div>' +
                '<div class="chat-widget__composer"></div>' +
            "</section>";

        document.body.appendChild(widget);
        launcher = widget.querySelector(".chat-widget__launcher");
        panel = widget.querySelector(".chat-widget__panel");
        bodyEl = widget.querySelector(".chat-widget__body");
        composerEl = widget.querySelector(".chat-widget__composer");

        launcher.addEventListener("click", toggleWidget);
        widget.querySelector(".chat-widget__close").addEventListener("click", closeWidget);
    }

    function bindGlobalEvents() {
        document.addEventListener("snaf:content-loaded", function (event) {
            if (event && event.detail) {
                applyContent(event.detail);
            }
        });

        window.addEventListener("resize", syncCookieOffset);

        var banner = document.querySelector(".cookie-banner");
        if (banner && "MutationObserver" in window) {
            observer = new MutationObserver(syncCookieOffset);
            observer.observe(banner, {
                attributes: true,
                attributeFilter: ["hidden", "class", "style"]
            });
        }
    }

    function loadSiteContent() {
        if (window.SNAF_CONTENT) {
            applyContent(window.SNAF_CONTENT);
            return;
        }

        fetch(contentPath)
            .then(function (response) {
                if (!response.ok) throw new Error("Failed to load content");
                return response.json();
            })
            .then(function (data) {
                applyContent(data);
            })
            .catch(function () {
                render();
            });
    }

    function applyContent(data) {
        state.content = normalizeContent(data);
        if (!state.hasInteraction) {
            seedMessages(true);
        }
        render();
    }

    function normalizeContent(data) {
        var next = data || {};
        if (!next.contact) next.contact = {};
        if (!next.chatBot) next.chatBot = {};

        if (!next.contact.telegram) {
            next.contact.telegram = "https://t.me/smrtnivn";
        }

        next.chatBot.launcherLabel = next.chatBot.launcherLabel || "Р—Р°РґР°С‚СЊ РІРѕРїСЂРѕСЃ";
        next.chatBot.greeting = next.chatBot.greeting || "РџСЂРёРІРµС‚! РЇ РїРѕРјРѕРіСѓ Р±С‹СЃС‚СЂРѕ СЃРѕСЂРёРµРЅС‚РёСЂРѕРІР°С‚СЊСЃСЏ РїРѕ СѓСЃР»СѓРіР°Рј РЎРќРђР¤ РЎРўРЈР”РР.";
        next.chatBot.intro = next.chatBot.intro || "РњРѕР¶РЅРѕ СЃРїСЂРѕСЃРёС‚СЊ РїСЂРѕ СЃС‚РѕРёРјРѕСЃС‚СЊ, СЃСЂРѕРєРё, С„РѕСЂРјР°С‚ СЂР°Р±РѕС‚С‹ РёР»Рё СЃСЂР°Р·Сѓ РѕСЃС‚Р°РІРёС‚СЊ Р·Р°СЏРІРєСѓ.";
        next.chatBot.quickReplies = Array.isArray(next.chatBot.quickReplies) && next.chatBot.quickReplies.length
            ? next.chatBot.quickReplies
            : ["РЎС‚РѕРёРјРѕСЃС‚СЊ", "РЎСЂРѕРєРё", "Р§С‚Рѕ РІС‹ РґРµР»Р°РµС‚Рµ?", "РћСЃС‚Р°РІРёС‚СЊ Р·Р°СЏРІРєСѓ"];
        next.chatBot.capturePrompt = next.chatBot.capturePrompt || "РћСЃС‚Р°РІСЊС‚Рµ РёРјСЏ Рё СѓРґРѕР±РЅС‹Р№ РєРѕРЅС‚Р°РєС‚, Рё СЏ РїРµСЂРµРґР°Рј РІР°С€ РІРѕРїСЂРѕСЃ РІ СЂР°Р±РѕС‚Сѓ.";
        next.chatBot.successMessage = next.chatBot.successMessage || "РЎРїР°СЃРёР±Рѕ! Р—Р°СЏРІРєР° СЃРѕС…СЂР°РЅРµРЅР°.";
        next.chatBot.fallbackMessage = next.chatBot.fallbackMessage || "РЎРµР№С‡Р°СЃ С‡Р°С‚ РЅРµРґРѕСЃС‚СѓРїРµРЅ. РќР°РїРёС€РёС‚Рµ РјРЅРµ РІ Telegram.";
        return next;
    }

    function seedMessages(forceReset) {
        if (!forceReset && state.messages.length) return;
        state.messages = [
            { role: "bot", text: state.content.chatBot.greeting },
            { role: "bot", text: state.content.chatBot.intro }
        ];
        state.suggestions = state.apiConfigured ? state.content.chatBot.quickReplies.slice() : [];
        state.leadMode = false;
        state.leadError = "";
    }

    function toggleWidget() {
        if (state.isOpen) {
            closeWidget();
        } else {
            openWidget();
        }
    }

    function openWidget() {
        state.isOpen = true;
        widget.classList.add("is-open");
        launcher.setAttribute("aria-expanded", "true");
        render();
        primeSession();
        focusPrimaryControl();
    }

    function primeSessionOnIdle() {
        if (!state.apiConfigured) return;

        if ("requestIdleCallback" in window) {
            window.requestIdleCallback(function () {
                primeSession();
            }, { timeout: 2000 });
            return;
        }

        window.setTimeout(function () {
            primeSession();
        }, 1200);
    }

    function primeSession() {
        if (!state.apiConfigured || state.sessionId || state.sessionPromise) {
            return;
        }

        createSession().catch(function () {
            return null;
        });
    }

    function closeWidget() {
        state.isOpen = false;
        widget.classList.remove("is-open");
        launcher.setAttribute("aria-expanded", "false");
    }

    function focusPrimaryControl() {
        if (!widget) return;
        window.setTimeout(function () {
            var target = widget.querySelector("#chat-lead-name, .chat-widget__field, .chat-widget__textarea, .chat-widget__quick-reply, .chat-widget__link");
            if (target) target.focus();
        }, 60);
    }

    function render() {
        if (!widget) return;
        renderLauncher();
        renderMessages();
        renderComposer();
    }

    function renderLauncher() {
        var launcherText = widget.querySelector(".chat-widget__launcher-text");
        if (launcherText) {
            launcherText.textContent = state.content.chatBot.launcherLabel;
        }
    }

    function renderMessages() {
        bodyEl.innerHTML = "";

        state.messages.forEach(function (message) {
            var wrap = document.createElement("article");
            wrap.className = "chat-widget__message chat-widget__message--" + message.role;

            var bubble = document.createElement("div");
            bubble.className = "chat-widget__bubble";
            bubble.textContent = message.text;
            wrap.appendChild(bubble);

            var meta = document.createElement("div");
            meta.className = "chat-widget__message-meta";
            meta.textContent = message.role === "bot" ? "Р‘РѕС‚" : "Р’С‹";
            wrap.appendChild(meta);

            bodyEl.appendChild(wrap);
        });

        if (state.leadMode) {
            bodyEl.appendChild(buildLeadCard());
        }

        bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function renderComposer() {
        if (!composerEl) return;

        if (state.leadMode) {
            composerEl.innerHTML = "";
            return;
        }

        var inputDisabled = !state.apiConfigured || state.loading;
        var statusBlock = "";
        if (!state.apiConfigured) {
            statusBlock =
                '<div class="chat-widget__status">' +
                    '<strong>Backend РїРѕРєР° РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ.</strong> Р—Р°РїРѕР»РЅРёС‚Рµ <code>chat.apiBaseUrl</code> РёР»Рё РёСЃРїРѕР»СЊР·СѓР№С‚Рµ Telegram.' +
                "</div>";
        }

        composerEl.innerHTML =
            statusBlock +
            '<div class="chat-widget__actions" id="chat-widget-actions"></div>' +
            '<div class="chat-widget__links" id="chat-widget-links"></div>' +
            '<div class="chat-widget__composer-row">' +
                '<input class="chat-widget__field" id="chat-widget-input" type="text" placeholder="' + escapeAttr(getInputPlaceholder()) + '"' + (inputDisabled ? " disabled" : "") + ">" +
                '<button class="chat-widget__submit" id="chat-widget-send" type="button"' + (inputDisabled ? " disabled" : "") + ">" +
                    (state.loading ? "РћС‚РїСЂР°РІРєР°..." : "РћС‚РїСЂР°РІРёС‚СЊ") +
                "</button>" +
            "</div>" +
            '<p class="chat-widget__composer-hint">Р‘РѕС‚ РѕС‚РІРµС‡Р°РµС‚ РїРѕ СЃРѕРґРµСЂР¶Р°РЅРёСЋ СЃР°Р№С‚Р° Рё РјРѕР¶РµС‚ РїРµСЂРµРґР°С‚СЊ РІРѕРїСЂРѕСЃ РІ Р·Р°СЏРІРєРё.</p>';

        var actionsEl = composerEl.querySelector("#chat-widget-actions");
        var linksEl = composerEl.querySelector("#chat-widget-links");
        populateActions(actionsEl, linksEl);

        var input = composerEl.querySelector("#chat-widget-input");
        var sendButton = composerEl.querySelector("#chat-widget-send");
        if (input) {
            input.addEventListener("keydown", function (event) {
                if (event.key === "Enter") {
                    event.preventDefault();
                    submitMessage(input.value);
                }
            });
        }
        if (sendButton) {
            sendButton.addEventListener("click", function () {
                submitMessage(input ? input.value : "");
            });
        }
    }

        function populateActions(container, linksContainer) {
        if (!container) return;
        container.innerHTML = "";
        if (linksContainer) {
            linksContainer.innerHTML = "";
        }

        var actions = state.apiConfigured
            ? getVisibleQuickReplies(state.suggestions.slice())
            : [];

        actions.forEach(function (label) {
            var button = document.createElement("button");
            button.className = "chat-widget__quick-reply";
            button.type = "button";
            button.textContent = label;
            button.addEventListener("click", function () {
                if (label === "РћСЃС‚Р°РІРёС‚СЊ Р·Р°СЏРІРєСѓ") {
                    openLeadMode();
                } else {
                    submitMessage(label);
                }
            });
            container.appendChild(button);
        });

        if (state.content.contact && state.content.contact.telegram) {
            var telegramLink = document.createElement("a");
            telegramLink.className = "chat-widget__link";
            telegramLink.href = state.content.contact.telegram;
            telegramLink.target = "_blank";
            telegramLink.rel = "noopener noreferrer";
            telegramLink.textContent = "Написать в Telegram";
            if (linksContainer) {
                linksContainer.appendChild(telegramLink);
            } else {
                container.appendChild(telegramLink);
            }
        }
    }

    function getVisibleQuickReplies(actions) {
        var labels = Array.isArray(actions) ? actions.slice() : [];
        var primary = labels.slice(0, 2);
        var leadLabel = "Оставить заявку";

        if (labels.indexOf(leadLabel) !== -1 && primary.indexOf(leadLabel) === -1) {
            primary.push(leadLabel);
        }

        return primary.slice(0, 3);
    }

    function buildLeadCard() {
        var wrap = document.createElement("section");
        wrap.className = "chat-widget__lead-card";
        wrap.innerHTML =
            '<div class="chat-widget__lead-title">РџРµСЂРµРґР°С‚СЊ РІРѕРїСЂРѕСЃ РІ Р·Р°СЏРІРєРё</div>' +
            '<p class="chat-widget__lead-note">РћСЃС‚Р°РІСЊС‚Рµ РёРјСЏ, СЃРїРѕСЃРѕР± СЃРІСЏР·Рё Рё РІРѕРїСЂРѕСЃ. РЇ РїРѕР»СѓС‡Сѓ РµРіРѕ РІ Р°РґРјРёРЅРєРµ Рё РІ Telegram.</p>' +
            '<label class="chat-widget__field-group">' +
                '<span class="chat-widget__field-label">Р’Р°С€Рµ РёРјСЏ</span>' +
                '<input class="chat-widget__field" id="chat-lead-name" type="text" value="' + escapeAttr(state.leadForm.name) + '" placeholder="РќР°РїСЂРёРјРµСЂ, РђРЅРЅР°">' +
            "</label>" +
            '<div class="chat-widget__field-group">' +
                '<span class="chat-widget__field-label">РљР°Рє СѓРґРѕР±РЅРµРµ СЃРІСЏР·Р°С‚СЊСЃСЏ</span>' +
                '<div class="chat-widget__contact-options">' +
                    buildContactOption("telegram", "Telegram") +
                    buildContactOption("phone", "РўРµР»РµС„РѕРЅ") +
                    buildContactOption("email", "Email") +
                "</div>" +
            "</div>" +
            '<label class="chat-widget__field-group">' +
                '<span class="chat-widget__field-label">' + escapeHtml(getContactLabel()) + "</span>" +
                '<input class="chat-widget__field" id="chat-lead-contact" type="text" value="' + escapeAttr(state.leadForm.contactValue) + '" placeholder="' + escapeAttr(getContactPlaceholder()) + '">' +
            "</label>" +
            '<label class="chat-widget__field-group">' +
                '<span class="chat-widget__field-label">РљРѕСЂРѕС‚РєРѕ Рѕ Р·Р°РґР°С‡Рµ</span>' +
                '<textarea class="chat-widget__textarea" id="chat-lead-question" placeholder="РћРїРёС€РёС‚Рµ СЃР°Р№С‚, Р·Р°РґР°С‡Сѓ РёР»Рё РІРѕРїСЂРѕСЃ">' + escapeHtml(state.leadForm.question) + "</textarea>" +
            "</label>" +
            '<label class="chat-widget__field-group" style="position:absolute;left:-9999px;opacity:0;pointer-events:none;" aria-hidden="true">' +
                '<span class="chat-widget__field-label">Р’Р°С€ СЃР°Р№С‚</span>' +
                '<input class="chat-widget__field" id="chat-lead-website" type="text" tabindex="-1" autocomplete="off" value="' + escapeAttr(state.leadForm.website) + '">' +
            "</label>" +
            '<label class="chat-widget__consent">' +
                '<input id="chat-lead-consent" type="checkbox"' + (state.leadForm.consent ? " checked" : "") + ">" +
                '<span>РЎРѕРіР»Р°СЃРµРЅ(Р°) РЅР° РѕР±СЂР°Р±РѕС‚РєСѓ РїРµСЂСЃРѕРЅР°Р»СЊРЅС‹С… РґР°РЅРЅС‹С… РїРѕ <a href="privacy.html" target="_blank" rel="noopener noreferrer">РїРѕР»РёС‚РёРєРµ РєРѕРЅС„РёРґРµРЅС†РёР°Р»СЊРЅРѕСЃС‚Рё</a>.</span>' +
            "</label>" +
            (state.leadError ? '<div class="chat-widget__error">' + escapeHtml(state.leadError) + "</div>" : "") +
            '<div class="chat-widget__form-actions">' +
                '<button class="chat-widget__back" id="chat-lead-back" type="button">Р’РµСЂРЅСѓС‚СЊСЃСЏ Рє С‡Р°С‚Сѓ</button>' +
                '<button class="chat-widget__submit" id="chat-lead-submit" type="button"' + (state.loading ? " disabled" : "") + ">" +
                    (state.loading ? "РћС‚РїСЂР°РІРєР°..." : "РћС‚РїСЂР°РІРёС‚СЊ Р·Р°СЏРІРєСѓ") +
                "</button>" +
            "</div>";

        bindLeadCard(wrap);
        return wrap;
    }

    function buildContactOption(value, label) {
        return '<label class="chat-widget__contact-option">' +
            '<input type="radio" name="chat-contact-type" value="' + value + '"' + (state.leadForm.contactType === value ? " checked" : "") + ">" +
            "<span>" + label + "</span>" +
        "</label>";
    }

    function bindLeadCard(scope) {
        var nameInput = scope.querySelector("#chat-lead-name");
        var contactInput = scope.querySelector("#chat-lead-contact");
        var questionInput = scope.querySelector("#chat-lead-question");
        var websiteInput = scope.querySelector("#chat-lead-website");
        var consentInput = scope.querySelector("#chat-lead-consent");
        var submitButton = scope.querySelector("#chat-lead-submit");
        var backButton = scope.querySelector("#chat-lead-back");

        scope.querySelectorAll('input[name="chat-contact-type"]').forEach(function (input) {
            input.addEventListener("change", function () {
                state.leadForm.contactType = input.value;
                render();
            });
        });

        if (nameInput) {
            nameInput.addEventListener("input", function () {
                state.leadForm.name = nameInput.value;
            });
        }

        if (contactInput) {
            contactInput.addEventListener("input", function () {
                state.leadForm.contactValue = contactInput.value;
            });
        }

        if (questionInput) {
            questionInput.addEventListener("input", function () {
                state.leadForm.question = questionInput.value;
            });
        }

        if (websiteInput) {
            websiteInput.addEventListener("input", function () {
                state.leadForm.website = websiteInput.value;
            });
        }

        if (consentInput) {
            consentInput.addEventListener("change", function () {
                state.leadForm.consent = consentInput.checked;
            });
        }

        if (submitButton) {
            submitButton.addEventListener("click", submitLead);
        }

        if (backButton) {
            backButton.addEventListener("click", function () {
                state.leadMode = false;
                state.leadError = "";
                render();
            });
        }
    }

    function submitMessage(rawValue) {
        var message = (rawValue || "").trim();
        if (!message || state.loading) return;

        state.hasInteraction = true;
        if (!state.leadForm.question) {
            state.leadForm.question = message;
        }

        addMessage("user", message);

        if (!state.apiConfigured) {
            showFallbackMessage();
            return;
        }

        state.loading = true;
        renderComposer();

        createSession()
            .then(function () {
                return apiRequest("/api/chat/message", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        sessionId: state.sessionId,
                        message: message,
                        sourcePage: window.location.pathname + window.location.search,
                        referrer: document.referrer || "",
                        landingUrl: window.location.href,
                        utmSource: getUtmValue("utm_source"),
                        utmMedium: getUtmValue("utm_medium"),
                        utmCampaign: getUtmValue("utm_campaign")
                    })
                }, CHAT_REQUEST_TIMEOUT);
            })
            .then(function (payload) {
                addMessage("bot", payload.reply || "РЎРїР°СЃРёР±Рѕ! РЇ РїРµСЂРµРґР°Рј РІРѕРїСЂРѕСЃ РґР°Р»СЊС€Рµ.");
                state.suggestions = payload.showLeadCta ? ["РћСЃС‚Р°РІРёС‚СЊ Р·Р°СЏРІРєСѓ"] : [];
                if (payload.nextStep === "capture_lead") {
                    openLeadMode();
                } else {
                    render();
                }
            })
            .catch(function (error) {
                showFallbackMessage(error && error.message);
            })
            .finally(function () {
                state.loading = false;
                render();
                var input = composerEl && composerEl.querySelector("#chat-widget-input");
                if (input) {
                    input.value = "";
                }
            });
    }

    function createSession() {
        if (state.sessionId) {
            return Promise.resolve(state.sessionId);
        }

        if (state.sessionPromise) {
            return state.sessionPromise;
        }

        state.sessionPromise = apiRequest("/api/chat/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sourcePage: window.location.pathname + window.location.search,
                referrer: document.referrer || "",
                userAgent: navigator.userAgent,
                landingUrl: window.location.href,
                utmSource: getUtmValue("utm_source"),
                utmMedium: getUtmValue("utm_medium"),
                utmCampaign: getUtmValue("utm_campaign")
            })
        }, 8000)
            .then(function (payload) {
                state.sessionId = payload.sessionId;
                return state.sessionId;
            })
            .finally(function () {
                state.sessionPromise = null;
            });

        return state.sessionPromise;
    }

    function openLeadMode() {
        state.hasInteraction = true;
        state.leadMode = true;
        state.leadError = "";

        if (!hasCapturePromptMessage()) {
            addMessage("bot", state.content.chatBot.capturePrompt);
        }

        render();
        focusPrimaryControl();
    }

    function hasCapturePromptMessage() {
        return state.messages.some(function (message) {
            return message.role === "bot" && message.text === state.content.chatBot.capturePrompt;
        });
    }

    function submitLead() {
        if (state.loading) return;

        state.leadError = validateLead();
        if (state.leadError) {
            render();
            return;
        }

        if (!state.apiConfigured) {
            state.leadError = "Backend РµС‰С‘ РЅРµ РїРѕРґРєР»СЋС‡С‘РЅ. РџРѕРєР° РёСЃРїРѕР»СЊР·СѓР№С‚Рµ Telegram.";
            render();
            return;
        }

        state.loading = true;
        render();

        createSession()
            .then(function () {
                return apiRequest("/api/chat/lead", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        sessionId: state.sessionId,
                        name: state.leadForm.name.trim(),
                        contactType: state.leadForm.contactType,
                        contactValue: state.leadForm.contactValue.trim(),
                        question: state.leadForm.question.trim(),
                        consent: state.leadForm.consent,
                        sourcePage: window.location.pathname + window.location.search,
                        referrer: document.referrer || "",
                        landingUrl: window.location.href,
                        utmSource: getUtmValue("utm_source"),
                        utmMedium: getUtmValue("utm_medium"),
                        utmCampaign: getUtmValue("utm_campaign"),
                        website: state.leadForm.website
                    })
                }, CHAT_REQUEST_TIMEOUT);
            })
            .then(function () {
                state.leadMode = false;
                state.leadError = "";
                state.suggestions = state.apiConfigured ? state.content.chatBot.quickReplies.slice() : [];
                addMessage("bot", state.content.chatBot.successMessage);
                state.leadForm = {
                    name: "",
                    contactType: "telegram",
                    contactValue: "",
                    question: "",
                    consent: false,
                    website: ""
                };
                render();
            })
            .catch(function (error) {
                state.leadError = error && error.message
                    ? error.message
                    : "РќРµ СѓРґР°Р»РѕСЃСЊ РѕС‚РїСЂР°РІРёС‚СЊ Р·Р°СЏРІРєСѓ. РџРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р· РёР»Рё РЅР°РїРёС€РёС‚Рµ РІ Telegram.";
                render();
            })
            .finally(function () {
                state.loading = false;
                render();
            });
    }

    function validateLead() {
        if (!state.leadForm.name.trim()) return "РЈРєР°Р¶РёС‚Рµ РёРјСЏ.";
        if (!state.leadForm.contactValue.trim()) return "РЈРєР°Р¶РёС‚Рµ РєРѕРЅС‚Р°РєС‚ РґР»СЏ СЃРІСЏР·Рё.";
        if (!state.leadForm.question.trim()) return "РћРїРёС€РёС‚Рµ РІРѕРїСЂРѕСЃ РёР»Рё Р·Р°РґР°С‡Сѓ.";
        if (!state.leadForm.consent) return "РќСѓР¶РЅРѕ СЃРѕРіР»Р°СЃРёРµ РЅР° РѕР±СЂР°Р±РѕС‚РєСѓ РїРµСЂСЃРѕРЅР°Р»СЊРЅС‹С… РґР°РЅРЅС‹С….";
        return "";
    }

    function showFallbackMessage(reason) {
        var text = state.content.chatBot.fallbackMessage;
        if (reason && reason.indexOf("РІСЂРµРјСЏ РѕР¶РёРґР°РЅРёСЏ") !== -1) {
            text = "Backend РѕС‚РІРµС‡Р°РµС‚ СЃР»РёС€РєРѕРј РґРѕР»РіРѕ. РџРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р· С‡РµСЂРµР· РїР°СЂСѓ СЃРµРєСѓРЅРґ РёР»Рё РЅР°РїРёС€РёС‚Рµ РІ Telegram.";
        }
        addMessage("bot", text);
        state.suggestions = [];
        render();
    }

    function apiRequest(path, options, timeoutMs) {
        var controller = "AbortController" in window ? new AbortController() : null;
        var timer = null;
        var requestOptions = options || {};

        if (controller && timeoutMs) {
            timer = window.setTimeout(function () {
                controller.abort();
            }, timeoutMs);
        }

        return fetch(buildApiUrl(path), {
            method: requestOptions.method || "GET",
            headers: requestOptions.headers || {},
            body: requestOptions.body,
            signal: controller ? controller.signal : undefined
        })
            .then(function (response) {
                if (!response.ok) {
                    return response.json().then(function (payload) {
                        throw new Error(payload && payload.error ? payload.error : "Request failed");
                    }).catch(function () {
                        throw new Error("Request failed");
                    });
                }
                return response.json();
            })
            .catch(function (error) {
                if (error && error.name === "AbortError") {
                    throw new Error("РџСЂРµРІС‹С€РµРЅРѕ РІСЂРµРјСЏ РѕР¶РёРґР°РЅРёСЏ РѕС‚РІРµС‚Р° backend");
                }
                throw error;
            })
            .finally(function () {
                if (timer) window.clearTimeout(timer);
            });
    }

    function addMessage(role, text) {
        state.messages.push({
            role: role,
            text: text
        });
        renderMessages();
    }

    function getInputPlaceholder() {
        if (!state.apiConfigured) {
            return "РџРѕРґРєР»СЋС‡РёС‚Рµ backend API РёР»Рё РёСЃРїРѕР»СЊР·СѓР№С‚Рµ Telegram";
        }
        return "РќР°РїРёС€РёС‚Рµ РІРѕРїСЂРѕСЃ Рѕ РїСЂРѕРµРєС‚Рµ";
    }

    function getContactLabel() {
        if (state.leadForm.contactType === "phone") return "РўРµР»РµС„РѕРЅ";
        if (state.leadForm.contactType === "email") return "Email";
        return "Telegram";
    }

    function getContactPlaceholder() {
        if (state.leadForm.contactType === "phone") return "+7 999 123 45 67";
        if (state.leadForm.contactType === "email") return "you@example.com";
        return "@username";
    }

    function buildApiUrl(path) {
        return apiBaseUrl + path;
    }

    function getUtmValue(name) {
        try {
            return new URL(window.location.href).searchParams.get(name) || "";
        } catch (error) {
            return "";
        }
    }

    function syncCookieOffset() {
        var banner = document.querySelector(".cookie-banner");
        var offset = 0;
        if (banner && !banner.hidden && !banner.classList.contains("is-hidden")) {
            offset = banner.offsetHeight + 16;
        }
        document.documentElement.style.setProperty("--snaf-chat-offset", offset + "px");
    }

    function escapeHtml(value) {
        var div = document.createElement("div");
        div.textContent = value || "";
        return div.innerHTML;
    }

    function escapeAttr(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();

