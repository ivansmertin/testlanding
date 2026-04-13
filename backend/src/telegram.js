function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

async function sendTelegramLead(options) {
    if (!options.botToken || !options.chatId) {
        return false;
    }

    const lead = options.lead || {};
    const utmSummary = [lead.utmSource, lead.utmMedium, lead.utmCampaign]
        .filter(Boolean)
        .join(" / ");
    const heading = options.duplicate
        ? "<b>Повторная заявка с сайта</b>"
        : "<b>Новая заявка с сайта</b>";
    const lines = [
        heading,
        "",
        "<b>Имя:</b> " + escapeHtml(lead.visitorName || "Не указано"),
        "<b>Контакт:</b> " + escapeHtml((lead.contactType || "—") + " — " + (lead.contactValue || "—")),
        "<b>Вопрос:</b> " + escapeHtml(lead.firstQuestion || "Не указан"),
        "<b>Приоритет:</b> " + escapeHtml(getPriorityLabel(lead.priority)),
        "<b>Источник:</b> " + escapeHtml(lead.sourceChannel || "unknown"),
        "<b>Landing:</b> " + escapeHtml(lead.sourcePage || "/"),
        "<b>Время:</b> " + escapeHtml(lead.createdAt || new Date().toISOString())
    ];

    if (lead.referrer) {
        lines.push("<b>Referrer:</b> " + escapeHtml(lead.referrer));
    }

    if (utmSummary) {
        lines.push("<b>UTM:</b> " + escapeHtml(utmSummary));
    }

    if (options.adminAppUrl) {
        lines.push("", "<a href=\"" + escapeHtml(options.adminAppUrl) + "\">Открыть заявку в админке</a>");
    }

    const response = await fetch("https://api.telegram.org/bot" + options.botToken + "/sendMessage", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            chat_id: options.chatId,
            text: lines.join("\n"),
            parse_mode: "HTML",
            disable_web_page_preview: true
        })
    });

    if (!response.ok) {
        throw new Error("Telegram API error: " + response.status);
    }

    return true;
}

function getPriorityLabel(priority) {
    const labels = {
        low: "низкий",
        normal: "обычный",
        high: "высокий",
        urgent: "срочный"
    };

    return labels[String(priority || "").toLowerCase()] || "обычный";
}

module.exports = {
    sendTelegramLead
};
