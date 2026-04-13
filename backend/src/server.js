require("dotenv").config();

const crypto = require("crypto");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const express = require("express");

const { createDatabase } = require("./database");
const { createContentCache } = require("./content-cache");
const { matchMessage } = require("./matcher");
const { sendTelegramLead } = require("./telegram");

const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const GITHUB_ADMIN_ALLOWLIST = String(process.env.GITHUB_ADMIN_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const SQLITE_PATH = process.env.SQLITE_PATH || "./data/snafstudio.sqlite";
const CONTENT_SOURCE_URL = process.env.CONTENT_SOURCE_URL || "https://snafstudio.ru/data/content.json";
const ADMIN_APP_URL = process.env.ADMIN_APP_URL || "";
const ADMIN_SESSION_TTL_HOURS = Number(process.env.ADMIN_SESSION_TTL_HOURS || 24);
const CONTENT_REFRESH_MS = Number(process.env.CONTENT_REFRESH_MS || 300000);
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "true") === "true";
const COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || "lax";
const ADMIN_COOKIE_NAME = "snaf_admin_session";
const LEAD_STATUSES = new Set(["new", "in_progress", "closed", "spam"]);
const LEAD_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const CONTENT_DEFAULT_SUCCESS = "Спасибо! Заявка сохранена.";

const app = express();
const database = createDatabase(SQLITE_PATH);
const contentCache = createContentCache({
    sourceUrl: CONTENT_SOURCE_URL,
    refreshMs: CONTENT_REFRESH_MS
});
const sessionRateLimiter = createRateLimiter({ max: 20, windowMs: 10 * 60 * 1000 });
const messageRateLimiter = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
const leadRateLimiter = createRateLimiter({ max: 12, windowMs: 60 * 60 * 1000 });

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error("CORS blocked for origin: " + origin));
    },
    credentials: true
}));
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());

app.get("/api/health", function (req, res) {
    res.json({
        ok: true,
        content: contentCache.getStatus()
    });
});

app.post("/api/chat/session", sessionRateLimiter, function (req, res) {
    const session = database.createSession({
        sourcePage: safeString(req.body.sourcePage || req.body.landingUrl),
        referrer: safeString(req.body.referrer),
        userAgent: safeString(req.body.userAgent || req.get("user-agent"))
    });

    res.status(201).json({
        sessionId: session.id
    });
});

app.post("/api/chat/message", messageRateLimiter, function (req, res) {
    const sessionId = safeString(req.body.sessionId);
    const message = safeString(req.body.message);

    if (!sessionId || !message) {
        res.status(400).json({ error: "sessionId and message are required" });
        return;
    }

    const session = database.getSession(sessionId);
    if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
    }

    database.appendTranscript(sessionId, {
        role: "user",
        text: message,
        createdAt: new Date().toISOString()
    });

    const result = matchMessage(message, contentCache.getContent() || {});
    database.updateSessionMatchType(sessionId, result.matchType);
    database.appendTranscript(sessionId, {
        role: "bot",
        text: result.reply,
        matchType: result.matchType,
        createdAt: new Date().toISOString()
    });

    res.json({
        reply: result.reply,
        matchType: result.matchType,
        nextStep: result.nextStep,
        showLeadCta: result.showLeadCta !== false
    });
});

app.post("/api/chat/lead", leadRateLimiter, async function (req, res) {
    const content = contentCache.getContent() || {};
    const successMessage = getSuccessMessage(content);
    const honeypot = safeString(req.body.website);
    const name = safeString(req.body.name);
    const contactType = safeString(req.body.contactType);
    const contactValue = safeString(req.body.contactValue);
    const question = safeString(req.body.question);
    const consent = Boolean(req.body.consent);
    const attribution = getAttributionPayload(req.body);

    if (honeypot) {
        res.status(202).json({
            ignored: true,
            message: successMessage
        });
        return;
    }

    if (!name || !contactType || !contactValue || !question || !consent) {
        res.status(400).json({ error: "name, contactType, contactValue, question, and consent are required" });
        return;
    }

    let sessionId = safeString(req.body.sessionId);
    if (!sessionId || !database.getSession(sessionId)) {
        sessionId = database.createSession({
            sourcePage: attribution.sourcePage,
            referrer: attribution.referrer,
            userAgent: safeString(req.get("user-agent"))
        }).id;
    }

    database.appendTranscript(sessionId, {
        role: "system",
        type: "lead_submission",
        text: "Lead submitted",
        payload: {
            name: name,
            contactType: contactType,
            contactValue: contactValue,
            question: question,
            sourceChannel: attribution.sourceChannel
        },
        createdAt: new Date().toISOString()
    });

    const session = database.getSession(sessionId);
    const duplicateLead = database.findDuplicateLead({
        contactType: contactType,
        contactValue: contactValue,
        question: question,
        windowHours: 12
    });

    if (duplicateLead && duplicateLead.sessionId !== sessionId) {
        const mergedLead = database.registerDuplicateLeadAttempt(duplicateLead.id, {
            actor: "chat-widget",
            sessionId: sessionId,
            sourcePage: attribution.sourcePage,
            referrer: attribution.referrer,
            userAgent: safeString(req.get("user-agent")),
            contactType: contactType,
            contactValue: contactValue,
            question: question,
            sourceChannel: attribution.sourceChannel,
            utmSource: attribution.utmSource,
            utmMedium: attribution.utmMedium,
            utmCampaign: attribution.utmCampaign
        });

        try {
            await sendTelegramLead({
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
                lead: mergedLead,
                duplicate: true,
                adminAppUrl: buildLeadAdminUrl(mergedLead.id)
            });
            database.markLeadTelegramNotified(mergedLead.id);
        } catch (error) {
            console.error("[telegram]", error.message);
        }

        res.status(200).json({
            leadId: mergedLead.id,
            deduplicated: true,
            message: successMessage
        });
        return;
    }

    const lead = database.saveLead({
        actor: "chat-widget",
        sessionId: sessionId,
        visitorName: name,
        contactType: contactType,
        contactValue: contactValue,
        question: question,
        sourcePage: attribution.sourcePage,
        referrer: attribution.referrer,
        userAgent: safeString(req.get("user-agent")),
        matchType: session ? session.matchType : "handoff",
        status: "new",
        priority: "normal",
        sourceChannel: attribution.sourceChannel,
        utmSource: attribution.utmSource,
        utmMedium: attribution.utmMedium,
        utmCampaign: attribution.utmCampaign
    });

    try {
        await sendTelegramLead({
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            chatId: process.env.TELEGRAM_CHAT_ID,
            lead: lead,
            adminAppUrl: buildLeadAdminUrl(lead.id)
        });
        database.markLeadTelegramNotified(lead.id);
    } catch (error) {
        console.error("[telegram]", error.message);
    }

    res.status(201).json({
        leadId: lead.id,
        message: successMessage
    });
});

app.post("/api/admin/auth/github", async function (req, res) {
    if (!GITHUB_ADMIN_ALLOWLIST.length) {
        res.status(500).json({ error: "GITHUB_ADMIN_ALLOWLIST is not configured" });
        return;
    }

    const token = safeString(req.body.token);
    if (!token) {
        res.status(400).json({ error: "token is required" });
        return;
    }

    try {
        const user = await fetchGithubUser(token);
        if (!GITHUB_ADMIN_ALLOWLIST.includes(String(user.login || "").toLowerCase())) {
            res.status(403).json({ error: "GitHub user is not allowed" });
            return;
        }

        res.cookie(ADMIN_COOKIE_NAME, signAdminSession(user.login), getCookieOptions());
        res.json({
            ok: true,
            username: user.login
        });
    } catch (error) {
        res.status(401).json({ error: error.message || "GitHub token is invalid" });
    }
});

app.post("/api/admin/logout", function (req, res) {
    res.clearCookie(ADMIN_COOKIE_NAME, getCookieOptions());
    res.json({ ok: true });
});

app.get("/api/admin/dashboard", requireAdmin, function (req, res) {
    res.json(database.getDashboardMetrics());
});

app.get("/api/admin/inbox", requireAdmin, function (req, res) {
    res.json(database.listLeads({
        status: safeString(req.query.status || "all"),
        q: safeString(req.query.q),
        priority: safeString(req.query.priority || "all"),
        assignedTo: safeString(req.query.assignedTo),
        sourceChannel: safeString(req.query.sourceChannel || "all").toLowerCase(),
        dateFrom: safeString(req.query.dateFrom),
        dateTo: safeString(req.query.dateTo),
        hasReminder: safeString(req.query.hasReminder || "all"),
        sort: safeString(req.query.sort || "newest")
    }));
});

app.get("/api/admin/inbox/:id", requireAdmin, function (req, res) {
    const lead = database.getLead(req.params.id);
    if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }

    res.json({ item: lead });
});

app.patch("/api/admin/inbox/:id", requireAdmin, function (req, res) {
    const nextStatus = req.body.status !== undefined ? safeString(req.body.status) : undefined;
    const priority = req.body.priority !== undefined ? safeString(req.body.priority) : undefined;
    const internalNote = req.body.internalNote !== undefined ? safeString(req.body.internalNote) : undefined;
    const assignedTo = req.body.assignedTo !== undefined ? safeString(req.body.assignedTo) : undefined;
    const sourceChannel = req.body.sourceChannel !== undefined ? safeString(req.body.sourceChannel).toLowerCase() : undefined;
    const closedReason = req.body.closedReason !== undefined ? safeString(req.body.closedReason) : undefined;
    const nextFollowUpAt = req.body.nextFollowUpAt !== undefined ? normalizeDateInput(req.body.nextFollowUpAt) : undefined;
    const lastContactAt = req.body.lastContactAt !== undefined ? normalizeDateInput(req.body.lastContactAt) : undefined;
    const contactAttempts = req.body.contactAttempts !== undefined ? Number.parseInt(req.body.contactAttempts, 10) : undefined;

    if (nextStatus && !LEAD_STATUSES.has(nextStatus)) {
        res.status(400).json({ error: "Unknown lead status" });
        return;
    }

    if (priority && !LEAD_PRIORITIES.has(priority)) {
        res.status(400).json({ error: "Unknown lead priority" });
        return;
    }

    if (req.body.nextFollowUpAt !== undefined && req.body.nextFollowUpAt !== "" && nextFollowUpAt === null) {
        res.status(400).json({ error: "Invalid nextFollowUpAt" });
        return;
    }

    if (req.body.lastContactAt !== undefined && req.body.lastContactAt !== "" && lastContactAt === null) {
        res.status(400).json({ error: "Invalid lastContactAt" });
        return;
    }

    if (contactAttempts !== undefined && (!Number.isInteger(contactAttempts) || contactAttempts < 0)) {
        res.status(400).json({ error: "contactAttempts must be a non-negative integer" });
        return;
    }

    const updated = database.updateLead(req.params.id, {
        status: nextStatus,
        priority: priority,
        internalNote: internalNote,
        assignedTo: assignedTo,
        sourceChannel: sourceChannel,
        closedReason: closedReason,
        nextFollowUpAt: nextFollowUpAt,
        lastContactAt: lastContactAt,
        contactAttempts: contactAttempts
    }, {
        actor: req.admin.username || "admin"
    });

    if (!updated) {
        res.status(404).json({ error: "Lead not found" });
        return;
    }

    res.json({ item: updated });
});

app.use(function (error, req, res, next) {
    if (error && error.message && error.message.indexOf("CORS blocked") === 0) {
        res.status(403).json({ error: error.message });
        return;
    }

    console.error("[server]", error);
    res.status(500).json({ error: "Internal server error" });
});

contentCache.start()
    .catch(function (error) {
        console.error("[content-cache]", error.message);
    })
    .finally(function () {
        app.listen(PORT, function () {
            console.log("[snaf-backend] listening on port " + PORT);
        });
    });

function requireAdmin(req, res, next) {
    const session = verifyAdminSession(req.cookies[ADMIN_COOKIE_NAME]);
    if (!session) {
        res.status(401).json({ error: "Admin session required" });
        return;
    }

    req.admin = session;
    next();
}

async function fetchGithubUser(token) {
    const response = await fetch("https://api.github.com/user", {
        headers: {
            Authorization: "token " + token,
            "User-Agent": "snafstudio-backend"
        }
    });

    if (!response.ok) {
        throw new Error("GitHub token is invalid");
    }

    return response.json();
}

function signAdminSession(username) {
    const payload = {
        username: username,
        exp: Date.now() + (ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000)
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", SESSION_SECRET).update(encoded).digest("base64url");
    return encoded + "." + signature;
}

function verifyAdminSession(token) {
    if (!token || token.indexOf(".") === -1) {
        return null;
    }

    const parts = token.split(".");
    const encoded = parts[0];
    const signature = parts[1];
    const expectedSignature = crypto.createHmac("sha256", SESSION_SECRET).update(encoded).digest("base64url");
    if (!safeCompare(signature, expectedSignature)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (!payload.exp || payload.exp < Date.now()) {
            return null;
        }
        return payload;
    } catch (error) {
        return null;
    }
}

function getCookieOptions() {
    return {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: COOKIE_SAME_SITE,
        maxAge: ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000,
        path: "/"
    };
}

function safeCompare(left, right) {
    try {
        return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
    } catch (error) {
        return false;
    }
}

function safeString(value) {
    return String(value || "").trim();
}

function getSuccessMessage(content) {
    return content.chatBot && content.chatBot.successMessage
        ? content.chatBot.successMessage
        : CONTENT_DEFAULT_SUCCESS;
}

function getAttributionPayload(body) {
    const sourcePage = safeString(body.sourcePage || body.landingUrl || "/");
    const referrer = safeString(body.referrer);
    const url = parseUrlLike(sourcePage);
    const utmSource = safeString(body.utmSource || url.searchParams.get("utm_source"));
    const utmMedium = safeString(body.utmMedium || url.searchParams.get("utm_medium"));
    const utmCampaign = safeString(body.utmCampaign || url.searchParams.get("utm_campaign"));

    return {
        sourcePage: sourcePage,
        referrer: referrer,
        utmSource: utmSource,
        utmMedium: utmMedium,
        utmCampaign: utmCampaign,
        sourceChannel: detectSourceChannel({
            utmSource: utmSource,
            utmMedium: utmMedium,
            referrer: referrer
        })
    };
}

function detectSourceChannel(input) {
    const utmSource = safeString(input.utmSource).toLowerCase();
    const utmMedium = safeString(input.utmMedium).toLowerCase();
    const referrer = safeString(input.referrer);

    if (utmSource) {
        return utmSource;
    }

    if (utmMedium) {
        return utmMedium;
    }

    if (!referrer) {
        return "direct";
    }

    try {
        const host = new URL(referrer).hostname.toLowerCase();
        if (host.indexOf("t.me") !== -1 || host.indexOf("telegram") !== -1) return "telegram";
        if (host.indexOf("vk.com") !== -1) return "vk";
        if (host.indexOf("google.") !== -1) return "google";
        if (host.indexOf("yandex.") !== -1) return "yandex";
        if (host.indexOf("bing.") !== -1) return "bing";
        return host.replace(/^www\./, "") || "referral";
    } catch (error) {
        return "referral";
    }
}

function parseUrlLike(value) {
    try {
        return new URL(value, "https://snafstudio.ru");
    } catch (error) {
        return new URL("https://snafstudio.ru/");
    }
}

function buildLeadAdminUrl(leadId) {
    if (!ADMIN_APP_URL) return "";

    try {
        const url = new URL(ADMIN_APP_URL);
        url.searchParams.set("lead", leadId);
        return url.toString();
    } catch (error) {
        return ADMIN_APP_URL + (ADMIN_APP_URL.indexOf("?") === -1 ? "?" : "&") + "lead=" + encodeURIComponent(leadId);
    }
}

function normalizeDateInput(value) {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toISOString();
}

function createRateLimiter(options) {
    const max = Number(options.max || 30);
    const windowMs = Number(options.windowMs || 60000);
    const store = new Map();

    return function rateLimiter(req, res, next) {
        const now = Date.now();
        const key = safeString(req.ip || req.headers["x-forwarded-for"] || "unknown");
        const existing = (store.get(key) || []).filter(function (timestamp) {
            return now - timestamp < windowMs;
        });

        if (existing.length >= max) {
            res.status(429).json({ error: "Too many requests. Please try again later." });
            return;
        }

        existing.push(now);
        store.set(key, existing);
        next();
    };
}
