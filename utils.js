import crypto from 'crypto';

export function normalizeText(value = '') {
    return String(value)
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

export function hashText(value = '') {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function estimateTokens(value = '') {
    const text = String(value);
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}

export function stableScope({ tenantId = 'public', companyId = 'default', repoId = 'none', systemPrompt = '' } = {}) {
    return {
        tenantId,
        companyId,
        repoId,
        systemPromptHash: hashText(normalizeText(systemPrompt)).slice(0, 16)
    };
}

export function scopeKey(scope = {}) {
    return [
        scope.tenantId || 'public',
        scope.companyId || 'default',
        scope.repoId || 'none',
        scope.systemPromptHash || 'no-system'
    ].join('::');
}

export function formatMessages(messages = []) {
    return messages
        .map((message) => {
            const role = message.role || 'user';
            const content = typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content ?? '');
            return `<${role}>\n${normalizeText(content)}`;
        })
        .join('\n\n');
}

export function extractChatPayload(body = {}) {
    const messages = Array.isArray(body.messages) ? body.messages : null;

    let systemPrompt = normalizeText(body.systemPrompt || '');
    let userPrompt = normalizeText(body.userPrompt || body.prompt || '');
    let prefixText = '';
    let fullPromptText = '';
    let chatDepth = Number(body.chatDepth || body.depth || 0);

    if (messages && messages.length > 0) {
        const systemMessage = messages.find((message) => message.role === 'system');
        if (!systemPrompt && systemMessage) systemPrompt = normalizeText(systemMessage.content || '');

        const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
        const lastMessage = lastUserIndex >= 0 ? messages[lastUserIndex] : messages[messages.length - 1];
        userPrompt = normalizeText(lastMessage?.content || userPrompt);

        const prefixMessages = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : messages.slice(0, -1);
        prefixText = formatMessages(prefixMessages);
        fullPromptText = formatMessages(messages);
        chatDepth = chatDepth || messages.filter((message) => message.role !== 'system').length || messages.length;
    } else {
        const history = Array.isArray(body.history) ? body.history : [];
        const historyText = history.map((item) => {
            if (typeof item === 'string') return normalizeText(item);
            return `<${item.role || 'user'}>\n${normalizeText(item.content || '')}`;
        }).join('\n\n');

        prefixText = normalizeText([systemPrompt, historyText].filter(Boolean).join('\n\n'));
        fullPromptText = normalizeText([systemPrompt, historyText, userPrompt].filter(Boolean).join('\n\n'));
        chatDepth = chatDepth || history.length + 1;
    }

    const scope = stableScope({
        tenantId: body.tenantId,
        companyId: body.companyId,
        repoId: body.repoId,
        systemPrompt
    });

    return {
        tenantId: scope.tenantId,
        companyId: scope.companyId,
        repoId: scope.repoId,
        scope,
        scopeHash: scopeKey(scope),
        systemPrompt,
        userPrompt,
        prefixText,
        fullPromptText,
        chatDepth,
        promptSize: fullPromptText.length || userPrompt.length,
        promptTokens: estimateTokens(fullPromptText || userPrompt),
        requestId: body.requestId || crypto.randomUUID(),
        hitRateMetric: typeof body.hitRateMetric === 'number' ? body.hitRateMetric : undefined,
        estimatedNeighborHitRate: typeof body.estimatedNeighborHitRate === 'number' ? body.estimatedNeighborHitRate : undefined
    };
}
