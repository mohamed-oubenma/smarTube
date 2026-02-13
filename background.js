// background.js - Handles API calls and communication

// Constants
const SUPADATA_API_BASE_URL = "https://api.supadata.ai/v1/youtube/transcript";
const API_KEYS_MISSING_ERROR = "API_KEYS_MISSING"; // Constant for error type
const DEFAULT_ACTION_ID = 'default-summary';
const TRANSCRIPT_ACTION_ID = 'view-transcript';
const DEFAULT_ACTION_PROMPT = `{{language_instruction}}
Summarize the following video transcript into concise key points, then provide a bullet list of highlights annotated with fitting emojis.
Enforce standard numeral formatting using digits 0-9 regardless of language.

Transcript:
---
{{transcript}}
---`;
const TRANSCRIPT_ACTION_PROMPT = `Raw transcript from Supadata (no Gemini processing).`;
const MAX_TRANSCRIPT_LENGTH = 300000;
const TRANSCRIPT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const TRANSCRIPT_CACHE_MAX_ENTRIES = 20;
const TRANSCRIPT_CACHE_STORAGE_PREFIX = 'transcriptCache:';

const transcriptMemoryCache = new Map();
const inFlightTranscriptRequests = new Map();

// Listen for messages from the content script
console.log("SmarTube background service worker started.");

// Listen for messages from the content script
console.log("SmarTube background service worker started.");

function getDefaultAction() {
    return {
        id: DEFAULT_ACTION_ID,
        label: 'Summarize',
        prompt: DEFAULT_ACTION_PROMPT.trim(),
        mode: 'gemini'
    };
}

function getTranscriptAction() {
    return {
        id: TRANSCRIPT_ACTION_ID,
        label: 'Transcript',
        prompt: TRANSCRIPT_ACTION_PROMPT.trim(),
        mode: 'transcript'
    };
}

function ensureCustomActions(actions = []) {
    const cleaned = [];
    const seenIds = new Set();
    let mutated = false;

    if (Array.isArray(actions)) {
        actions.forEach((action) => {
            if (!action) {
                mutated = true;
                return;
            }

            let id = typeof action.id === 'string' ? action.id.trim() : '';
            const label = typeof action.label === 'string' ? action.label.trim() : '';
            let prompt = typeof action.prompt === 'string' ? action.prompt.trim() : '';
            const mode = action.mode === 'transcript' ? 'transcript' : 'gemini';

            if (!label) {
                mutated = true;
                return;
            }

            if (!id) {
                id = `${mode}-action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                mutated = true;
            }

            if (seenIds.has(id)) {
                id = `${id}-${Math.random().toString(36).slice(2, 4)}`;
                mutated = true;
            }
            seenIds.add(id);

            if (mode === 'gemini' && !prompt) {
                mutated = true;
                return;
            }

            if (mode === 'transcript' && !prompt) {
                prompt = TRANSCRIPT_ACTION_PROMPT.trim();
                mutated = true;
            }

            cleaned.push({ id, label, prompt, mode });
        });
    }

    if (!cleaned.length) {
        cleaned.push(getDefaultAction());
        cleaned.push(getTranscriptAction());
        return { actions: cleaned, mutated: true };
    }

    if (!cleaned.some(action => action.id === DEFAULT_ACTION_ID)) {
        cleaned.unshift(getDefaultAction());
        mutated = true;
    }

    if (!cleaned.some(action => action.id === TRANSCRIPT_ACTION_ID)) {
        cleaned.splice(1, 0, getTranscriptAction());
        mutated = true;
    }

    return { actions: cleaned, mutated: mutated || cleaned.length !== actions.length };
}

function buildLanguageInstruction(languageSetting = 'auto') {
    if (languageSetting === 'auto') {
        return "Generate the response in the primary language used within the provided transcript.";
    }

    const languageMap = {
        'en': 'English',
        'ar': 'Arabic',
        'fr': 'French',
        'es': 'Spanish'
    };

    const targetLanguage = languageMap[languageSetting] || 'English';
    return `Generate the response **in ${targetLanguage}**.`;
}

function truncateTranscript(text) {
    if (typeof text !== 'string') return '';
    if (text.length <= MAX_TRANSCRIPT_LENGTH) {
        return text;
    }
    console.warn(`Transcript length (${text.length}) exceeds limit (${MAX_TRANSCRIPT_LENGTH}). Truncating.`);
    return text.substring(0, MAX_TRANSCRIPT_LENGTH);
}

function extractVideoIdFromUrl(videoUrl) {
    if (typeof videoUrl !== 'string' || videoUrl.trim() === '') return null;

    try {
        const parsedUrl = new URL(videoUrl);
        const videoId = parsedUrl.searchParams.get('v');
        if (videoId && videoId.trim()) {
            return videoId.trim();
        }

        if (parsedUrl.hostname.includes('youtu.be')) {
            const pathVideoId = parsedUrl.pathname.replace(/^\/+/, '').split('/')[0];
            if (pathVideoId) {
                return pathVideoId.trim();
            }
        }
    } catch (error) {
        const match = videoUrl.match(/[?&]v=([^&]+)/);
        if (match && match[1]) {
            try {
                return decodeURIComponent(match[1]).trim();
            } catch (decodeError) {
                return match[1].trim();
            }
        }
    }

    return null;
}

function getTranscriptCacheKey(videoUrl) {
    const videoId = extractVideoIdFromUrl(videoUrl);
    if (videoId) {
        return `${TRANSCRIPT_CACHE_STORAGE_PREFIX}${videoId}`;
    }

    const fallbackKey = typeof videoUrl === 'string' && videoUrl.trim() ? videoUrl.trim() : 'unknown-url';
    return `${TRANSCRIPT_CACHE_STORAGE_PREFIX}url:${encodeURIComponent(fallbackKey)}`;
}

function isTranscriptCacheEntryFresh(entry, now = Date.now()) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.transcript !== 'string' || entry.transcript.trim().length === 0) return false;
    if (typeof entry.cachedAt !== 'number') return false;
    return (now - entry.cachedAt) < TRANSCRIPT_CACHE_TTL_MS;
}

function getCacheEntryLastAccess(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    return entry.lastAccessedAt || entry.cachedAt || 0;
}

function pruneMemoryTranscriptCache() {
    if (transcriptMemoryCache.size <= TRANSCRIPT_CACHE_MAX_ENTRIES) {
        return;
    }

    const sortedEntries = [...transcriptMemoryCache.entries()]
        .sort((a, b) => getCacheEntryLastAccess(b[1]) - getCacheEntryLastAccess(a[1]));

    transcriptMemoryCache.clear();
    sortedEntries.slice(0, TRANSCRIPT_CACHE_MAX_ENTRIES).forEach(([key, value]) => {
        transcriptMemoryCache.set(key, value);
    });
}

function hasSessionStorage() {
    return Boolean(chrome?.storage?.session);
}

async function sessionStorageGet(keys) {
    if (!hasSessionStorage()) return {};
    return new Promise((resolve, reject) => {
        chrome.storage.session.get(keys, (items) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
                reject(new Error(lastError.message));
                return;
            }
            resolve(items || {});
        });
    });
}

async function sessionStorageSet(items) {
    if (!hasSessionStorage()) return;
    return new Promise((resolve, reject) => {
        chrome.storage.session.set(items, () => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
                reject(new Error(lastError.message));
                return;
            }
            resolve();
        });
    });
}

async function sessionStorageRemove(keys) {
    if (!hasSessionStorage()) return;
    return new Promise((resolve, reject) => {
        chrome.storage.session.remove(keys, () => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
                reject(new Error(lastError.message));
                return;
            }
            resolve();
        });
    });
}

async function pruneSessionTranscriptCache() {
    if (!hasSessionStorage()) return;

    const now = Date.now();

    try {
        const allSessionItems = await sessionStorageGet(null);
        const cachedEntries = Object.entries(allSessionItems)
            .filter(([key]) => key.startsWith(TRANSCRIPT_CACHE_STORAGE_PREFIX));

        if (!cachedEntries.length) return;

        const staleOrInvalidKeys = [];
        const freshEntries = [];

        cachedEntries.forEach(([key, value]) => {
            if (isTranscriptCacheEntryFresh(value, now)) {
                freshEntries.push([key, value]);
            } else {
                staleOrInvalidKeys.push(key);
            }
        });

        if (staleOrInvalidKeys.length) {
            await sessionStorageRemove(staleOrInvalidKeys);
        }

        if (freshEntries.length > TRANSCRIPT_CACHE_MAX_ENTRIES) {
            const keysToRemove = freshEntries
                .sort((a, b) => getCacheEntryLastAccess(b[1]) - getCacheEntryLastAccess(a[1]))
                .slice(TRANSCRIPT_CACHE_MAX_ENTRIES)
                .map(([key]) => key);

            if (keysToRemove.length) {
                await sessionStorageRemove(keysToRemove);
            }
        }
    } catch (error) {
        console.warn('[TranscriptCache] Failed to prune session cache:', error.message || error);
    }
}

function buildTranscriptCacheEntry(videoUrl, transcriptText) {
    const now = Date.now();
    const videoId = extractVideoIdFromUrl(videoUrl);
    return {
        transcript: transcriptText,
        videoId: videoId || null,
        sourceUrl: videoUrl || '',
        cachedAt: now,
        lastAccessedAt: now
    };
}

async function writeTranscriptCacheEntry(cacheKey, entry) {
    transcriptMemoryCache.set(cacheKey, entry);
    pruneMemoryTranscriptCache();

    if (!hasSessionStorage()) return;

    try {
        await sessionStorageSet({ [cacheKey]: entry });
        await pruneSessionTranscriptCache();
    } catch (error) {
        console.warn('[TranscriptCache] Failed to persist transcript cache entry:', error.message || error);
    }
}

async function readTranscriptCacheEntry(cacheKey) {
    const now = Date.now();
    const memoryEntry = transcriptMemoryCache.get(cacheKey);

    if (memoryEntry) {
        if (isTranscriptCacheEntryFresh(memoryEntry, now)) {
            const touchedEntry = { ...memoryEntry, lastAccessedAt: now };
            transcriptMemoryCache.set(cacheKey, touchedEntry);
            console.log(`[TranscriptCache] cache_hit(memory): ${cacheKey}`);
            return touchedEntry;
        }

        transcriptMemoryCache.delete(cacheKey);
    }

    if (!hasSessionStorage()) {
        return null;
    }

    try {
        const sessionItems = await sessionStorageGet(cacheKey);
        const sessionEntry = sessionItems[cacheKey];
        if (!sessionEntry) return null;

        if (!isTranscriptCacheEntryFresh(sessionEntry, now)) {
            await sessionStorageRemove(cacheKey);
            return null;
        }

        const touchedEntry = { ...sessionEntry, lastAccessedAt: now };
        transcriptMemoryCache.set(cacheKey, touchedEntry);
        pruneMemoryTranscriptCache();
        // Best effort touch for LRU bookkeeping across service-worker restarts.
        await sessionStorageSet({ [cacheKey]: touchedEntry });
        console.log(`[TranscriptCache] cache_hit(session): ${cacheKey}`);
        return touchedEntry;
    } catch (error) {
        console.warn('[TranscriptCache] Failed to read session cache entry:', error.message || error);
        return null;
    }
}

async function getTranscriptForVideo(videoUrl, options = {}) {
    const { forceRefresh = false } = options;
    const cacheKey = getTranscriptCacheKey(videoUrl);

    if (!forceRefresh) {
        const cachedEntry = await readTranscriptCacheEntry(cacheKey);
        if (cachedEntry) {
            return cachedEntry.transcript;
        }
    }

    if (inFlightTranscriptRequests.has(cacheKey)) {
        console.log(`[TranscriptCache] in_flight_reuse: ${cacheKey}`);
        return inFlightTranscriptRequests.get(cacheKey);
    }

    console.log(`[TranscriptCache] cache_miss: ${cacheKey}`);
    const fetchPromise = (async () => {
        const transcript = await tryGetTranscriptRecursive(videoUrl);
        if (!transcript || transcript.trim().length === 0) {
            throw new Error("Received empty or invalid transcript from Supadata.");
        }

        const cacheEntry = buildTranscriptCacheEntry(videoUrl, transcript);
        await writeTranscriptCacheEntry(cacheKey, cacheEntry);
        return transcript;
    })();

    inFlightTranscriptRequests.set(cacheKey, fetchPromise);
    try {
        return await fetchPromise;
    } finally {
        inFlightTranscriptRequests.delete(cacheKey);
    }
}

function buildPromptFromTemplate(template, { transcript, languageInstruction, videoUrl }) {
    const baseTemplate = typeof template === 'string' && template.trim().length > 0
        ? template
        : getDefaultAction().prompt;

    let finalPrompt = baseTemplate;

    const replacements = {
        '{{language_instruction}}': languageInstruction || '',
        '{{transcript}}': transcript || '',
        '{{video_url}}': videoUrl || ''
    };

    Object.entries(replacements).forEach(([placeholder, value]) => {
        if (finalPrompt.includes(placeholder)) {
            const safeValue = value || '';
            finalPrompt = finalPrompt.split(placeholder).join(safeValue);
        }
    });

    if (languageInstruction && !baseTemplate.includes('{{language_instruction}}')) {
        finalPrompt = `${languageInstruction}\n\n${finalPrompt}`;
    }

    if (transcript && !baseTemplate.includes('{{transcript}}')) {
        finalPrompt = `${finalPrompt}\n\nTranscript:\n---\n${transcript}\n---`;
    }

    if (videoUrl && !baseTemplate.includes('{{video_url}}')) {
        finalPrompt = `${finalPrompt}\n\nVideo URL: ${videoUrl}`;
    }

    return finalPrompt;
}

async function callGeminiGenerateContent(promptText, geminiApiKey, geminiModel, generationConfig = {}) {
    console.log(`Calling Gemini API with model: ${geminiModel}`);

    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;

    const requestBody = {
        contents: [{
            parts: [{
                text: promptText
            }]
        }],
        generationConfig: {
            temperature: generationConfig.temperature ?? 0.7,
            maxOutputTokens: generationConfig.maxOutputTokens ?? 8192
        }
    };

    const response = await fetch(geminiApiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        let errorBody = {};
        try {
            errorBody = await response.json();
        } catch (e) { /* Ignore */ }

        console.error("Gemini API Error Response:", response.status, response.statusText, errorBody);
        let detail = errorBody?.error?.message || '';
        if (response.status === 400 && detail.includes("API key not valid")) {
            detail = "Invalid Gemini API Key.";
        } else if (response.status === 429) {
            detail = "Gemini API rate limit exceeded or quota finished.";
        } else if (response.status >= 500) {
            detail = "Gemini server error.";
        }
        throw new Error(`Gemini API request failed (${response.status}): ${detail || response.statusText}`);
    }

    const data = await response.json();
    console.log("Gemini API Raw Response:", data);

    if (data.candidates && data.candidates.length > 0 &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts.length > 0) {
        return data.candidates[0].content.parts[0].text;
    }

    if (data.error) {
        throw new Error(`Gemini API Error: ${data.error.message}`);
    }

    console.error("Unexpected Gemini API response structure:", data);
    throw new Error("Could not extract text from Gemini API response.");
}

async function runCustomAction(actionId, videoUrl, labelForLogs = null) {
    const {
        geminiApiKey,
        geminiModel = 'gemini-2.5-flash-lite',
        summaryLanguage = 'auto',
        customActionButtons = []
    } = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel', 'summaryLanguage', 'customActionButtons']);

    const { actions } = ensureCustomActions(customActionButtons);
    let selectedAction = actions.find(action => action.id === actionId);
    if (!selectedAction) {
        console.warn(`Action "${actionId}" not found. Falling back to default action.`);
        selectedAction = actions.find(action => action.id === DEFAULT_ACTION_ID) || actions[0];
    }

    const actionLabel = labelForLogs || selectedAction.label;
    console.log(`Executing action "${actionLabel}" (mode: ${selectedAction.mode || 'gemini'})`);

    const transcript = await getTranscriptForVideo(videoUrl);
    if (!transcript || transcript.trim().length === 0) {
        throw new Error("Received empty or invalid transcript from Supadata.");
    }

    if (selectedAction.mode === 'transcript') {
        const heading = selectedAction.prompt?.trim() || TRANSCRIPT_ACTION_PROMPT.trim();
        const content = `${heading}\n\n\`\`\`\n${transcript}\n\`\`\``;
        return { content, actionLabel };
    }

    if (!geminiApiKey || geminiApiKey.trim() === '') {
        throw new Error(API_KEYS_MISSING_ERROR);
    }

    const truncatedTranscript = truncateTranscript(transcript);
    const languageInstruction = buildLanguageInstruction(summaryLanguage);
    const finalPrompt = buildPromptFromTemplate(selectedAction.prompt, {
        transcript: truncatedTranscript,
        languageInstruction,
        videoUrl
    });

    const content = await callGeminiGenerateContent(finalPrompt, geminiApiKey, geminiModel);
    return { content, actionLabel };
}

function deriveActionErrorMessage(error) {
    const defaultMessage = "Failed to generate response.";
    if (!error) return defaultMessage;

    const message = error.message || String(error);
    if (!message) {
        return defaultMessage;
    }

    if (message === API_KEYS_MISSING_ERROR) {
        return API_KEYS_MISSING_ERROR;
    }

    if (message.includes("All Supadata API keys")) {
        return message;
    }

    if (message.includes("Supadata")) {
        return `Failed to fetch transcript: ${message}`;
    }

    if (message.includes("Gemini")) {
        return `Failed to fetch response from Gemini: ${message}`;
    }

    if (message.includes("API key") || message.includes("API request failed")) {
        return message;
    }

    return message || defaultMessage;
}

// Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Background script received message:", request.action);

    if (request.action === "getSummary") {
        console.log("Background script received getSummary request for URL:", request.url);
        runCustomAction(DEFAULT_ACTION_ID, request.url, 'Summarize')
            .then(({ content }) => {
                console.log("Sending default action response back to content script.");
                sendResponse({ content });
            })
            .catch(error => {
                console.error("Error during default action execution:", error);
                const errorMessage = deriveActionErrorMessage(error);
                if (errorMessage === API_KEYS_MISSING_ERROR) {
                    sendResponse({ error: API_KEYS_MISSING_ERROR });
                } else {
                    sendResponse({ error: errorMessage });
                }
            });
        return true; // Asynchronous response

    } else if (request.action === "runCustomPrompt") {
        console.log(`Background script received runCustomPrompt request (${request.actionId}) for URL:`, request.url);
        const actionId = request.actionId || DEFAULT_ACTION_ID;
        runCustomAction(actionId, request.url, request.label)
            .then(({ content, actionLabel }) => {
                console.log(`Sending custom action "${actionLabel}" response back to content script.`);
                sendResponse({ content, label: actionLabel });
            })
            .catch(error => {
                console.error("Error during custom action execution:", error);
                const errorMessage = deriveActionErrorMessage(error);
                if (errorMessage === API_KEYS_MISSING_ERROR) {
                    sendResponse({ error: API_KEYS_MISSING_ERROR });
                } else {
                    sendResponse({ error: errorMessage });
                }
            });
        return true;

    } else if (request.action === "openOptionsPage") {
        console.log("Background script received openOptionsPage request.");
        chrome.runtime.openOptionsPage();
    } else if (request.action === "askQuestion") {
        console.log("Background script received askQuestion request:", request.question, "for URL:", request.url);

        chrome.storage.sync.get(['geminiApiKey', 'geminiModel', 'summaryLanguage'], (items) => {
            const geminiApiKey = items.geminiApiKey;
            const geminiModel = items.geminiModel || 'gemini-2.5-flash-lite';
            const summaryLanguage = items.summaryLanguage || 'auto';
            const languageInstruction = buildLanguageInstruction(summaryLanguage);

            if (!geminiApiKey || geminiApiKey.trim() === '') {
                console.error("Gemini API Key missing or invalid for Q&A.");
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]?.id) {
                        chrome.tabs.sendMessage(tabs[0].id, { action: "answerResponse", error: API_KEYS_MISSING_ERROR });
                    }
                });
                return;
            }
            console.log("Gemini API Key and Model retrieved for Q&A. Model:", geminiModel);

            getTranscriptForVideo(request.url)
                .then(transcript => {
                    if (!transcript || transcript.trim().length === 0) {
                        throw new Error("Cannot answer question: Transcript is empty or invalid.");
                    }
                    console.log("Transcript fetched for Q&A. Calling Gemini for question with model:", geminiModel);
                    return callGeminiForQuestion(transcript, request.question, geminiApiKey, geminiModel, languageInstruction);
                })
                .then(answer => {
                    console.log("Sending answer back to content script.");
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]?.id) {
                            chrome.tabs.sendMessage(tabs[0].id, { action: "answerResponse", answer: answer });
                        }
                    });
                })
                .catch(error => {
                    console.error("Error during Q&A process:", error);
                    let errorMessage = `Failed to get answer: ${error.message || "Unknown error"}`;
                     if (error.message === API_KEYS_MISSING_ERROR || error.message.includes("All Supadata API keys")) {
                        errorMessage = error.message; // Use specific error
                    }
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]?.id) {
                            chrome.tabs.sendMessage(tabs[0].id, { action: "answerResponse", error: errorMessage });
                        }
                    });
                });
        });
        sendResponse({ status: "Question received, processing..." }); // Acknowledge receipt
        return true; // Asynchronous response
    }
});

// --- Supadata API Key Management and Transcript Fetching ---

async function tryGetTranscriptRecursive(videoUrl, attemptCycle = 0, triedKeyIds = new Set()) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get(['supadataApiKeys', 'activeSupadataKeyId'], async (storageItems) => {
            let { supadataApiKeys, activeSupadataKeyId } = storageItems;

            if (!supadataApiKeys || supadataApiKeys.length === 0) {
                console.error("No Supadata API keys configured.");
                return reject(new Error(API_KEYS_MISSING_ERROR));
            }

            let activeKeyObj = null;
            if (activeSupadataKeyId) {
                activeKeyObj = supadataApiKeys.find(k => k.id === activeSupadataKeyId);
            }

            // If no active key ID or the active key object is not found, try to find the first non-rate-limited key
            if (!activeKeyObj || activeKeyObj.isRateLimited) {
                const firstAvailableKey = supadataApiKeys.find(k => !k.isRateLimited && !triedKeyIds.has(k.id));
                if (firstAvailableKey) {
                    activeKeyObj = firstAvailableKey;
                    activeSupadataKeyId = firstAvailableKey.id;
                    // Update storage with the new active key
                    await chrome.storage.sync.set({ activeSupadataKeyId: activeSupadataKeyId });
                    console.log(`Switched to available Supadata key: ${activeKeyObj.name || activeKeyObj.id}`);
                } else {
                     // If all keys have been tried in this cycle or are marked rate limited
                    if (triedKeyIds.size >= supadataApiKeys.length || supadataApiKeys.every(k => k.isRateLimited)) {
                        console.error("All Supadata API keys are currently rate-limited or have been tried unsuccessfully in this cycle.");
                        return reject(new Error("All Supadata API keys are currently rate-limited. Please try again later or check your keys in options."));
                    }
                    // This case should ideally be caught by the loop below if no key is initially active/valid
                }
            }
            
            if (!activeKeyObj) { // Should not happen if there are keys, but as a safeguard
                 console.error("Could not determine an active Supadata API key.");
                 return reject(new Error(API_KEYS_MISSING_ERROR));
            }

            // Add current key to tried set for this user action cycle
            triedKeyIds.add(activeKeyObj.id);

            console.log(`Attempting Supadata API call with key: ${activeKeyObj.name || activeKeyObj.id} (Attempt: ${attemptCycle + 1})`);
            const transcriptUrl = `${SUPADATA_API_BASE_URL}?url=${encodeURIComponent(videoUrl)}&text=true`;

            try {
                const response = await fetch(transcriptUrl, {
                    method: 'GET',
                    headers: { 'x-api-key': activeKeyObj.key, 'Accept': 'application/json' }
                });

                if (!response.ok) {
                    let errorBody = {};
                    try { errorBody = await response.json(); } catch (e) { /* Ignore */ }
                    const errorDetail = errorBody?.message || response.statusText;
                    console.error(`Supadata API Error (${response.status}) with key ${activeKeyObj.id}: ${errorDetail}`);

                    // Check for rate limit status (429) or explicit rate limit messages in the error detail
                    if (response.status === 429 || errorDetail.toLowerCase().includes("rate limit") || errorDetail.toLowerCase().includes("quota exceeded")) {
                        // Mark current key as rate-limited
                        const keyIndex = supadataApiKeys.findIndex(k => k.id === activeKeyObj.id);
                        if (keyIndex !== -1) {
                            supadataApiKeys[keyIndex].isRateLimited = true;
                        }
                        
                        // Find next available key that hasn't been tried in this cycle
                        let nextKeyToTry = null;
                        let nextKeyId = null;
                        for (let i = 0; i < supadataApiKeys.length; i++) {
                            const potentialNextKey = supadataApiKeys[(keyIndex + 1 + i) % supadataApiKeys.length];
                            if (!potentialNextKey.isRateLimited && !triedKeyIds.has(potentialNextKey.id)) {
                                nextKeyToTry = potentialNextKey;
                                break;
                            }
                        }

                        await chrome.storage.sync.set({ supadataApiKeys: [...supadataApiKeys], activeSupadataKeyId: nextKeyToTry ? nextKeyToTry.id : activeSupadataKeyId });


                        if (nextKeyToTry && attemptCycle < supadataApiKeys.length -1) { // Check attemptCycle against total keys
                            console.log(`Key ${activeKeyObj.id} failed. Trying next available key: ${nextKeyToTry.id}`);
                            // Recursive call with incremented attemptCycle and updated triedKeyIds
                            tryGetTranscriptRecursive(videoUrl, attemptCycle + 1, triedKeyIds)
                                .then(resolve)
                                .catch(reject);
                        } else {
                            console.error("All Supadata API keys have been tried or are rate-limited in this cycle.");
                            reject(new Error("All Supadata API keys are currently rate-limited or invalid. Please check your keys in options or try again later."));
                        }
                    } else { // Other non-retryable Supadata errors
                        throw new Error(`Supadata API request failed (${response.status}): ${errorDetail}`);
                    }
                    return; // Important: stop processing for this attempt
                }

                const data = await response.json();
                if (data && typeof data.content === 'string') {
                    console.log(`Transcript fetched successfully with key: ${activeKeyObj.id}`);
                    // If successful, reset its rate-limited status (optimistic)
                    const keyIndex = supadataApiKeys.findIndex(k => k.id === activeKeyObj.id);
                    if (keyIndex !== -1 && supadataApiKeys[keyIndex].isRateLimited) {
                        supadataApiKeys[keyIndex].isRateLimited = false;
                        await chrome.storage.sync.set({ supadataApiKeys: [...supadataApiKeys] });
                    }
                    resolve(data.content);
                } else {
                    throw new Error("Could not extract transcript content from Supadata API response.");
                }

            } catch (error) {
                console.error('Error during fetch to Supadata API:', error);
                // If it's a network error or similar, and we haven't exhausted keys, we might still want to try another key.
                // For simplicity now, any catch here that isn't a handled API error might just reject.
                // Consider if more sophisticated retry for network errors is needed.
                // For now, let's assume this error means this key attempt failed, try to cycle if possible.
                
                // Mark current key as potentially problematic (similar to rate limit for cycling)
                const keyIndex = supadataApiKeys.findIndex(k => k.id === activeKeyObj.id);
                 // For generic fetch errors (e.g., network issues), do NOT mark the key as rate-limited.
                 // A key should only be marked as rate-limited if the API explicitly returns a rate limit status (429)
                 // or a rate limit message. The key cycling logic will still attempt to try other keys if the current
                 // request fails, but without permanently deactivating the current key for non-rate-limit issues.
                if (keyIndex !== -1 && supadataApiKeys[keyIndex].isRateLimited) {
                    // If the key was already marked as rate-limited by an explicit API response, keep it that way.
                }

                let nextKeyToTry = null;
                for (let i = 0; i < supadataApiKeys.length; i++) {
                    const potentialNextKey = supadataApiKeys[(keyIndex + 1 + i) % supadataApiKeys.length];
                    if (!potentialNextKey.isRateLimited && !triedKeyIds.has(potentialNextKey.id)) {
                        nextKeyToTry = potentialNextKey;
                        break;
                    }
                }
                
                await chrome.storage.sync.set({ supadataApiKeys: [...supadataApiKeys], activeSupadataKeyId: nextKeyToTry ? nextKeyToTry.id : activeSupadataKeyId });

                if (nextKeyToTry && attemptCycle < supadataApiKeys.length -1) {
                     console.warn(`Fetch error with key ${activeKeyObj.id}. Trying next. Error: ${error.message}`);
                     tryGetTranscriptRecursive(videoUrl, attemptCycle + 1, triedKeyIds)
                        .then(resolve)
                        .catch(reject);
                } else {
                    reject(new Error(`Supadata API Error: ${error.message} (after trying available keys)`));
                }
            }
        });
    });
}

// Function to ask a question about the transcript using Gemini API
async function callGeminiForQuestion(transcriptText, question, geminiApiKey, geminiModel, languageInstruction = '') {
    console.log(`Calling Gemini API to answer question: "${question}" with model: ${geminiModel}`);

    const trimmedTranscript = truncateTranscript(transcriptText);

    const promptPrefix = languageInstruction ? `${languageInstruction}\n\n` : '';
    const prompt = `${promptPrefix}Based **only** on the following video transcript, answer the user's question. If the answer cannot be found in the transcript, say so.
Do not use any external knowledge.

Transcript:
---
${trimmedTranscript}
---

User Question: ${question}

Answer:`;

    console.log("Generated Gemini Q&A Prompt:", prompt);
    return callGeminiGenerateContent(prompt, geminiApiKey, geminiModel, { temperature: 0.4, maxOutputTokens: 4096 });
}
