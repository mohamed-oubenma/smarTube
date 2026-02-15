console.log("SmarTube content script loaded.");

let summaryDiv = null; // Keep track of the summary div
let currentVideoUrl = '';
let currentVideoId = '';
let customActions = [];
let isExpandedView = false;
let summaryOriginalParent = null;
let summaryOriginalNextSibling = null;

const DEFAULT_ACTION_ID = 'default-summary';
const TRANSCRIPT_TIMESTAMPS_ACTION_ID = 'view-transcript';
const TRANSCRIPT_TEXT_ACTION_ID = 'view-transcript-text';
const DEFAULT_ACTION_PROMPT = `{{language_instruction}}
Summarize the following video transcript into concise key points, then provide a bullet list of highlights annotated with fitting emojis.
Enforce standard numeral formatting using digits 0-9 regardless of language.

Transcript:
---
{{transcript}}
---`;
const TRANSCRIPT_TIMESTAMPS_ACTION_PROMPT = `Raw transcript from Supadata with timestamps (no Gemini processing).`;
const TRANSCRIPT_TEXT_ACTION_PROMPT = `Raw transcript text only from Supadata (no Gemini processing).`;
const TIMESTAMP_LINK_CLASS = 'timestamp-link-ext';

const OVERLAY_BACKDROP_ID = 'youtube-summary-overlay-backdrop-ext';

function removeOverlayBackdrop() {
    const existingBackdrop = document.getElementById(OVERLAY_BACKDROP_ID);
    if (existingBackdrop) {
        existingBackdrop.remove();
    }
}

function ensureOverlayBackdrop() {
    let backdrop = document.getElementById(OVERLAY_BACKDROP_ID);
    if (backdrop) return backdrop;

    backdrop = document.createElement('div');
    backdrop.id = OVERLAY_BACKDROP_ID;
    backdrop.addEventListener('click', () => {
        setExpandedView(false);
    });

    document.body.appendChild(backdrop);
    return backdrop;
}

function updateToggleSizeButton() {
    if (!summaryDiv) return;
    const button = summaryDiv.querySelector('#toggle-size-summary-btn');
    if (!button) return;

    if (isExpandedView) {
        button.textContent = '−';
        button.title = 'Reduce view';
        button.setAttribute('aria-label', 'Reduce view');
    } else {
        button.textContent = '⤢';
        button.title = 'Expand view';
        button.setAttribute('aria-label', 'Expand view');
    }
}

function setExpandedView(shouldExpand) {
    if (!summaryDiv) return;

    if (shouldExpand === isExpandedView) {
        updateToggleSizeButton();
        return;
    }

    if (shouldExpand) {
        summaryOriginalParent = summaryDiv.parentNode;
        summaryOriginalNextSibling = summaryDiv.nextSibling;

        isExpandedView = true;
        ensureOverlayBackdrop();
        summaryDiv.classList.add('expanded-view');
        // Move the panel to <body> so it can overlay the video reliably.
        document.body.appendChild(summaryDiv);
        updateToggleSizeButton();
        scrollMessagesToBottom();
        return;
    }

    // Collapse expanded view
    isExpandedView = false;
    summaryDiv.classList.remove('expanded-view');
    removeOverlayBackdrop();
    updateToggleSizeButton();

    const secondaryColumn = document.getElementById('secondary');
    const canRestoreToOriginal = summaryOriginalParent && document.contains(summaryOriginalParent);

    if (canRestoreToOriginal) {
        const hasNextSibling = summaryOriginalNextSibling && summaryOriginalParent.contains(summaryOriginalNextSibling);
        if (hasNextSibling) {
            summaryOriginalParent.insertBefore(summaryDiv, summaryOriginalNextSibling);
        } else {
            summaryOriginalParent.appendChild(summaryDiv);
        }
    } else if (secondaryColumn) {
        secondaryColumn.insertBefore(summaryDiv, secondaryColumn.firstChild);
    }

    summaryOriginalParent = null;
    summaryOriginalNextSibling = null;
}

function toggleExpandedView() {
    setExpandedView(!isExpandedView);
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isExpandedView) {
        setExpandedView(false);
    }
});

function getDefaultAction() {
    return {
        id: DEFAULT_ACTION_ID,
        label: 'Summarize',
        prompt: DEFAULT_ACTION_PROMPT.trim(),
        mode: 'gemini'
    };
}

function normalizeActionMode(mode) {
    if (mode === 'transcript' || mode === 'transcript_timestamps') {
        return 'transcript_timestamps';
    }
    if (mode === 'transcript_text') {
        return 'transcript_text';
    }
    return 'gemini';
}

function isTranscriptMode(mode) {
    return mode === 'transcript_timestamps' || mode === 'transcript_text';
}

function getTranscriptPromptForMode(mode) {
    if (mode === 'transcript_text') {
        return TRANSCRIPT_TEXT_ACTION_PROMPT.trim();
    }
    return TRANSCRIPT_TIMESTAMPS_ACTION_PROMPT.trim();
}

function getTranscriptTimestampsAction() {
    return {
        id: TRANSCRIPT_TIMESTAMPS_ACTION_ID,
        label: 'Transcript + Time',
        prompt: TRANSCRIPT_TIMESTAMPS_ACTION_PROMPT.trim(),
        mode: 'transcript_timestamps'
    };
}

function getTranscriptTextAction() {
    return {
        id: TRANSCRIPT_TEXT_ACTION_ID,
        label: 'Transcript Text',
        prompt: TRANSCRIPT_TEXT_ACTION_PROMPT.trim(),
        mode: 'transcript_text'
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
            const mode = normalizeActionMode(action.mode);

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

            if (isTranscriptMode(mode) && !prompt) {
                prompt = getTranscriptPromptForMode(mode);
                mutated = true;
            }

            cleaned.push({ id, label, prompt, mode });
        });
    }

    if (!cleaned.length) {
        cleaned.push(getDefaultAction());
        cleaned.push(getTranscriptTimestampsAction());
        cleaned.push(getTranscriptTextAction());
        return { actions: cleaned, mutated: true };
    }

    if (!cleaned.some(action => action.id === DEFAULT_ACTION_ID)) {
        cleaned.unshift(getDefaultAction());
        mutated = true;
    }

    if (!cleaned.some(action => action.id === TRANSCRIPT_TIMESTAMPS_ACTION_ID)) {
        cleaned.splice(1, 0, getTranscriptTimestampsAction());
        mutated = true;
    }

    if (!cleaned.some(action => action.id === TRANSCRIPT_TEXT_ACTION_ID)) {
        cleaned.splice(2, 0, getTranscriptTextAction());
        mutated = true;
    }

    const mutatedByLength = cleaned.length !== actions.length;
    return { actions: cleaned, mutated: mutated || mutatedByLength };
}

function getMessagesContainer() {
    if (!summaryDiv) return null;
    return summaryDiv.querySelector('#messages-container-ext');
}

function scrollMessagesToBottom() {
    const messagesContainer = getMessagesContainer();
    if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

function createPlaceholderId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(text) {
    const tempDiv = document.createElement('div');
    tempDiv.textContent = text;
    return tempDiv.innerHTML;
}

function renderActionButtons(actions = []) {
    if (!summaryDiv) return;
    const buttonsContainer = summaryDiv.querySelector('#action-buttons-ext');
    if (!buttonsContainer) return;

    buttonsContainer.innerHTML = '';

    if (!actions.length) {
        const fallback = document.createElement('div');
        fallback.className = 'action-buttons-empty';
        fallback.textContent = 'No actions configured. Update settings in the SmarTube options page.';
        buttonsContainer.appendChild(fallback);
        return;
    }

    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-button';
        button.textContent = action.label;
        button.title = action.prompt.length > 120 ? `${action.prompt.slice(0, 120)}…` : action.prompt;
        button.addEventListener('click', () => handleActionButtonClick(action));
        buttonsContainer.appendChild(button);
    });
}

function handleActionButtonClick(action) {
    const videoUrl = window.location.href;
    console.log(`Action button "${action.label}" triggered for URL:`, videoUrl);

    const userMessageHtml = `<strong>${escapeHtml(action.label)}</strong>`;
    appendMessage(userMessageHtml, 'user');

    const placeholderId = createPlaceholderId('action-placeholder');
    appendMessage(`<i>${escapeHtml(action.label)} in progress...</i>`, 'assistant', placeholderId);

    chrome.runtime.sendMessage({
        action: 'runCustomPrompt',
        actionId: action.id,
        url: videoUrl,
        label: action.label
    }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error sending runCustomPrompt message:", chrome.runtime.lastError.message);
            renderActionResult(placeholderId, "Error communicating with background script: " + chrome.runtime.lastError.message, true);
            return;
        }

        if (!response) {
            renderActionResult(placeholderId, "Received no response from the background script. Check background logs.", true);
            return;
        }

        if (response.error) {
            renderActionResult(placeholderId, response.error, true);
            return;
        }

        if (response.content) {
            renderActionResult(placeholderId, response.content, false);
        } else {
            renderActionResult(placeholderId, "Received empty response.", true);
        }
    });
}

function parseTimestampToSeconds(timestamp) {
    const parts = String(timestamp || '').split(':').map(part => Number(part));
    if (parts.some(part => !Number.isFinite(part) || part < 0)) {
        return null;
    }

    if (parts.length === 2) {
        const [minutes, seconds] = parts;
        if (seconds >= 60) return null;
        return (minutes * 60) + seconds;
    }

    if (parts.length === 3) {
        const [hours, minutes, seconds] = parts;
        if (minutes >= 60 || seconds >= 60) return null;
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    return null;
}

function buildYouTubeTimestampUrl(videoUrl, seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    try {
        const parsedUrl = new URL(videoUrl);
        parsedUrl.searchParams.set('t', `${safeSeconds}s`);
        return parsedUrl.toString();
    } catch (error) {
        const safeVideoUrl = typeof videoUrl === 'string' ? videoUrl : window.location.href;
        const separator = safeVideoUrl.includes('?') ? '&' : '?';
        return `${safeVideoUrl}${separator}t=${safeSeconds}s`;
    }
}

function linkifyTimestampsInContainer(container, videoUrl = window.location.href) {
    if (!container) return;

    const timestampRegex = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]|(\b\d{1,3}:\d{2}(?::\d{2})\b)/g;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node?.nodeValue || !/\d{1,3}:\d{2}/.test(node.nodeValue)) {
                return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (!parent || parent.closest('a, code, pre, textarea, script, style')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    textNodes.forEach((textNode) => {
        const originalText = textNode.nodeValue;
        timestampRegex.lastIndex = 0;

        let match;
        let lastIndex = 0;
        let replacedAny = false;
        const fragment = document.createDocumentFragment();

        while ((match = timestampRegex.exec(originalText)) !== null) {
            const matchedText = match[0];
            const rawTimestamp = match[1] || match[2];
            const seconds = parseTimestampToSeconds(rawTimestamp);

            if (seconds === null) {
                continue;
            }

            replacedAny = true;
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(originalText.slice(lastIndex, match.index)));
            }

            const link = document.createElement('a');
            link.className = TIMESTAMP_LINK_CLASS;
            link.href = buildYouTubeTimestampUrl(videoUrl, seconds);
            link.dataset.timestampSeconds = String(seconds);
            link.textContent = matchedText;
            link.title = `Jump to ${rawTimestamp}`;
            link.setAttribute('aria-label', `Jump to ${rawTimestamp}`);
            fragment.appendChild(link);

            lastIndex = match.index + matchedText.length;
        }

        if (!replacedAny) {
            return;
        }

        if (lastIndex < originalText.length) {
            fragment.appendChild(document.createTextNode(originalText.slice(lastIndex)));
        }

        textNode.parentNode.replaceChild(fragment, textNode);
    });
}

function seekVideoToTimestamp(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const videoElement = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const timestampUrl = buildYouTubeTimestampUrl(window.location.href, safeSeconds);

    if (videoElement) {
        videoElement.currentTime = safeSeconds;
        if (videoElement.paused) {
            videoElement.play().catch(() => {});
        }
        try {
            history.replaceState(history.state, '', timestampUrl);
        } catch (error) {
            // Ignore history update failures and keep playback seek.
        }
        return;
    }

    window.location.href = timestampUrl;
}

function handleTimestampLinkClick(event) {
    const link = event.target.closest(`a.${TIMESTAMP_LINK_CLASS}`);
    if (!link || !summaryDiv || !summaryDiv.contains(link)) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const seconds = Number(link.dataset.timestampSeconds);
    if (!Number.isFinite(seconds)) return;

    event.preventDefault();
    seekVideoToTimestamp(seconds);
}

function convertMarkdownToHtml(content) {
    if (typeof showdown !== 'undefined') {
        const converter = new showdown.Converter({
            simplifiedAutoLink: true,
            strikethrough: true,
            tables: true,
            tasklists: true
        });
        return converter.makeHtml(content);
    }
    console.warn("Showdown library not loaded; falling back to basic formatting.");
    return content.replace(/\n/g, '<br>');
}

function renderActionResult(placeholderId, content, isError = false) {
    if (!summaryDiv) return;
    const placeholder = summaryDiv.querySelector(`#${placeholderId}`);

    let htmlContent = '';
    if (isError) {
        htmlContent = `<strong>Error:</strong> ${content}`;
    } else {
        htmlContent = convertMarkdownToHtml(content);
    }

    if (!placeholder) {
        console.warn("Placeholder not found for action result. Appending content directly.");
        appendMessage(htmlContent, 'assistant');
        return;
    }

    if (containsArabic(content)) {
        placeholder.setAttribute('dir', 'rtl');
    } else {
        placeholder.setAttribute('dir', 'ltr');
    }

    placeholder.innerHTML = htmlContent;
    linkifyTimestampsInContainer(placeholder, window.location.href);
    placeholder.removeAttribute('id');
    scrollMessagesToBottom();
}

// Function to create the container for the summary display
function injectSummaryDivContainer() {
    if (!document.getElementById('youtube-summary-container-ext')) {
        const secondaryColumn = document.getElementById('secondary'); // The column with related videos etc.
        if (secondaryColumn) {
            // Reset overlay state for a fresh container.
            isExpandedView = false;
            summaryOriginalParent = null;
            summaryOriginalNextSibling = null;
            removeOverlayBackdrop();

            summaryDiv = document.createElement('div');
            summaryDiv.id = 'youtube-summary-container-ext';
            // Styles primarily in styles.css - container is visible by default

            // Set initial inner HTML with header and body structure
            summaryDiv.innerHTML = `
                <div id="summary-header-ext">
                    <span>SmarTube</span>
                    <div id="summary-header-buttons">
                        <button id="toggle-size-summary-btn" title="Expand view" aria-label="Expand view">⤢</button>
                        <button id="settings-summary-btn" title="Settings">⚙️</button>
                    </div>
                </div>
                <div id="summary-body-ext">
                    <div id="action-buttons-ext" class="action-buttons"></div>
                    <div id="messages-container-ext" class="messages-container"></div>
                </div>
                <div id="summary-footer-ext">
                    <textarea id="qa-input-ext" rows="1" placeholder="Ask anything about this video..."></textarea>
                    <button id="qa-send-btn-ext" title="Send">➤</button>
                </div>
            `;

            // Insert the summary div at the top of the secondary column
            secondaryColumn.insertBefore(summaryDiv, secondaryColumn.firstChild);

            // Apply the theme and check initial collapse state
            chrome.storage.sync.get(['theme', 'initialCollapsed', 'fontSize', 'customActionButtons'], (result) => {
                applyTheme(result.theme || 'auto'); // Default to 'auto' theme
                if (result.initialCollapsed) {
                    summaryDiv.classList.add('collapsed');
                }
                // Apply saved font size or default to 14
                const fontSize = result.fontSize || 14;
                summaryDiv.style.setProperty('--summary-font-size', `${fontSize}px`);

                const { actions, mutated } = ensureCustomActions(result.customActionButtons);
                customActions = actions;
                renderActionButtons(customActions);

                if (mutated) {
                    chrome.storage.sync.set({ customActionButtons: customActions });
                }
            });
            console.log("Summary div container injected.");

            // --- Add Event Listeners ---

            // Function to toggle collapse state
            const toggleCollapse = () => {
                summaryDiv.classList.toggle('collapsed');
            };

            // Settings button
            summaryDiv.querySelector('#settings-summary-btn').addEventListener('click', (event) => {
                event.stopPropagation(); // Prevent header click listener from firing
                console.log("Settings button clicked - sending message to open options page.");
                chrome.runtime.sendMessage({ action: "openOptionsPage" });
            });

            // Expand/minimize button
            summaryDiv.querySelector('#toggle-size-summary-btn').addEventListener('click', (event) => {
                event.stopPropagation(); // Prevent header click listener from firing
                toggleExpandedView();
            });

            // Header click (for collapse)
            summaryDiv.querySelector('#summary-header-ext').addEventListener('click', (event) => {
                if (!event.target.closest('#summary-header-buttons')) {
                     toggleCollapse();
                }
            });

            // Q&A Textarea (Enter/Shift+Enter)
            const qaInput = summaryDiv.querySelector('#qa-input-ext');
            qaInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    if (!event.shiftKey) { // Enter only (no shift)
                        event.preventDefault(); // Prevent newline
                        handleQuestionSubmit();
                    }
                    // If Shift+Enter, default behavior (newline) is allowed
                }
            });

            // Q&A Send Button
            summaryDiv.querySelector('#qa-send-btn-ext').addEventListener('click', handleQuestionSubmit);
            summaryDiv.addEventListener('click', handleTimestampLinkClick);

        } else {
            console.warn("Secondary column not found for summary div injection.");
        }
    }
}

// Function to extract video ID from URL
function getVideoIdFromUrl(url) {
    const urlParams = new URLSearchParams(new URL(url).search);
    return urlParams.get('v');
}

// Function to clear the existing summary container
function clearSummaryContainer() {
    if (summaryDiv) {
        setExpandedView(false);
    } else {
        removeOverlayBackdrop();
        isExpandedView = false;
        summaryOriginalParent = null;
        summaryOriginalNextSibling = null;
    }

    const existingContainer = document.getElementById('youtube-summary-container-ext');
    if (existingContainer) {
        existingContainer.remove();
    }
    summaryDiv = null;
}

// Function to check if URL has changed and reinitialize if needed
function handleUrlChange() {
    const newUrl = window.location.href;
    const newVideoId = getVideoIdFromUrl(newUrl);
    
    // Only proceed if we're on a watch page and the video ID has changed
    if (newUrl.includes('youtube.com/watch') && newVideoId && newVideoId !== currentVideoId) {
        currentVideoUrl = newUrl;
        currentVideoId = newVideoId;
        clearSummaryContainer();
        // Small delay to ensure YouTube's DOM has updated
        setTimeout(() => {
            injectSummaryDivContainer();
        }, 100);
    }
}

// Function to detect if text contains Arabic
function containsArabic(text) {
    const arabicPattern = /[\u0600-\u06FF]/;
    return arabicPattern.test(text);
}

// Function to append a message to the summary body (chat style)
function appendMessage(htmlContent, role, id = null) {
    if (!summaryDiv) return;
    const messagesContainer = getMessagesContainer();
    if (!messagesContainer) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}-message`;
    messageDiv.innerHTML = htmlContent; // Use innerHTML to allow basic formatting
    if (id) {
        messageDiv.id = id;
    }

    if (role === 'assistant') {
        linkifyTimestampsInContainer(messageDiv, window.location.href);
    }

    // Check if content contains Arabic and set RTL if needed
    if (containsArabic(messageDiv.textContent)) {
        messageDiv.setAttribute('dir', 'rtl');
    }

    messagesContainer.appendChild(messageDiv);
    scrollMessagesToBottom();
}

// Function to apply the theme class based on the setting ('auto', 'light', 'dark')
function applyTheme(themeSetting) {
    if (!summaryDiv) return; // Exit if summaryDiv doesn't exist yet

    let applyDarkTheme = false;

    if (themeSetting === 'auto') {
        // Detect YouTube's theme by checking the 'dark' attribute on the <html> element
        applyDarkTheme = document.documentElement.hasAttribute('dark');
        console.log(`Auto theme detection: YouTube is ${applyDarkTheme ? 'dark' : 'light'}`);
    } else {
        // Use the explicit setting
        applyDarkTheme = themeSetting === 'dark';
    }

    // Apply theme class to the main container
    if (applyDarkTheme) {
        summaryDiv.classList.add('dark-theme');
    } else {
        summaryDiv.classList.remove('dark-theme');
    }
    console.log(`Applied theme: ${applyDarkTheme ? 'dark' : 'light'} (Setting: ${themeSetting})`);
}

// Handle submission of a question from the input footer
function handleQuestionSubmit() {
    if (!summaryDiv) return;
    const qaInput = summaryDiv.querySelector('#qa-input-ext');
    const questionText = qaInput.value.trim();

    if (questionText) {
        console.log("Submitting question:", questionText);
        // Set RTL for input if Arabic is detected
        if (containsArabic(questionText)) {
            qaInput.setAttribute('dir', 'rtl');
        } else {
            qaInput.setAttribute('dir', 'ltr');
        }
        // Clear input
        qaInput.value = '';
        // Append user message
        // Basic escaping for display
        const escapedQuestion = escapeHtml(questionText);
        appendMessage(escapedQuestion, 'user');
        // Append thinking placeholder
        appendMessage("<i>Thinking...</i>", 'assistant', 'thinking-placeholder');

        // Send to background
        const videoUrl = window.location.href;
        chrome.runtime.sendMessage({ action: "askQuestion", question: questionText, url: videoUrl }, (response) => {
             if (chrome.runtime.lastError) {
                console.error("Error sending question message:", chrome.runtime.lastError.message);
                displayAnswer("Error communicating with background script: " + chrome.runtime.lastError.message, true);
                return;
            }
            // Response handling is done via the 'answerResponse' listener now
            if (response && response.status) {
                 console.log("Background acknowledged question:", response.status);
            }
        });
    }
}

// Function to display the answer received from the background script
function displayAnswer(content, isError = false) {
     renderActionResult('thinking-placeholder', content, isError);
}

// --- Initialization and Handling YouTube's Dynamic Loading ---

// YouTube uses dynamic navigation (SPA). We need to watch for the appearance
// of the secondary column and URL changes
const observer = new MutationObserver(mutations => {
    // Check if we're on a watch page
    if (window.location.href.includes('youtube.com/watch')) {
        // Handle URL changes
        handleUrlChange();
        
        // Check if the secondary column exists and our container isn't already there
        const secondaryColumn = document.getElementById('secondary');
        const existingContainer = document.getElementById('youtube-summary-container-ext');
        
        if (secondaryColumn && !existingContainer) {
            injectSummaryDivContainer();
        }
    }
});

// Start observing the document body for changes
observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false
});

// Watch for URL changes using the History API
const pushState = history.pushState;
history.pushState = function() {
    pushState.apply(history, arguments);
    handleUrlChange();
};

window.addEventListener('popstate', handleUrlChange);

// Initial setup when the script first loads
if (window.location.href.includes('youtube.com/watch')) {
    currentVideoUrl = window.location.href;
    currentVideoId = getVideoIdFromUrl(currentVideoUrl);
    
    const initialCheckInterval = setInterval(() => {
        const secondaryColumn = document.getElementById('secondary');
        if (secondaryColumn) {
            clearInterval(initialCheckInterval);
            injectSummaryDivContainer();
        }
    }, 500);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;

    if (changes.customActionButtons) {
        const { actions } = ensureCustomActions(changes.customActionButtons.newValue);
        customActions = actions;
        renderActionButtons(customActions);
    }

    if (changes.fontSize) {
        const newFontSize = changes.fontSize.newValue || 14;
        if (summaryDiv) {
            summaryDiv.style.setProperty('--summary-font-size', `${newFontSize}px`);
        }
    }
});

// Listen for messages from background script or options page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateTheme") {
        console.log("Theme update message received:", request.theme);
        applyTheme(request.theme);
        sendResponse({ status: "Theme updated" });
        return false; // Synchronous response
    } else if (request.action === "answerResponse") {
        console.log("Answer response received from background:", request);
        if (request.answer) {
            displayAnswer(request.answer, false);
        } else if (request.error) {
            displayAnswer(request.error, true);
        }
        // No response needed back to background for this
        return false; // Synchronous handling
    }
    // Return true only if we expect to sendResponse asynchronously (e.g., for getSummary)
    // For other messages handled synchronously or not needing a response, return false or nothing.
});
