const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const LEAD_PRIORITIES = ["low", "normal", "high", "urgent"];

function createDatabase(filePath) {
    const resolvedPath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    const db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");

    db.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            source_page TEXT,
            referrer TEXT,
            user_agent TEXT,
            transcript TEXT NOT NULL,
            first_question TEXT,
            match_type TEXT DEFAULT 'fallback'
        );

        CREATE TABLE IF NOT EXISTS leads (
            id TEXT PRIMARY KEY,
            session_id TEXT UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            status TEXT NOT NULL,
            source_page TEXT,
            referrer TEXT,
            user_agent TEXT,
            visitor_name TEXT,
            contact_type TEXT,
            contact_value TEXT,
            first_question TEXT,
            transcript TEXT NOT NULL,
            match_type TEXT,
            internal_note TEXT DEFAULT '',
            telegram_notified_at TEXT
        );

        CREATE TABLE IF NOT EXISTS lead_events (
            id TEXT PRIMARY KEY,
            lead_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            type TEXT NOT NULL,
            actor TEXT,
            summary TEXT NOT NULL,
            payload TEXT DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
        CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_lead_events_lead_id ON lead_events(lead_id);
        CREATE INDEX IF NOT EXISTS idx_lead_events_created_at ON lead_events(created_at DESC);
    `);

    ensureLeadColumns(db);

    function createSession(meta) {
        const now = new Date().toISOString();
        const session = {
            id: crypto.randomUUID(),
            created_at: now,
            updated_at: now,
            source_page: meta.sourcePage || "",
            referrer: meta.referrer || "",
            user_agent: meta.userAgent || "",
            transcript: "[]",
            first_question: null,
            match_type: "fallback"
        };

        db.prepare(`
            INSERT INTO chat_sessions (
                id, created_at, updated_at, source_page, referrer, user_agent, transcript, first_question, match_type
            )
            VALUES (
                @id, @created_at, @updated_at, @source_page, @referrer, @user_agent, @transcript, @first_question, @match_type
            )
        `).run(session);

        return mapSession(session);
    }

    function getSessionRow(sessionId) {
        return db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(sessionId) || null;
    }

    function getSession(sessionId) {
        const row = getSessionRow(sessionId);
        return row ? mapSession(row) : null;
    }

    function appendTranscript(sessionId, entry) {
        const row = getSessionRow(sessionId);
        if (!row) return null;

        const transcript = parseTranscript(row.transcript);
        transcript.push(entry);

        const firstQuestion = row.first_question || (
            entry.role === "user" && entry.text ? entry.text : null
        );

        db.prepare(`
            UPDATE chat_sessions
            SET transcript = ?, updated_at = ?, first_question = COALESCE(?, first_question)
            WHERE id = ?
        `).run(JSON.stringify(transcript), new Date().toISOString(), firstQuestion, sessionId);

        return getSession(sessionId);
    }

    function updateSessionMatchType(sessionId, matchType) {
        db.prepare(`
            UPDATE chat_sessions
            SET match_type = ?, updated_at = ?
            WHERE id = ?
        `).run(matchType, new Date().toISOString(), sessionId);
    }

    function saveLead(data) {
        const now = new Date().toISOString();
        const sessionRow = data.sessionId ? getSessionRow(data.sessionId) : null;
        const transcript = sessionRow ? parseTranscript(sessionRow.transcript) : [];
        const existingLead = data.sessionId
            ? db.prepare("SELECT id, created_at FROM leads WHERE session_id = ?").get(data.sessionId)
            : null;
        const isNewLead = !existingLead;

        const lead = {
            id: existingLead ? existingLead.id : crypto.randomUUID(),
            session_id: data.sessionId || null,
            created_at: existingLead ? existingLead.created_at : now,
            updated_at: now,
            status: data.status || "new",
            source_page: data.sourcePage || (sessionRow ? sessionRow.source_page : ""),
            referrer: data.referrer || (sessionRow ? sessionRow.referrer : ""),
            user_agent: data.userAgent || (sessionRow ? sessionRow.user_agent : ""),
            visitor_name: data.visitorName || "",
            contact_type: data.contactType || "",
            contact_value: data.contactValue || "",
            first_question: (sessionRow && sessionRow.first_question) || data.question || "",
            transcript: JSON.stringify(transcript),
            match_type: data.matchType || (sessionRow ? sessionRow.match_type : "handoff"),
            internal_note: data.internalNote || "",
            telegram_notified_at: data.telegramNotifiedAt || null,
            priority: normalizePriority(data.priority),
            assigned_to: data.assignedTo || "",
            source_channel: data.sourceChannel || "unknown",
            utm_source: data.utmSource || "",
            utm_medium: data.utmMedium || "",
            utm_campaign: data.utmCampaign || "",
            last_contact_at: data.lastContactAt || null,
            next_follow_up_at: data.nextFollowUpAt || null,
            closed_reason: data.closedReason || "",
            contact_attempts: safeInteger(data.contactAttempts)
        };

        db.prepare(`
            INSERT INTO leads (
                id, session_id, created_at, updated_at, status, source_page, referrer, user_agent,
                visitor_name, contact_type, contact_value, first_question, transcript, match_type,
                internal_note, telegram_notified_at, priority, assigned_to, source_channel,
                utm_source, utm_medium, utm_campaign, last_contact_at, next_follow_up_at,
                closed_reason, contact_attempts
            )
            VALUES (
                @id, @session_id, @created_at, @updated_at, @status, @source_page, @referrer, @user_agent,
                @visitor_name, @contact_type, @contact_value, @first_question, @transcript, @match_type,
                @internal_note, @telegram_notified_at, @priority, @assigned_to, @source_channel,
                @utm_source, @utm_medium, @utm_campaign, @last_contact_at, @next_follow_up_at,
                @closed_reason, @contact_attempts
            )
            ON CONFLICT(id) DO UPDATE SET
                session_id = excluded.session_id,
                updated_at = excluded.updated_at,
                status = excluded.status,
                source_page = excluded.source_page,
                referrer = excluded.referrer,
                user_agent = excluded.user_agent,
                visitor_name = excluded.visitor_name,
                contact_type = excluded.contact_type,
                contact_value = excluded.contact_value,
                first_question = excluded.first_question,
                transcript = excluded.transcript,
                match_type = excluded.match_type,
                internal_note = excluded.internal_note,
                telegram_notified_at = excluded.telegram_notified_at,
                priority = excluded.priority,
                assigned_to = excluded.assigned_to,
                source_channel = excluded.source_channel,
                utm_source = excluded.utm_source,
                utm_medium = excluded.utm_medium,
                utm_campaign = excluded.utm_campaign,
                last_contact_at = excluded.last_contact_at,
                next_follow_up_at = excluded.next_follow_up_at,
                closed_reason = excluded.closed_reason,
                contact_attempts = excluded.contact_attempts
        `).run(lead);

        if (isNewLead) {
            recordLeadEvent({
                leadId: lead.id,
                type: "created",
                actor: data.actor || "system",
                summary: "Создана новая заявка",
                payload: {
                    priority: lead.priority,
                    sourceChannel: lead.source_channel,
                    matchType: lead.match_type
                }
            });
        }

        return getLead(lead.id);
    }

    function findDuplicateLead(criteria) {
        if (!criteria.contactType || !criteria.contactValue || !criteria.question) {
            return null;
        }

        const cutoff = new Date(Date.now() - (safeInteger(criteria.windowHours, 12) * 60 * 60 * 1000)).toISOString();
        const rows = db.prepare(`
            SELECT *
            FROM leads
            WHERE lower(contact_type) = lower(@contactType)
              AND lower(contact_value) = lower(@contactValue)
              AND datetime(created_at) >= datetime(@cutoff)
            ORDER BY datetime(created_at) DESC
            LIMIT 10
        `).all({
            contactType: criteria.contactType,
            contactValue: criteria.contactValue,
            cutoff: cutoff
        });

        const duplicateRow = rows.find(function (row) {
            return isLikelyDuplicateQuestion(criteria.question, row.first_question);
        });

        return duplicateRow ? mapLead(duplicateRow) : null;
    }

    function registerDuplicateLeadAttempt(leadId, data) {
        const current = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
        if (!current) return null;

        const now = new Date().toISOString();
        const sessionRow = data.sessionId ? getSessionRow(data.sessionId) : null;
        const mergedTranscript = mergeTranscripts(
            parseTranscript(current.transcript),
            sessionRow ? parseTranscript(sessionRow.transcript) : []
        );

        const next = {
            id: current.id,
            updated_at: now,
            source_page: current.source_page || data.sourcePage || (sessionRow ? sessionRow.source_page : ""),
            referrer: current.referrer || data.referrer || (sessionRow ? sessionRow.referrer : ""),
            user_agent: current.user_agent || data.userAgent || (sessionRow ? sessionRow.user_agent : ""),
            transcript: JSON.stringify(mergedTranscript),
            source_channel: current.source_channel && current.source_channel !== "unknown"
                ? current.source_channel
                : (data.sourceChannel || "unknown"),
            utm_source: current.utm_source || data.utmSource || "",
            utm_medium: current.utm_medium || data.utmMedium || "",
            utm_campaign: current.utm_campaign || data.utmCampaign || ""
        };

        db.prepare(`
            UPDATE leads
            SET updated_at = @updated_at,
                source_page = @source_page,
                referrer = @referrer,
                user_agent = @user_agent,
                transcript = @transcript,
                source_channel = @source_channel,
                utm_source = @utm_source,
                utm_medium = @utm_medium,
                utm_campaign = @utm_campaign
            WHERE id = @id
        `).run(next);

        recordLeadEvent({
            leadId: leadId,
            type: "duplicate_submission",
            actor: data.actor || "system",
            summary: "Повторная заявка объединена с существующей карточкой",
            payload: {
                contactType: data.contactType || "",
                contactValue: data.contactValue || "",
                question: data.question || "",
                sourceChannel: next.source_channel
            }
        });

        return getLead(leadId);
    }

    function markLeadTelegramNotified(leadId) {
        db.prepare(`
            UPDATE leads
            SET telegram_notified_at = ?, updated_at = ?
            WHERE id = ?
        `).run(new Date().toISOString(), new Date().toISOString(), leadId);
        return getLead(leadId);
    }

    function listLeads(filters) {
        const normalizedFilters = normalizeLeadFilters(filters);
        const listQuery = buildLeadQuery(normalizedFilters, false);
        const countQuery = buildLeadQuery(normalizedFilters, true);

        const rows = db.prepare(`
            SELECT *
            FROM leads
            ${listQuery.whereSql}
            ORDER BY ${listQuery.orderBy}
        `).all(listQuery.params);

        const counts = {
            all: db.prepare(`
                SELECT COUNT(*) AS total
                FROM leads
                ${countQuery.whereSql}
            `).get(countQuery.params).total
        };

        db.prepare(`
            SELECT status, COUNT(*) AS total
            FROM leads
            ${countQuery.whereSql}
            GROUP BY status
        `).all(countQuery.params).forEach(function (row) {
            counts[row.status] = row.total;
        });

        return {
            items: rows.map(mapLead),
            counts: counts
        };
    }

    function getLead(leadId) {
        const row = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
        if (!row) return null;

        const lead = mapLead(row);
        lead.events = listLeadEvents(leadId);
        return lead;
    }

    function updateLead(leadId, patch, options) {
        const current = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
        if (!current) return null;

        const now = new Date().toISOString();
        const actor = (options && options.actor) || "admin";
        const next = {
            id: current.id,
            updated_at: now,
            status: current.status,
            internal_note: current.internal_note || "",
            priority: normalizePriority(current.priority),
            assigned_to: current.assigned_to || "",
            source_channel: current.source_channel || "unknown",
            utm_source: current.utm_source || "",
            utm_medium: current.utm_medium || "",
            utm_campaign: current.utm_campaign || "",
            last_contact_at: current.last_contact_at || null,
            next_follow_up_at: current.next_follow_up_at || null,
            closed_reason: current.closed_reason || "",
            contact_attempts: safeInteger(current.contact_attempts),
            telegram_notified_at: current.telegram_notified_at || null
        };
        const events = [];
        let changed = false;

        if (patch.status !== undefined && patch.status !== current.status) {
            next.status = patch.status;
            changed = true;
            events.push({
                type: patch.status === "closed" ? "closed" : "status_changed",
                summary: patch.status === "closed"
                    ? "Заявка закрыта"
                    : "Статус изменён на " + getStatusLabel(patch.status),
                payload: {
                    from: current.status,
                    to: patch.status
                }
            });
        }

        if (patch.internalNote !== undefined && patch.internalNote !== (current.internal_note || "")) {
            next.internal_note = patch.internalNote;
            changed = true;
            events.push({
                type: "note_updated",
                summary: patch.internalNote ? "Обновлена внутренняя заметка" : "Внутренняя заметка очищена",
                payload: {
                    hasText: Boolean(patch.internalNote)
                }
            });
        }

        if (patch.priority !== undefined && normalizePriority(patch.priority) !== normalizePriority(current.priority)) {
            next.priority = normalizePriority(patch.priority);
            changed = true;
            events.push({
                type: "priority_changed",
                summary: "Приоритет изменён на " + getPriorityLabel(next.priority),
                payload: {
                    from: normalizePriority(current.priority),
                    to: next.priority
                }
            });
        }

        if (patch.assignedTo !== undefined && patch.assignedTo !== (current.assigned_to || "")) {
            next.assigned_to = patch.assignedTo;
            changed = true;
            events.push({
                type: "assigned",
                summary: patch.assignedTo ? "Назначен ответственный: " + patch.assignedTo : "Ответственный снят",
                payload: {
                    from: current.assigned_to || "",
                    to: patch.assignedTo || ""
                }
            });
        }

        if (patch.sourceChannel !== undefined && patch.sourceChannel !== (current.source_channel || "unknown")) {
            next.source_channel = patch.sourceChannel || "unknown";
            changed = true;
            events.push({
                type: "source_updated",
                summary: "Источник обновлён",
                payload: {
                    from: current.source_channel || "unknown",
                    to: next.source_channel
                }
            });
        }

        if (patch.closedReason !== undefined && patch.closedReason !== (current.closed_reason || "")) {
            next.closed_reason = patch.closedReason;
            changed = true;
            events.push({
                type: "closed_reason_updated",
                summary: patch.closedReason ? "Обновлена причина закрытия" : "Причина закрытия очищена",
                payload: {
                    hasText: Boolean(patch.closedReason)
                }
            });
        }

        if (patch.nextFollowUpAt !== undefined && patch.nextFollowUpAt !== (current.next_follow_up_at || null)) {
            next.next_follow_up_at = patch.nextFollowUpAt;
            changed = true;
            events.push({
                type: patch.nextFollowUpAt ? "follow_up_set" : "follow_up_cleared",
                summary: patch.nextFollowUpAt
                    ? "Назначен follow-up на " + patch.nextFollowUpAt
                    : "Follow-up снят",
                payload: {
                    from: current.next_follow_up_at || null,
                    to: patch.nextFollowUpAt || null
                }
            });
        }

        if (patch.contactAttempts !== undefined) {
            const nextContactAttempts = safeInteger(patch.contactAttempts);
            if (nextContactAttempts !== safeInteger(current.contact_attempts)) {
                next.contact_attempts = nextContactAttempts;
                changed = true;
                if (nextContactAttempts > safeInteger(current.contact_attempts)) {
                    next.last_contact_at = patch.lastContactAt || now;
                    events.push({
                        type: "contact_attempt",
                        summary: "Отмечен новый контакт с лидом",
                        payload: {
                            contactAttempts: nextContactAttempts,
                            lastContactAt: next.last_contact_at
                        }
                    });
                } else {
                    events.push({
                        type: "contact_attempts_updated",
                        summary: "РћР±РЅРѕРІР»РµРЅРѕ С‡РёСЃР»Рѕ РєРѕРЅС‚Р°РєС‚РѕРІ СЃ Р»РёРґРѕРј",
                        payload: {
                            from: safeInteger(current.contact_attempts),
                            to: nextContactAttempts
                        }
                    });
                }
            }
        }

        if (patch.lastContactAt !== undefined && patch.lastContactAt !== (current.last_contact_at || null)) {
            next.last_contact_at = patch.lastContactAt;
            changed = true;
            if (!events.some(function (event) { return event.type === "contact_attempt"; })) {
                events.push({
                    type: "contact_attempt",
                    summary: patch.lastContactAt ? "Обновлена дата последнего контакта" : "Дата последнего контакта очищена",
                    payload: {
                        lastContactAt: patch.lastContactAt || null,
                        contactAttempts: next.contact_attempts
                    }
                });
            }
        }

        if (!changed) {
            return getLead(leadId);
        }

        db.prepare(`
            UPDATE leads
            SET updated_at = @updated_at,
                status = @status,
                internal_note = @internal_note,
                priority = @priority,
                assigned_to = @assigned_to,
                source_channel = @source_channel,
                utm_source = @utm_source,
                utm_medium = @utm_medium,
                utm_campaign = @utm_campaign,
                last_contact_at = @last_contact_at,
                next_follow_up_at = @next_follow_up_at,
                closed_reason = @closed_reason,
                contact_attempts = @contact_attempts,
                telegram_notified_at = @telegram_notified_at
            WHERE id = @id
        `).run(next);

        events.forEach(function (event) {
            recordLeadEvent({
                leadId: leadId,
                actor: actor,
                type: event.type,
                summary: event.summary,
                payload: event.payload
            });
        });

        return getLead(leadId);
    }

    function getDashboardMetrics() {
        const dayStart = startOfDay(new Date()).toISOString();
        const weekStart = startOfDay(new Date(Date.now() - (6 * 24 * 60 * 60 * 1000))).toISOString();

        const totals = db.prepare(`
            SELECT
                COUNT(*) AS totalLeads,
                SUM(CASE WHEN datetime(created_at) >= datetime(@dayStart) THEN 1 ELSE 0 END) AS newToday,
                SUM(CASE WHEN datetime(created_at) >= datetime(@weekStart) THEN 1 ELSE 0 END) AS newThisWeek,
                SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS inProgress,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
                SUM(CASE WHEN status = 'spam' THEN 1 ELSE 0 END) AS spam,
                SUM(CASE WHEN status IN ('new', 'in_progress') AND priority IN ('high', 'urgent') THEN 1 ELSE 0 END) AS highPriorityOpen,
                SUM(CASE WHEN next_follow_up_at IS NOT NULL AND datetime(next_follow_up_at) < datetime('now') AND status NOT IN ('closed', 'spam') THEN 1 ELSE 0 END) AS overdueFollowUps,
                SUM(CASE WHEN next_follow_up_at IS NOT NULL AND datetime(next_follow_up_at) >= datetime('now') AND status NOT IN ('closed', 'spam') THEN 1 ELSE 0 END) AS scheduledFollowUps
            FROM leads
        `).get({
            dayStart: dayStart,
            weekStart: weekStart
        });

        const avgRow = db.prepare(`
            SELECT AVG(response_minutes) AS avgFirstResponseMinutes
            FROM (
                SELECT
                    (julianday(MIN(events.created_at)) - julianday(leads.created_at)) * 1440 AS response_minutes
                FROM leads
                JOIN lead_events AS events
                    ON events.lead_id = leads.id
                WHERE events.type = 'contact_attempt'
                GROUP BY leads.id
            )
        `).get();

        const sourceBreakdown = db.prepare(`
            SELECT source_channel AS sourceChannel, COUNT(*) AS total
            FROM leads
            GROUP BY source_channel
            ORDER BY total DESC, source_channel ASC
            LIMIT 5
        `).all();

        return {
            totalLeads: safeInteger(totals.totalLeads),
            newToday: safeInteger(totals.newToday),
            newThisWeek: safeInteger(totals.newThisWeek),
            inProgress: safeInteger(totals.inProgress),
            closed: safeInteger(totals.closed),
            spam: safeInteger(totals.spam),
            highPriorityOpen: safeInteger(totals.highPriorityOpen),
            overdueFollowUps: safeInteger(totals.overdueFollowUps),
            scheduledFollowUps: safeInteger(totals.scheduledFollowUps),
            avgFirstResponseMinutes: avgRow && avgRow.avgFirstResponseMinutes !== null
                ? Number(avgRow.avgFirstResponseMinutes.toFixed(1))
                : null,
            sourceBreakdown: sourceBreakdown.map(function (row) {
                return {
                    sourceChannel: row.sourceChannel || "unknown",
                    total: safeInteger(row.total)
                };
            })
        };
    }

    function listLeadEvents(leadId) {
        return db.prepare(`
            SELECT *
            FROM lead_events
            WHERE lead_id = ?
            ORDER BY datetime(created_at) DESC, rowid DESC
        `).all(leadId).map(mapLeadEvent);
    }

    function recordLeadEvent(data) {
        const event = {
            id: crypto.randomUUID(),
            lead_id: data.leadId,
            created_at: new Date().toISOString(),
            type: data.type,
            actor: data.actor || "system",
            summary: data.summary || "",
            payload: JSON.stringify(data.payload || {})
        };

        db.prepare(`
            INSERT INTO lead_events (id, lead_id, created_at, type, actor, summary, payload)
            VALUES (@id, @lead_id, @created_at, @type, @actor, @summary, @payload)
        `).run(event);

        return mapLeadEvent(event);
    }

    return {
        createSession,
        getSession,
        appendTranscript,
        updateSessionMatchType,
        saveLead,
        findDuplicateLead,
        registerDuplicateLeadAttempt,
        getLead,
        listLeads,
        updateLead,
        markLeadTelegramNotified,
        getDashboardMetrics,
        recordLeadEvent
    };
}

function ensureLeadColumns(db) {
    const existing = new Set(
        db.prepare("PRAGMA table_info(leads)").all().map(function (row) {
            return row.name;
        })
    );

    [
        { name: "priority", sql: "TEXT DEFAULT 'normal'" },
        { name: "assigned_to", sql: "TEXT DEFAULT ''" },
        { name: "source_channel", sql: "TEXT DEFAULT 'unknown'" },
        { name: "utm_source", sql: "TEXT DEFAULT ''" },
        { name: "utm_medium", sql: "TEXT DEFAULT ''" },
        { name: "utm_campaign", sql: "TEXT DEFAULT ''" },
        { name: "last_contact_at", sql: "TEXT" },
        { name: "next_follow_up_at", sql: "TEXT" },
        { name: "closed_reason", sql: "TEXT DEFAULT ''" },
        { name: "contact_attempts", sql: "INTEGER DEFAULT 0" }
    ].forEach(function (column) {
        if (!existing.has(column.name)) {
            db.exec("ALTER TABLE leads ADD COLUMN " + column.name + " " + column.sql);
        }
    });
}

function normalizeLeadFilters(filters) {
    const next = filters || {};
    return {
        status: next.status || "all",
        q: String(next.q || "").trim(),
        priority: String(next.priority || "all").trim(),
        assignedTo: String(next.assignedTo || "").trim(),
        sourceChannel: String(next.sourceChannel || "all").trim(),
        dateFrom: String(next.dateFrom || "").trim(),
        dateTo: String(next.dateTo || "").trim(),
        hasReminder: String(next.hasReminder || "all").trim(),
        sort: String(next.sort || "newest").trim()
    };
}

function buildLeadQuery(filters, skipStatus) {
    const clauses = [];
    const params = {};

    if (!skipStatus && filters.status && filters.status !== "all") {
        clauses.push("status = @status");
        params.status = filters.status;
    }

    if (filters.q) {
        clauses.push(`
            (
                lower(visitor_name) LIKE @q OR
                lower(contact_value) LIKE @q OR
                lower(first_question) LIKE @q OR
                lower(internal_note) LIKE @q OR
                lower(assigned_to) LIKE @q
            )
        `);
        params.q = "%" + filters.q.toLowerCase() + "%";
    }

    if (filters.priority && filters.priority !== "all") {
        clauses.push("priority = @priority");
        params.priority = filters.priority;
    }

    if (filters.assignedTo) {
        clauses.push("lower(assigned_to) LIKE @assignedTo");
        params.assignedTo = "%" + filters.assignedTo.toLowerCase() + "%";
    }

    if (filters.sourceChannel && filters.sourceChannel !== "all") {
        clauses.push("lower(source_channel) = @sourceChannel");
        params.sourceChannel = filters.sourceChannel.toLowerCase();
    }

    if (filters.dateFrom) {
        clauses.push("datetime(created_at) >= datetime(@dateFrom)");
        params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
        clauses.push("datetime(created_at) < datetime(@dateTo)");
        params.dateTo = addDays(filters.dateTo, 1);
    }

    if (filters.hasReminder === "with_reminder") {
        clauses.push("next_follow_up_at IS NOT NULL");
    } else if (filters.hasReminder === "overdue") {
        clauses.push("next_follow_up_at IS NOT NULL");
        clauses.push("datetime(next_follow_up_at) < datetime('now')");
        clauses.push("status NOT IN ('closed', 'spam')");
    } else if (filters.hasReminder === "none") {
        clauses.push("next_follow_up_at IS NULL");
    }

    return {
        whereSql: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
        params: params,
        orderBy: getLeadOrderBy(filters.sort)
    };
}

function getLeadOrderBy(sort) {
    const prioritySql = getPriorityOrderSql();

    if (sort === "oldest") {
        return "datetime(created_at) ASC, " + prioritySql + " DESC";
    }

    if (sort === "priority") {
        return prioritySql + " DESC, datetime(created_at) DESC";
    }

    if (sort === "follow_up") {
        return "CASE WHEN next_follow_up_at IS NULL THEN 1 ELSE 0 END ASC, datetime(next_follow_up_at) ASC, " + prioritySql + " DESC, datetime(created_at) DESC";
    }

    return "datetime(created_at) DESC, " + prioritySql + " DESC";
}

function getPriorityOrderSql() {
    return "CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 2 END";
}

function parseTranscript(value) {
    try {
        return JSON.parse(value || "[]");
    } catch (error) {
        return [];
    }
}

function mapSession(row) {
    return {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sourcePage: row.source_page,
        referrer: row.referrer,
        userAgent: row.user_agent,
        transcript: parseTranscript(row.transcript),
        firstQuestion: row.first_question,
        matchType: row.match_type
    };
}

function mapLead(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
        sourcePage: row.source_page,
        referrer: row.referrer,
        userAgent: row.user_agent,
        visitorName: row.visitor_name,
        contactType: row.contact_type,
        contactValue: row.contact_value,
        firstQuestion: row.first_question,
        transcript: parseTranscript(row.transcript),
        matchType: row.match_type,
        internalNote: row.internal_note || "",
        telegramNotifiedAt: row.telegram_notified_at,
        priority: normalizePriority(row.priority),
        assignedTo: row.assigned_to || "",
        sourceChannel: row.source_channel || "unknown",
        utmSource: row.utm_source || "",
        utmMedium: row.utm_medium || "",
        utmCampaign: row.utm_campaign || "",
        lastContactAt: row.last_contact_at || null,
        nextFollowUpAt: row.next_follow_up_at || null,
        closedReason: row.closed_reason || "",
        contactAttempts: safeInteger(row.contact_attempts)
    };
}

function mapLeadEvent(row) {
    return {
        id: row.id,
        leadId: row.lead_id,
        createdAt: row.created_at,
        type: row.type,
        actor: row.actor || "system",
        summary: row.summary || "",
        payload: parsePayload(row.payload)
    };
}

function parsePayload(value) {
    try {
        return JSON.parse(value || "{}");
    } catch (error) {
        return {};
    }
}

function mergeTranscripts(existing, incoming) {
    const merged = existing.slice();
    const seen = new Set(merged.map(getTranscriptSignature));

    incoming.forEach(function (entry) {
        const signature = getTranscriptSignature(entry);
        if (!seen.has(signature)) {
            merged.push(entry);
            seen.add(signature);
        }
    });

    return merged;
}

function getTranscriptSignature(entry) {
    return [
        entry && entry.createdAt ? entry.createdAt : "",
        entry && entry.role ? entry.role : "",
        entry && entry.type ? entry.type : "",
        entry && entry.text ? entry.text : "",
        JSON.stringify(entry && entry.payload ? entry.payload : {})
    ].join("|");
}

function normalizePriority(priority) {
    const value = String(priority || "").trim().toLowerCase();
    return LEAD_PRIORITIES.includes(value) ? value : "normal";
}

function safeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
    }
    return fallback !== undefined ? fallback : 0;
}

function normalizeComparableText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isLikelyDuplicateQuestion(left, right) {
    const a = normalizeComparableText(left);
    const b = normalizeComparableText(right);

    if (!a || !b) return false;
    if (a === b) return true;

    const aTokens = a.split(" ").filter(Boolean);
    const bTokens = b.split(" ").filter(Boolean);
    if (!aTokens.length || !bTokens.length) return false;

    const bSet = new Set(bTokens);
    const common = aTokens.filter(function (token) {
        return bSet.has(token);
    }).length;

    return common / Math.max(aTokens.length, bTokens.length) >= 0.7;
}

function startOfDay(date) {
    const copy = new Date(date);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

function addDays(dateString, amount) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
        return dateString;
    }
    date.setDate(date.getDate() + amount);
    return date.toISOString();
}

function getStatusLabel(status) {
    const labels = {
        new: "Новая",
        in_progress: "В работе",
        closed: "Закрыта",
        spam: "Спам"
    };

    return labels[status] || status || "—";
}

function getPriorityLabel(priority) {
    const labels = {
        low: "низкий",
        normal: "обычный",
        high: "высокий",
        urgent: "срочный"
    };

    return labels[normalizePriority(priority)] || "обычный";
}

module.exports = {
    createDatabase
};
