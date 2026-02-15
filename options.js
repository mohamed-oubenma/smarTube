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

let customActionsState = [];
let currentCustomActionEditId = null;

function generateActionId() {
    return `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

function sanitizeCustomActions(actions = []) {
    const seenIds = new Set();
    const sanitized = [];
    let mutated = false;

    if (Array.isArray(actions)) {
        actions.forEach((rawAction) => {
            if (!rawAction) {
                mutated = true;
                return;
            }
            const label = typeof rawAction.label === 'string' ? rawAction.label.trim() : '';
            let prompt = typeof rawAction.prompt === 'string' ? rawAction.prompt.trim() : '';
            let id = typeof rawAction.id === 'string' ? rawAction.id.trim() : '';
            const mode = normalizeActionMode(rawAction.mode);

            if (!label) {
                mutated = true;
                return;
            }

            if (!id) {
                id = generateActionId();
                mutated = true;
            }
            if (seenIds.has(id)) {
                id = generateActionId();
                mutated = true;
            }

            if (mode === 'gemini' && !prompt) {
                mutated = true;
                return;
            }

            if (isTranscriptMode(mode) && !prompt) {
                prompt = getTranscriptPromptForMode(mode);
                mutated = true;
            }

            seenIds.add(id);
            sanitized.push({ id, label, prompt, mode });
        });
    }

    if (sanitized.length === 0) {
        sanitized.push(getDefaultAction());
        sanitized.push(getTranscriptTimestampsAction());
        sanitized.push(getTranscriptTextAction());
        return { actions: sanitized, mutated: true };
    }

    if (!sanitized.some(action => action.id === DEFAULT_ACTION_ID)) {
        sanitized.unshift(getDefaultAction());
        mutated = true;
    }

    if (!sanitized.some(action => action.id === TRANSCRIPT_TIMESTAMPS_ACTION_ID)) {
        sanitized.splice(1, 0, getTranscriptTimestampsAction());
        mutated = true;
    }

    if (!sanitized.some(action => action.id === TRANSCRIPT_TEXT_ACTION_ID)) {
        sanitized.splice(2, 0, getTranscriptTextAction());
        mutated = true;
    }

    return { actions: sanitized, mutated: mutated || sanitized.length !== actions.length };
}

function ensureCustomActionsInitialized(actions = []) {
    const { actions: sanitized, mutated } = sanitizeCustomActions(actions);
    return { actions: sanitized, mutated };
}

function showStatus(message, color = 'green', timeout = 1500) {
    const status = document.getElementById('statusMessage');
    if (!status) return;

    status.textContent = message;
    status.style.color = color;

    if (message && timeout > 0) {
        const currentMessage = message;
        setTimeout(() => {
            if (status.textContent === currentMessage) {
                status.textContent = '';
            }
        }, timeout);
    }
}

function resetCustomActionForm() {
    const labelInput = document.getElementById('newActionLabel');
    const promptInput = document.getElementById('newActionPrompt');
    const saveButton = document.getElementById('saveCustomActionBtn');
    const cancelButton = document.getElementById('cancelCustomActionEditBtn');

    if (labelInput) labelInput.value = '';
    if (promptInput) promptInput.value = '';
    currentCustomActionEditId = null;

    if (saveButton) saveButton.textContent = 'Add Action';
    if (cancelButton) cancelButton.hidden = true;
}

function populateCustomActionForm(action) {
    const labelInput = document.getElementById('newActionLabel');
    const promptInput = document.getElementById('newActionPrompt');
    const saveButton = document.getElementById('saveCustomActionBtn');
    const cancelButton = document.getElementById('cancelCustomActionEditBtn');

    if (!action) return;
    currentCustomActionEditId = action.id;

    if (labelInput) labelInput.value = action.label;
    if (promptInput) promptInput.value = action.prompt;
    if (saveButton) saveButton.textContent = 'Update Action';
    if (cancelButton) cancelButton.hidden = false;
}

function renderCustomActionsList(actions = []) {
    const listElement = document.getElementById('customActionsList');
    if (!listElement) return;

    listElement.innerHTML = '';

    if (!actions.length) {
        const emptyState = document.createElement('p');
        emptyState.textContent = 'No custom actions configured yet.';
        listElement.appendChild(emptyState);
        return;
    }

    actions.forEach((action) => {
        const item = document.createElement('div');
        item.className = 'custom-action-item';

        const header = document.createElement('div');
        header.className = 'custom-action-item-header';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'custom-action-item-title-group';

        const title = document.createElement('span');
        title.className = 'custom-action-item-title';
        title.textContent = action.label;
        titleGroup.appendChild(title);

        const normalizedMode = normalizeActionMode(action.mode);
        const typeBadge = document.createElement('span');
        typeBadge.className = `custom-action-type ${isTranscriptMode(normalizedMode) ? 'type-transcript' : 'type-gemini'}`;
        if (normalizedMode === 'transcript_timestamps') {
            typeBadge.textContent = 'Transcript + time';
        } else if (normalizedMode === 'transcript_text') {
            typeBadge.textContent = 'Transcript text';
        } else {
            typeBadge.textContent = 'Gemini prompt';
        }
        titleGroup.appendChild(typeBadge);

        header.appendChild(titleGroup);

        const buttonBar = document.createElement('div');
        buttonBar.className = 'custom-action-item-buttons';

        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'mini-button';
        editButton.textContent = 'Edit';
        editButton.addEventListener('click', () => handleEditCustomAction(action.id));

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'mini-button secondary-button';
        deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', () => handleDeleteCustomAction(action.id));

        buttonBar.appendChild(editButton);
        buttonBar.appendChild(deleteButton);
        header.appendChild(buttonBar);

        const promptPreview = document.createElement('div');
        promptPreview.className = 'custom-action-item-prompt';
        promptPreview.textContent = action.prompt;

        item.appendChild(header);
        item.appendChild(promptPreview);

        listElement.appendChild(item);
    });
}

function persistCustomActions(updatedActions, successMessage) {
    const { actions, mutated } = ensureCustomActionsInitialized(updatedActions);
    customActionsState = actions;

    chrome.storage.sync.set({ customActionButtons: customActionsState }, () => {
        renderCustomActionsList(customActionsState);
        if (successMessage) {
            const message = mutated && updatedActions.length === 0
                ? `${successMessage} Default summarize action restored.`
                : successMessage;
            showStatus(message);
        }
    });
}

function handleSaveCustomAction() {
    const labelInput = document.getElementById('newActionLabel');
    const promptInput = document.getElementById('newActionPrompt');

    const label = labelInput ? labelInput.value.trim() : '';
    const prompt = promptInput ? promptInput.value.trim() : '';

    if (!label) {
        showStatus('Button label is required.', 'red');
        if (labelInput) labelInput.focus();
        return;
    }

    if (!prompt) {
        showStatus('Prompt is required.', 'red');
        if (promptInput) promptInput.focus();
        return;
    }

    if (currentCustomActionEditId) {
        const index = customActionsState.findIndex(action => action.id === currentCustomActionEditId);
        const existingMode = index !== -1 ? (customActionsState[index].mode || 'gemini') : 'gemini';
        if (index !== -1) {
            customActionsState[index] = {
                ...customActionsState[index],
                label,
                prompt,
                mode: existingMode
            };
        } else {
            customActionsState.push({
                id: currentCustomActionEditId,
                label,
                prompt,
                mode: existingMode
            });
        }
        persistCustomActions(customActionsState, 'Custom action updated.');
    } else {
        const newAction = {
            id: generateActionId(),
            label,
            prompt,
            mode: 'gemini'
        };
        customActionsState.push(newAction);
        persistCustomActions(customActionsState, 'Custom action added.');
    }

    resetCustomActionForm();
}

function handleEditCustomAction(actionId) {
    const action = customActionsState.find(item => item.id === actionId);
    if (!action) {
        showStatus('Unable to find action to edit.', 'red');
        return;
    }
    populateCustomActionForm(action);
}

function handleCancelCustomActionEdit() {
    resetCustomActionForm();
    showStatus('Edit cancelled.', 'gray', 1000);
}

function handleDeleteCustomAction(actionId) {
    if (!customActionsState.length) {
        return;
    }

    const action = customActionsState.find(item => item.id === actionId);
    if (!action) {
        showStatus('Unable to find action to delete.', 'red');
        return;
    }

    if (
        action.id === DEFAULT_ACTION_ID
        || action.id === TRANSCRIPT_TIMESTAMPS_ACTION_ID
        || action.id === TRANSCRIPT_TEXT_ACTION_ID
    ) {
        showStatus('Built-in actions cannot be deleted.', 'red', 1800);
        return;
    }

    if (!confirm(`Delete the "${action.label}" action?`)) {
        return;
    }

    const updated = customActionsState.filter(item => item.id !== actionId);
    const successMessage = updated.length === 0
        ? 'Custom action deleted.'
        : `Deleted "${action.label}".`;

    persistCustomActions(updated, successMessage);
    resetCustomActionForm();
}

// Function to save general options to chrome.storage
function saveOptions() {
    const geminiKey = document.getElementById('geminiApiKey').value;
    const geminiModel = document.getElementById('geminiModel').value;
    // Supadata keys are saved separately by their specific handlers
    const language = document.getElementById('summaryLanguage').value;
    const theme = document.querySelector('input[name="theme"]:checked').value;
    const initialCollapsed = document.getElementById('initialCollapsed').checked;
    const fontSize = parseInt(document.getElementById('current-font-size').textContent);

    chrome.storage.sync.set({
        geminiApiKey: geminiKey,
        geminiModel: geminiModel,
        // supadataApiKey is no longer saved here
        summaryLanguage: language,
        theme: theme,
        initialCollapsed: initialCollapsed,
        fontSize: fontSize
    }, () => {
        // Update status to let user know options were saved.
        showStatus('General settings saved.');
        
        // Send theme update to content script
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0] && tabs[0].id) { // Check if tabs[0].id exists
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'updateTheme',
                    theme: theme
                });
            }
        });

    });
}

// --- Supadata API Key Management ---

function renderSupadataKeysList(keysArray = [], activeKeyId = null) {
    const listElement = document.getElementById('supadataKeysList');
    listElement.innerHTML = ''; // Clear current list

    if (keysArray.length === 0) {
        listElement.textContent = 'No Supadata API keys added yet.';
        return;
    }

    const ul = document.createElement('ul');
    ul.style.listStyleType = 'none';
    ul.style.paddingLeft = '0';

    keysArray.forEach(keyObj => {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.alignItems = 'center';
        li.style.marginBottom = '8px';
        li.style.padding = '5px';
        li.style.border = '1px solid #eee';
        li.style.borderRadius = '4px';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'activeSupadataKey';
        radio.value = keyObj.id;
        radio.checked = keyObj.id === activeKeyId;
        radio.style.marginRight = '10px';
        radio.addEventListener('change', () => handleActivateSupadataKey(keyObj.id));

        const nameSpan = document.createElement('span');
        nameSpan.textContent = keyObj.name ? `${keyObj.name} (${maskApiKey(keyObj.key)})` : maskApiKey(keyObj.key);
        nameSpan.style.flexGrow = '1';
        if (keyObj.isRateLimited) {
            nameSpan.textContent += ' (Rate-Limited)';
            nameSpan.style.color = 'orange';
        }


        const deleteButton = document.createElement('button');
        deleteButton.textContent = 'Delete';
        deleteButton.style.marginLeft = '10px';
        deleteButton.style.padding = '3px 8px';
        deleteButton.addEventListener('click', () => handleDeleteSupadataKey(keyObj.id));

        li.appendChild(radio);
        li.appendChild(nameSpan);
        li.appendChild(deleteButton);
        ul.appendChild(li);
    });
    listElement.appendChild(ul);
}

function maskApiKey(apiKey) {
    if (apiKey.length > 8) {
        return `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`;
    }
    return apiKey;
}

async function handleAddSupadataKey() {
    const keyNameInput = document.getElementById('newSupadataKeyName');
    const keyValueInput = document.getElementById('newSupadataKey');
    const name = keyNameInput.value.trim();
    const value = keyValueInput.value.trim();

    if (!value) {
        alert('API Key Value cannot be empty.');
        return;
    }

    const newKey = {
        id: Date.now().toString(),
        key: value,
        name: name || '',
        isRateLimited: false
    };

    chrome.storage.sync.get({ supadataApiKeys: [], activeSupadataKeyId: null }, (data) => {
        const updatedKeys = [...data.supadataApiKeys, newKey];
        let newActiveKeyId = data.activeSupadataKeyId;

        if (!newActiveKeyId && updatedKeys.length > 0) { // If no key was active, make the new one active
            newActiveKeyId = newKey.id;
        } else if (updatedKeys.length === 1) { // If this is the only key, make it active
             newActiveKeyId = newKey.id;
        }


        chrome.storage.sync.set({ supadataApiKeys: updatedKeys, activeSupadataKeyId: newActiveKeyId }, () => {
            keyNameInput.value = '';
            keyValueInput.value = '';
            renderSupadataKeysList(updatedKeys, newActiveKeyId);
            showStatus('Supadata API Key added.');
        });
    });
}

async function handleDeleteSupadataKey(keyIdToDelete) {
    chrome.storage.sync.get({ supadataApiKeys: [], activeSupadataKeyId: null }, (data) => {
        const filteredKeys = data.supadataApiKeys.filter(key => key.id !== keyIdToDelete);
        let newActiveKeyId = data.activeSupadataKeyId;

        if (data.activeSupadataKeyId === keyIdToDelete) { // If the deleted key was active
            if (filteredKeys.length > 0) {
                newActiveKeyId = filteredKeys[0].id; // Make the first remaining key active
            } else {
                newActiveKeyId = null; // No keys left
            }
        }

        chrome.storage.sync.set({ supadataApiKeys: filteredKeys, activeSupadataKeyId: newActiveKeyId }, () => {
            renderSupadataKeysList(filteredKeys, newActiveKeyId);
            showStatus('Supadata API Key deleted.');
        });
    });
}

async function handleActivateSupadataKey(keyIdToActivate) {
    chrome.storage.sync.get({ supadataApiKeys: [] }, (data) => {
        // Mark the newly activated key as not rate-limited, as the user is explicitly choosing it.
        const updatedKeys = data.supadataApiKeys.map(k => 
            k.id === keyIdToActivate ? { ...k, isRateLimited: false } : k
        );

        chrome.storage.sync.set({ supadataApiKeys: updatedKeys, activeSupadataKeyId: keyIdToActivate }, () => {
            renderSupadataKeysList(updatedKeys, keyIdToActivate);
            showStatus('Supadata API Key activated.');
        });
    });
}


// Function to restore options from chrome.storage
function restoreOptions() {
    // Use default values if keys aren't set
    chrome.storage.sync.get({
        geminiApiKey: '',
        geminiModel: 'gemini-2.5-flash-lite',
        // supadataApiKey: '', // Old single key
        supadataApiKeys: [],     // New array for multiple keys
        activeSupadataKeyId: null, // ID of the active Supadata key
        summaryLanguage: 'auto',
        theme: 'auto',
        initialCollapsed: false,
        fontSize: 14,
        customActionButtons: []
    }, (items) => {
        document.getElementById('geminiApiKey').value = items.geminiApiKey;
        document.getElementById('geminiModel').value = items.geminiModel;
        // document.getElementById('supadataApiKey').value = items.supadataApiKey; // Old single key
        renderSupadataKeysList(items.supadataApiKeys, items.activeSupadataKeyId); // Render the list of Supadata keys
        document.getElementById('summaryLanguage').value = items.summaryLanguage;
        document.getElementById('initialCollapsed').checked = items.initialCollapsed;
        
        // Set theme radio button
        const themeRadio = document.getElementById(`theme${items.theme.charAt(0).toUpperCase() + items.theme.slice(1)}`);
        if (themeRadio) themeRadio.checked = true;
        
        // Apply the theme
        applyTheme(items.theme);

        // Set font size
        updateFontSize(items.fontSize);

        const { actions, mutated } = ensureCustomActionsInitialized(items.customActionButtons);
        customActionsState = actions;
        renderCustomActionsList(customActionsState);
        if (mutated) {
            chrome.storage.sync.set({ customActionButtons: customActionsState });
        }
    });
}

// Function to apply theme to the options page
function applyTheme(theme) {
    if (theme === 'auto') {
        // Check system dark mode preference
        const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', systemPrefersDark ? 'dark' : 'light');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
    }
}

// Function to update font size display and preview
function updateFontSize(size) {
    const currentSize = document.getElementById('current-font-size');
    currentSize.textContent = `${size}px`;
    document.documentElement.style.setProperty('--preview-font-size', `${size}px`);
}

// Function to handle font size changes
function changeFontSize(increment) {
    const currentSize = parseInt(document.getElementById('current-font-size').textContent);
    const newSize = Math.max(10, Math.min(24, currentSize + increment));
    updateFontSize(newSize);
}

// Watch for system theme changes when in auto mode
if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        chrome.storage.sync.get('theme', (items) => {
            if (items.theme === 'auto') {
                applyTheme('auto');
            }
        });
    });
}

// Add event listeners once the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    restoreOptions();
    
    // Font size control listeners
    document.getElementById('increase-font-btn').addEventListener('click', () => changeFontSize(2));
    document.getElementById('decrease-font-btn').addEventListener('click', () => changeFontSize(-2));
    
    // Add theme change listener
    document.querySelectorAll('input[name="theme"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            applyTheme(e.target.value);
        });
    });
    
    // Save button for general settings
    document.getElementById('saveButton').addEventListener('click', saveOptions);

    // Add Supadata Key button listener
    document.getElementById('addSupadataKeyBtn').addEventListener('click', handleAddSupadataKey);

    // Custom action listeners
    document.getElementById('saveCustomActionBtn').addEventListener('click', handleSaveCustomAction);
    document.getElementById('cancelCustomActionEditBtn').addEventListener('click', handleCancelCustomActionEdit);
});
