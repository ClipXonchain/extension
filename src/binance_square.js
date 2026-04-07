
console.log('[ClipX] Binance Square Script Loaded');

// Global flags to prevent upload loops
let imagesAlreadyUploaded = false;
let videoAlreadyUploaded = false;
let autoPostAttempted = false;
const MAX_POST_RETRIES = 3; // Limit post button retries

// Helper to wait for element
function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve) => {
        if (document.querySelector(selector)) return resolve(document.querySelector(selector));
        const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) {
                observer.disconnect();
                resolve(document.querySelector(selector));
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
}

// Helper to find element by text content
function findElementByText(text, tag = '*') {
    const elements = document.querySelectorAll(tag);
    for (const el of elements) {
        if (el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
            return el;
        }
    }
    return null;
}

// Auto-Click "Create Post" button
async function autoClickCreatePost() {
    console.log('[ClipX] Looking for Create Post button...');

    // Multiple selector strategies for Create Post button
    const selectors = [
        'button[data-testid="create-post"]',
        'button[aria-label*="Create"]',
        'button[aria-label*="Post"]',
        '.create-post-btn',
        '[class*="create-post"]',
        '[class*="CreatePost"]',
        'button[class*="write"]',
    ];

    // Try selectors first
    for (const selector of selectors) {
        const btn = document.querySelector(selector);
        if (btn && btn.offsetParent !== null) {
            console.log('[ClipX] Found Create Post button via selector:', selector);
            btn.click();
            return true;
        }
    }

    // Try finding by text content
    const textMatches = ['Create Post', 'Write Post', 'Create', 'New Post'];
    for (const text of textMatches) {
        const el = findElementByText(text, 'button');
        if (el && el.offsetParent !== null) {
            console.log('[ClipX] Found Create Post button via text:', text);
            el.click();
            return true;
        }
        // Also check for divs/spans that might be clickable
        const div = findElementByText(text, 'div');
        if (div && div.offsetParent !== null && div.style.cursor === 'pointer') {
            console.log('[ClipX] Found Create Post div via text:', text);
            div.click();
            return true;
        }
    }

    // Look for "+" button (common pattern)
    const plusButtons = document.querySelectorAll('button, div[role="button"]');
    for (const btn of plusButtons) {
        if (btn.textContent.trim() === '+' || btn.querySelector('svg[class*="plus"]')) {
            console.log('[ClipX] Found + button');
            btn.click();
            return true;
        }
    }

    console.warn('[ClipX] Create Post button not found - user may need to click manually');
    return false;
}

// Auto-Click "Post" / "Submit" button to publish (inside the composer, NOT sidebar)
async function autoClickSubmitPost() {
    console.log('[ClipX] Looking for composer Post/Submit button...');

    // Wait a moment for content to be fully loaded
    await new Promise(r => setTimeout(r, 1000));

    // Strategy 0: EXACT Binance selector - button[data-bn-type="button"] with span containing "Post"
    const binanceButtons = document.querySelectorAll('button[data-bn-type="button"]');
    for (const btn of binanceButtons) {
        const spanText = btn.querySelector('span[data-bn-type="text"]');
        if (spanText && spanText.textContent.trim() === 'Post' && !btn.disabled && btn.offsetParent !== null) {
            // Make sure it's not the sidebar button (check position)
            const rect = btn.getBoundingClientRect();
            if (rect.left > 300) {
                console.log('[ClipX] Found exact Binance Post button via data-bn-type');
                btn.click();
                return true;
            }
        }
    }

    // Strategy 1: Find button inside a modal/overlay/dialog
    const modalContainers = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="Overlay"], [class*="popup"], [class*="Popup"], [class*="composer"], [class*="Composer"], [class*="editor"], [class*="Editor"]');

    for (const container of modalContainers) {
        const buttons = container.querySelectorAll('button');
        for (const btn of buttons) {
            const text = btn.textContent.trim();
            if ((text === 'Post' || text === 'Submit' || text === 'Publish') && !btn.disabled && btn.offsetParent !== null) {
                console.log('[ClipX] Found Post button inside modal:', text);
                btn.click();
                return true;
            }
        }
    }

    // Strategy 2: Find button near a character count (e.g., "946/3100")
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
        const text = btn.textContent.trim();
        if (text !== 'Post' && text !== 'Submit' && text !== 'Publish') continue;
        if (btn.disabled) continue;

        // Check if this button is NOT in the sidebar (sidebar usually has nav items)
        const parent = btn.closest('nav, [role="navigation"], aside, [class*="sidebar"], [class*="Sidebar"], [class*="menu"], [class*="Menu"]');
        if (parent) {
            console.log('[ClipX] Skipping sidebar Post button');
            continue;
        }

        // Check if there's a character count nearby (strong indicator of composer)
        const siblings = btn.parentElement?.querySelectorAll('*') || [];
        for (const sib of siblings) {
            if (/\d+\/\d+/.test(sib.textContent)) {
                console.log('[ClipX] Found Post button near character count');
                btn.click();
                return true;
            }
        }

        // Check parent containers for composer-like elements
        const composerParent = btn.closest('[class*="compose"], [class*="Compose"], [class*="create"], [class*="Create"], [class*="write"], [class*="Write"], [class*="post-form"], [class*="PostForm"]');
        if (composerParent) {
            console.log('[ClipX] Found Post button inside composer container');
            btn.click();
            return true;
        }
    }

    // Strategy 3: Find the LAST Post button on page (composer usually renders after sidebar)
    const postButtons = Array.from(allButtons).filter(btn => {
        const text = btn.textContent.trim();
        return (text === 'Post' || text === 'Submit' || text === 'Publish') && !btn.disabled && btn.offsetParent !== null;
    });

    if (postButtons.length > 1) {
        // Multiple Post buttons found - the composer one is usually the last one rendered
        const composerBtn = postButtons[postButtons.length - 1];
        console.log('[ClipX] Using last Post button (likely composer)');
        composerBtn.click();
        return true;
    } else if (postButtons.length === 1) {
        // Only one Post button - might be sidebar, check if editor exists
        const editor = document.querySelector('[contenteditable="true"], textarea');
        if (editor && editor.textContent.length > 0) {
            console.log('[ClipX] Single Post button with filled editor - clicking');
            postButtons[0].click();
            return true;
        }
    }

    // Strategy 4: Look for primary colored button (Binance yellow #F0B90B) that says Post
    for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (!text.includes('post')) continue;

        const style = window.getComputedStyle(btn);
        const bgColor = style.backgroundColor;

        // Binance yellow is rgb(240, 185, 11) or similar
        if ((bgColor.includes('240') && bgColor.includes('185')) ||
            (bgColor.includes('f0b90b')) ||
            style.background.includes('f0b90b')) {

            // Double-check it's not the sidebar by checking position
            const rect = btn.getBoundingClientRect();
            if (rect.left > 300) { // Composer button should be in the main content area, not left sidebar
                console.log('[ClipX] Found yellow Post button in content area');
                btn.click();
                return true;
            }
        }
    }

    console.warn('[ClipX] Composer Post button not found - user may need to click manually');
    return false;
}

// Wait for Post button to be ready and click it (with retries)
async function waitAndClickPostButton(maxRetries = 5, delayBetweenRetries = 2000) {
    console.log(`[ClipX] Waiting for Post button to be ready (${maxRetries} retries)...`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[ClipX] Post button attempt ${attempt}/${maxRetries}`);

        // Wait before each attempt (let images upload/process)
        await new Promise(r => setTimeout(r, delayBetweenRetries));

        // Try to click the post button
        const clicked = await autoClickSubmitPost();
        if (clicked) {
            console.log('[ClipX] Successfully clicked Post button!');
            return true;
        }

        // Check if post button is disabled (images still processing)
        const postBtns = document.querySelectorAll('button[data-bn-type="button"]');
        for (const btn of postBtns) {
            const spanText = btn.querySelector('span[data-bn-type="text"]');
            if (spanText && spanText.textContent.trim() === 'Post') {
                if (btn.disabled) {
                    console.log('[ClipX] Post button found but disabled - waiting for images to process...');
                } else {
                    // Button exists and isn't disabled - try clicking again
                    const rect = btn.getBoundingClientRect();
                    if (rect.left > 300) {
                        btn.click();
                        console.log('[ClipX] Clicked Post button directly!');
                        return true;
                    }
                }
            }
        }
    }

    console.warn('[ClipX] Could not click Post button after all retries');
    return false;
}

// Upload images to Binance using their file input (NOT clipboard paste)
async function uploadImagesToBinance(imageUrls, statusCallback) {
    if (!imageUrls || imageUrls.length === 0) return true;

    // Guard against multiple uploads
    if (imagesAlreadyUploaded) {
        console.log('[ClipX] Images already uploaded, skipping...');
        return true;
    }

    console.log(`[ClipX] Uploading ${imageUrls.length} images to Binance...`);

    // First, find or trigger the file input
    let fileInput = document.querySelector('input[type="file"][accept*="image"]') ||
        document.querySelector('input[type="file"]');

    // If no file input visible, try clicking the image upload button to reveal it
    if (!fileInput) {
        // Look for image/photo upload button (usually an icon)
        const uploadBtns = document.querySelectorAll('button, div[role="button"], span[role="button"]');
        for (const btn of uploadBtns) {
            const svg = btn.querySelector('svg');
            const text = btn.textContent.toLowerCase();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

            if (text.includes('image') || text.includes('photo') ||
                ariaLabel.includes('image') || ariaLabel.includes('photo') ||
                ariaLabel.includes('upload') || ariaLabel.includes('media')) {
                console.log('[ClipX] Clicking image upload button');
                btn.click();
                await new Promise(r => setTimeout(r, 500));
                break;
            }
        }

        // Try again to find file input
        fileInput = document.querySelector('input[type="file"][accept*="image"]') ||
            document.querySelector('input[type="file"]');
    }

    if (!fileInput) {
        console.warn('[ClipX] No file input found for image upload');
        return false;
    }

    console.log('[ClipX] Found file input:', fileInput);

    // Fetch all image blobs and create files
    const files = [];
    for (let i = 0; i < imageUrls.length; i++) {
        if (statusCallback) statusCallback(`Downloading image ${i + 1}/${imageUrls.length}...`);
        try {
            const blob = await fetchImageBlob(imageUrls[i]);
            const file = new File([blob], `clipx-image-${i + 1}.jpg`, {
                type: blob.type || 'image/jpeg',
                lastModified: Date.now()
            });
            files.push(file);
        } catch (e) {
            console.error(`[ClipX] Failed to fetch image ${i + 1}:`, e);
        }
    }

    if (files.length === 0) {
        console.warn('[ClipX] No images successfully downloaded');
        return false;
    }

    // Create DataTransfer with all files
    const dataTransfer = new DataTransfer();
    files.forEach(file => dataTransfer.items.add(file));

    // Set files to input
    if (statusCallback) statusCallback(`Uploading ${files.length} images...`);

    try {
        fileInput.files = dataTransfer.files;

        // Dispatch multiple events to ensure React/Vue picks up the change
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        // Also try triggering on the form if exists
        const form = fileInput.closest('form');
        if (form) {
            form.dispatchEvent(new Event('input', { bubbles: true }));
        }

        console.log('[ClipX] Images uploaded to file input');

        // Wait for upload to process
        await new Promise(r => setTimeout(r, 1500));
        imagesAlreadyUploaded = true; // Mark as uploaded to prevent loops
        return true;
    } catch (e) {
        console.error('[ClipX] Error setting file input:', e);
        return false;
    }
}

// Upload video to Binance using their file input
async function uploadVideoToBinance(videoUrl, tweetUrl, hasVideo, statusCallback) {
    if (!hasVideo) return { success: true, skipped: true };

    // Guard against multiple uploads
    if (videoAlreadyUploaded) {
        console.log('[ClipX] Video already uploaded, skipping...');
        return { success: true, skipped: true };
    }

    console.log('[ClipX] Attempting video upload to Binance...');
    if (statusCallback) statusCallback('Preparing video...');

    let videoBlob = null;

    // Helper function to fetch video via background script (bypasses CORS/403)
    async function fetchVideoViaBackground(url) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { action: 'fetchVideoBlob', url: url },
                (response) => {
                    if (response && response.success && response.dataUrl) {
                        // Convert data URL back to blob
                        fetch(response.dataUrl)
                            .then(r => r.blob())
                            .then(blob => resolve(blob))
                            .catch(() => resolve(null));
                    } else {
                        console.warn('[ClipX] Background video fetch failed:', response?.error);
                        resolve(null);
                    }
                }
            );
        });
    }

    // Method 1: If we have a direct video URL, fetch via background script
    if (videoUrl && !videoUrl.startsWith('blob:')) {
        try {
            if (statusCallback) statusCallback('Downloading video...');
            console.log('[ClipX] Fetching video via background:', videoUrl);
            videoBlob = await fetchVideoViaBackground(videoUrl);
            if (videoBlob) {
                console.log('[ClipX] Video downloaded via background, size:', videoBlob.size);
            }
        } catch (e) {
            console.warn('[ClipX] Background video fetch failed:', e);
        }
    }

    // Method 2: Extract video URL from tweet, then fetch via background
    if (!videoBlob && tweetUrl) {
        try {
            if (statusCallback) statusCallback('Extracting video...');
            console.log('[ClipX] Extracting video URL via background script...');

            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    { action: 'extractTwitterVideo', tweetUrl: tweetUrl },
                    resolve
                );
            });

            if (response && response.success && response.videoUrl) {
                if (statusCallback) statusCallback('Downloading video...');
                console.log('[ClipX] Got video URL, fetching via background:', response.videoUrl);
                videoBlob = await fetchVideoViaBackground(response.videoUrl);
                if (videoBlob) {
                    console.log('[ClipX] Extracted video downloaded, size:', videoBlob.size);
                }
            } else {
                console.warn('[ClipX] Video extraction failed:', response?.error);
                return { success: false, error: response?.error || 'Video extraction failed' };
            }
        } catch (e) {
            console.warn('[ClipX] Video extraction error:', e);
        }
    }

    if (!videoBlob) {
        console.warn('[ClipX] Could not obtain video - manual upload required');
        return { success: false, error: 'Could not download video' };
    }

    // Step 1: Find and click Binance's VIDEO upload button (separate from image button)
    if (statusCallback) statusCallback('Finding video button...');
    console.log('[ClipX] Looking for Binance video upload button...');

    let videoButtonClicked = false;

    // Strategy 1: Look for buttons/icons with video-related SVGs or attributes
    const allButtons = document.querySelectorAll('button, div[role="button"], span[role="button"], [data-bn-type="button"], .bn-button');
    for (const btn of allButtons) {
        const text = (btn.textContent || '').toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.getAttribute('title') || '').toLowerCase();
        const className = (btn.className || '').toLowerCase();

        // Check for video-related attributes
        if (text.includes('video') || ariaLabel.includes('video') ||
            title.includes('video') || className.includes('video')) {
            console.log('[ClipX] Found video button by text/attr:', btn);
            btn.click();
            videoButtonClicked = true;
            await new Promise(r => setTimeout(r, 800));
            break;
        }

        // Check SVG inside button - video icons often have specific paths
        const svg = btn.querySelector('svg');
        if (svg) {
            const svgHtml = svg.outerHTML.toLowerCase();
            // Video icon patterns: play button, film strip, camera with clapperboard
            if (svgHtml.includes('video') || svgHtml.includes('film') ||
                svgHtml.includes('movie') || svgHtml.includes('play')) {
                console.log('[ClipX] Found video button by SVG:', btn);
                btn.click();
                videoButtonClicked = true;
                await new Promise(r => setTimeout(r, 800));
                break;
            }
        }
    }

    // Strategy 2: Look for toolbar icons in the composer (usually the second icon after image)
    if (!videoButtonClicked) {
        const toolbarIcons = document.querySelectorAll('[class*="toolbar"] button, [class*="action"] button, [class*="icon"] button');
        console.log('[ClipX] Checking toolbar icons:', toolbarIcons.length);
        for (let i = 0; i < toolbarIcons.length; i++) {
            const btn = toolbarIcons[i];
            // Often video is the 2nd or 3rd icon in toolbar
            if (i === 1 || i === 2) {
                console.log('[ClipX] Trying toolbar button index', i);
                btn.click();
                await new Promise(r => setTimeout(r, 500));

                // Check if a video file input appeared
                const videoInput = document.querySelector('input[type="file"][accept*="video"]');
                if (videoInput) {
                    videoButtonClicked = true;
                    console.log('[ClipX] Video input appeared after clicking toolbar button', i);
                    break;
                }
            }
        }
    }

    // Step 2: Find the video file input (should appear after clicking video button)
    await new Promise(r => setTimeout(r, 500));

    let fileInput = document.querySelector('input[type="file"][accept*="video"]');

    // If no video-specific input, try any file input that allows video
    if (!fileInput) {
        const allInputs = document.querySelectorAll('input[type="file"]');
        for (const input of allInputs) {
            const accept = input.getAttribute('accept') || '';
            if (accept.includes('video') || accept.includes('mp4') || accept === '*' || accept === '') {
                fileInput = input;
                console.log('[ClipX] Found generic file input:', accept);
                break;
            }
        }
    }

    if (!fileInput) {
        console.warn('[ClipX] No video file input found - you may need to click the video icon manually');
        return { success: false, error: 'Click the video icon first, then try again' };
    }

    // Step 3: Create file and upload
    if (statusCallback) statusCallback('Uploading video...');
    console.log('[ClipX] Uploading to file input:', fileInput);

    try {
        const videoFile = new File([videoBlob], 'clipx-video.mp4', {
            type: videoBlob.type || 'video/mp4',
            lastModified: Date.now()
        });

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(videoFile);

        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        console.log('[ClipX] Video uploaded to file input, size:', videoFile.size);

        // Wait for video interface to appear
        if (statusCallback) statusCallback('Processing video...');
        await new Promise(r => setTimeout(r, 3000));

        videoAlreadyUploaded = true; // Mark as uploaded to prevent loops
        return { success: true };
    } catch (e) {
        console.error('[ClipX] Video upload error:', e);
        return { success: false, error: e.message };
    }
}

// Helper function to fill text in the video modal
async function fillVideoModalText(text) {
    console.log('[ClipX] Looking for video modal text field...');

    // Strategy 1: Find by placeholder containing "thoughts" or "share"
    let found = false;

    // Try textarea with placeholder
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
        const placeholder = ta.getAttribute('placeholder') || '';
        if (ta.offsetParent !== null && placeholder.toLowerCase().includes('thought')) {
            console.log('[ClipX] Found textarea with placeholder:', placeholder);
            ta.focus();
            ta.value = text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            found = true;
            break;
        }
    }

    if (found) return true;

    // Strategy 2: Find contenteditable near "Share your thoughts" text
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
        if (el.textContent === 'Share your thoughts' && el.children.length === 0) {
            // Found the placeholder text, look for nearby contenteditable
            const parent = el.parentElement;
            if (parent) {
                const editor = parent.querySelector('[contenteditable="true"]') ||
                    parent.closest('[contenteditable="true"]');
                if (editor) {
                    console.log('[ClipX] Found contenteditable near placeholder');
                    editor.focus();
                    editor.innerHTML = text.replace(/\n/g, '<br>');
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                    found = true;
                    break;
                }
            }
        }
    }

    if (found) return true;

    // Strategy 3: Find any visible contenteditable in a modal/dialog
    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="overlay"]');
    for (const modal of modals) {
        if (modal.offsetParent === null) continue;

        const editor = modal.querySelector('[contenteditable="true"]');
        if (editor && editor.offsetParent !== null) {
            console.log('[ClipX] Found contenteditable in modal');
            editor.focus();
            editor.innerHTML = text.replace(/\n/g, '<br>');
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            found = true;
            break;
        }

        const textarea = modal.querySelector('textarea');
        if (textarea && textarea.offsetParent !== null) {
            console.log('[ClipX] Found textarea in modal');
            textarea.focus();
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            found = true;
            break;
        }
    }

    if (found) return true;

    // Strategy 4: Look for any visible contenteditable with 0/600 or similar character counter nearby
    const allContentEditable = document.querySelectorAll('[contenteditable="true"]');
    for (const ce of allContentEditable) {
        if (ce.offsetParent === null) continue;

        // Check if there's a character counter nearby (like "0/600")
        const parentSection = ce.closest('div');
        if (parentSection) {
            const counterText = parentSection.textContent;
            if (counterText.match(/\d+\/\d+/)) {
                console.log('[ClipX] Found contenteditable with character counter');
                ce.focus();
                ce.innerHTML = text.replace(/\n/g, '<br>');
                ce.dispatchEvent(new Event('input', { bubbles: true }));
                found = true;
                break;
            }
        }
    }

    return found;
}

// Current image index for carousel
let currentImageIndex = 0;

// Generate image carousel HTML
function generateImageCarouselHTML(imageUrls) {
    if (!imageUrls || imageUrls.length === 0) return '';

    const hasMultiple = imageUrls.length > 1;

    return `
        <div style="font-size: 12px; color: #848e9c; margin-top: 5px; display: flex; justify-content: space-between; align-items: center;">
            <span>🖼️ Images:</span>
            ${hasMultiple ? `<span id="clipx-img-counter" style="font-size: 10px; color: #F0B90B;">1 of ${imageUrls.length}</span>` : ''}
        </div>
        <div style="position: relative; text-align: center; background: #0b0e11; padding: 5px; border-radius: 4px; margin-bottom:5px;">
            ${hasMultiple ? `
                <div id="clipx-img-prev" style="position: absolute; left: 5px; top: 50%; transform: translateY(-50%); cursor: pointer; background: rgba(0,0,0,0.5); padding: 8px 10px; border-radius: 4px; font-size: 14px; z-index: 10;">◀</div>
            ` : ''}
            <img id="clipx-preview-img" src="${imageUrls[0]}" draggable="true" style="max-width: 100%; max-height: 100px; object-fit: contain; cursor: grab; border: 1px solid #474d57;">
            ${hasMultiple ? `
                <div id="clipx-img-next" style="position: absolute; right: 5px; top: 50%; transform: translateY(-50%); cursor: pointer; background: rgba(0,0,0,0.5); padding: 8px 10px; border-radius: 4px; font-size: 14px; z-index: 10;">▶</div>
            ` : ''}
        </div>
        ${hasMultiple ? `
            <div style="display: flex; gap: 4px; margin-bottom: 5px; flex-wrap: wrap; justify-content: center;">
                ${imageUrls.map((url, i) => `
                    <img src="${url}" class="clipx-thumb" data-index="${i}" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px; cursor: pointer; border: 2px solid ${i === 0 ? '#F0B90B' : '#474d57'}; transition: border-color 0.2s;">
                `).join('')}
            </div>
        ` : ''}
        <div style="display:flex; gap:5px;">
            <button id="clipx-btn-dl-img" style="flex:1; padding: 6px; background: #2f3336; color: #eaecef; border: none; border-radius: 4px; cursor: pointer; font-size: 11px;">Download${hasMultiple ? ' All' : ''}</button>
            <button id="clipx-btn-paste-img" style="flex:1; padding: 6px; background: #F0B90B; color: #0b0e11; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:bold;">
                ${hasMultiple ? `Paste All (${imageUrls.length})` : 'Auto-Paste Img'}
            </button>
        </div>
    `;
}

// Generate history panel HTML
function generateHistoryHTML() {
    return `
        <div id="clipx-history-panel" style="display: none; margin-top: 10px; padding-top: 10px; border-top: 1px solid #2f3336;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <span style="font-size: 12px; color: #848e9c;">📜 Cross-Post History</span>
                <button id="clipx-clear-history" style="font-size: 10px; background: #ef4444; color: white; border: none; padding: 3px 8px; border-radius: 4px; cursor: pointer;">Clear</button>
            </div>
            <div id="clipx-history-list" style="max-height: 150px; overflow-y: auto; font-size: 11px;"></div>
        </div>
    `;
}

// Check for payload
chrome.storage.local.get(['crossPostPayload'], async (result) => {
    const payload = result.crossPostPayload;
    if (!payload || !window.location.href.includes('/square')) return;

    console.log('[ClipX] Found payload:', payload);

    // Support both single imageUrl and imageUrls array
    const imageUrls = payload.imageUrls || (payload.imageUrl ? [payload.imageUrl] : []);

    // ---------------------------------------------------------
    // AUTO-CLICK CREATE POST BUTTON
    // ---------------------------------------------------------
    setTimeout(async () => {
        const clicked = await autoClickCreatePost();
        if (clicked) {
            console.log('[ClipX] Create Post button clicked, waiting for editor...');
        }
    }, 1500);

    // ---------------------------------------------------------
    // RENDER FLOATING HELPER UI
    // ---------------------------------------------------------
    const helper = document.createElement('div');
    helper.id = 'clipx-helper-ui';
    helper.style.cssText = `
        position: fixed;
        top: 70px;
        right: 120px;
        width: 340px;
        max-height: calc(100vh - 80px);
        overflow-y: auto;
        background: #1e2329;
        border: 1px solid #474d57;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        color: #eaecef;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex;
        flex-direction: column;
    `;

    helper.innerHTML = `
        <div id="clipx-helper-header" style="background: #F0B90B; color: #0b0e11; padding: 10px; font-weight: bold; font-size: 14px; display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none;">
            <span>⋮⋮ Import X Post</span>
            <div style="display: flex; gap: 10px; align-items: center;">
                <span id="clipx-toggle-history" style="cursor: pointer; font-size: 14px;" title="View History">📜</span>
                <span id="clipx-close-helper" style="cursor: pointer; font-size: 18px;">&times;</span>
            </div>
        </div>
        <div style="padding: 15px; display: flex; flex-direction: column; gap: 10px;">
            <div style="font-size: 12px; color: #848e9c;">Text Content:</div>
            <textarea id="clipx-text-copy" style="width: 100%; height: 60px; background: #0b0e11; border: 1px solid #474d57; color: #eaecef; border-radius: 4px; padding: 5px; font-size: 12px; resize: none;">${payload.text || ''}</textarea>
            <button id="clipx-btn-copy-text" style="width: 100%; padding: 6px; background: #2f3336; color: #eaecef; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Copy Text</button>
            
            ${generateImageCarouselHTML(imageUrls)}
            
            ${payload.videoUrl ? `
                <div style="font-size: 12px; color: #848e9c; margin-top: 5px;">🎬 Video:</div>
                <div style="text-align: center; background: #0b0e11; padding: 5px; border-radius: 4px; margin-bottom:5px;">
                    <video src="${payload.videoUrl}" style="max-width: 100%; max-height: 80px; border: 1px solid #474d57;" controls muted></video>
                </div>
                <div style="display:flex; gap:5px;">
                    <button id="clipx-btn-dl-video" style="flex:1; padding: 6px; background: #2f3336; color: #eaecef; border: none; border-radius: 4px; cursor: pointer; font-size: 11px;">Download</button>
                    <button id="clipx-btn-upload-video" style="flex:1; padding: 6px; background: #F0B90B; color: #0b0e11; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:bold;">Upload to Binance</button>
                </div>
            ` : (payload.hasVideo && payload.tweetUrl ? `
                <div style="font-size: 12px; color: #848e9c; margin-top: 5px;">🎬 Video Tweet (Protected):</div>
                <div style="display:flex; gap:5px; margin-bottom:5px;">
                    <button id="clipx-btn-dl-video-ext" style="flex:1; padding: 8px; background: #22c55e; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:bold;">⬇️ Download</button>
                    <button id="clipx-btn-upload-video-ext" style="flex:1; padding: 8px; background: #F0B90B; color: #0b0e11; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight:bold;">📤 Upload</button>
                </div>
                <div style="font-size:9px; color:#71767b;">Video will be extracted and uploaded directly.</div>
            ` : (payload.hasVideo ? `
                <div style="font-size: 12px; color: #f97316; margin-top: 5px; padding: 8px; background: #0b0e11; border-radius: 4px; border: 1px solid #f97316;">
                    🎬 <b>Video Tweet</b> - No download link available.
                </div>
            ` : ''))}
            
            ${payload.tweetUrl ? `
                <div style="margin-top: 8px;">
                    <button id="clipx-btn-copy-link" style="width: 100%; padding: 6px; background: #2f3336; color: #eaecef; border: none; border-radius: 4px; cursor: pointer; font-size: 11px;">📋 Copy Tweet Link</button>
                </div>
            ` : ''}

            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #2f3336;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span style="font-size: 11px; color: #848e9c;">Auto-Post:</span>
                    <label style="display: flex; align-items: center; cursor: pointer;">
                        <input type="checkbox" id="clipx-autopost-toggle" style="display: none;">
                        <span id="clipx-autopost-slider" style="
                            width: 40px; height: 20px; background: #474d57; border-radius: 10px;
                            position: relative; transition: background 0.3s; display: inline-block;
                        ">
                            <span id="clipx-autopost-knob" style="
                                position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
                                background: #eaecef; border-radius: 50%; transition: left 0.3s;
                            "></span>
                        </span>
                        <span id="clipx-autopost-label" style="font-size: 11px; color: #848e9c; margin-left: 8px;">OFF</span>
                    </label>
                </div>
                <button id="clipx-btn-autofill" style="width: 100%; padding: 8px; background: #F0B90B; color: #0b0e11; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">⚡ Auto-Fill & Post</button>
            </div>
            <div style="font-size:10px; color:#71767b; text-align:center;">Tip: Toggle auto-post OFF to fill text/images only.</div>
            
            ${generateHistoryHTML()}
        </div>
    `;

    document.body.appendChild(helper);

    // ---------------------------------------------------------
    // IMAGE CAROUSEL NAVIGATION
    // ---------------------------------------------------------
    if (imageUrls.length > 1) {
        const prevBtn = document.getElementById('clipx-img-prev');
        const nextBtn = document.getElementById('clipx-img-next');
        const previewImg = document.getElementById('clipx-preview-img');
        const counter = document.getElementById('clipx-img-counter');
        const thumbs = document.querySelectorAll('.clipx-thumb');

        const updateImage = (index) => {
            currentImageIndex = index;
            previewImg.src = imageUrls[index];
            counter.textContent = `${index + 1} of ${imageUrls.length}`;
            thumbs.forEach((t, i) => {
                t.style.borderColor = i === index ? '#F0B90B' : '#474d57';
            });
        };

        if (prevBtn) prevBtn.onclick = () => updateImage((currentImageIndex - 1 + imageUrls.length) % imageUrls.length);
        if (nextBtn) nextBtn.onclick = () => updateImage((currentImageIndex + 1) % imageUrls.length);

        thumbs.forEach(thumb => {
            thumb.onclick = () => updateImage(parseInt(thumb.dataset.index));
        });
    }

    // ---------------------------------------------------------
    // HISTORY PANEL
    // ---------------------------------------------------------
    const toggleHistoryBtn = document.getElementById('clipx-toggle-history');
    const historyPanel = document.getElementById('clipx-history-panel');
    const historyList = document.getElementById('clipx-history-list');
    const clearHistoryBtn = document.getElementById('clipx-clear-history');

    const loadHistory = () => {
        chrome.storage.local.get(['crossPostHistory'], (res) => {
            const history = res.crossPostHistory || [];
            if (history.length === 0) {
                historyList.innerHTML = '<div style="color: #71767b; padding: 10px; text-align: center;">No history yet</div>';
                return;
            }
            historyList.innerHTML = history.map(h => `
                <div style="padding: 8px; background: #0b0e11; border-radius: 4px; margin-bottom: 4px; border-left: 3px solid #F0B90B;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="color: #eaecef; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${h.tweetText || '[No text]'}</span>
                        ${h.imageCount > 0 ? `<span style="font-size: 9px; color: #848e9c; margin-left: 5px;">🖼️${h.imageCount}</span>` : ''}
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-top: 4px;">
                        <span style="font-size: 9px; color: #71767b;">${new Date(h.timestamp).toLocaleString()}</span>
                        ${h.tweetUrl ? `<a href="${h.tweetUrl}" target="_blank" style="font-size: 9px; color: #1d9bf0; text-decoration: none;">View ↗</a>` : ''}
                    </div>
                </div>
            `).join('');
        });
    };

    if (toggleHistoryBtn) {
        toggleHistoryBtn.onclick = () => {
            const isHidden = historyPanel.style.display === 'none';
            historyPanel.style.display = isHidden ? 'block' : 'none';
            if (isHidden) loadHistory();
        };
    }

    if (clearHistoryBtn) {
        clearHistoryBtn.onclick = () => {
            if (confirm('Clear all cross-post history?')) {
                chrome.storage.local.set({ crossPostHistory: [] }, () => {
                    loadHistory();
                });
            }
        };
    }

    // ---------------------------------------------------------
    // AUTO-POST TOGGLE
    // ---------------------------------------------------------
    const autoPostToggle = document.getElementById('clipx-autopost-toggle');
    const autoPostSlider = document.getElementById('clipx-autopost-slider');
    const autoPostKnob = document.getElementById('clipx-autopost-knob');
    const autoPostLabel = document.getElementById('clipx-autopost-label');

    // Load saved preference
    chrome.storage.local.get(['autoPostEnabled'], (result) => {
        const enabled = result.autoPostEnabled !== false; // Default to true
        updateAutoPostToggle(enabled);
    });

    function updateAutoPostToggle(enabled) {
        if (autoPostToggle) autoPostToggle.checked = enabled;
        if (autoPostSlider) autoPostSlider.style.background = enabled ? '#F0B90B' : '#474d57';
        if (autoPostKnob) autoPostKnob.style.left = enabled ? '22px' : '2px';
        if (autoPostLabel) {
            autoPostLabel.textContent = enabled ? 'ON' : 'OFF';
            autoPostLabel.style.color = enabled ? '#F0B90B' : '#848e9c';
        }
    }

    if (autoPostSlider) {
        autoPostSlider.onclick = () => {
            const newState = !autoPostToggle.checked;
            updateAutoPostToggle(newState);
            chrome.storage.local.set({ autoPostEnabled: newState });
            console.log('[ClipX] Auto-post toggled:', newState ? 'ON' : 'OFF');
        };
    }

    // ---------------------------------------------------------
    // DRAG TO REPOSITION
    // ---------------------------------------------------------
    const header = document.getElementById('clipx-helper-header');
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener('mousedown', (e) => {
        // Don't drag if clicking interactive elements
        if (e.target.id === 'clipx-close-helper' || e.target.id === 'clipx-toggle-history') return;

        isDragging = true;
        dragOffsetX = e.clientX - helper.getBoundingClientRect().left;
        dragOffsetY = e.clientY - helper.getBoundingClientRect().top;
        helper.style.transition = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const newX = e.clientX - dragOffsetX;
        const newY = e.clientY - dragOffsetY;

        // Keep within viewport bounds
        const maxX = window.innerWidth - helper.offsetWidth;
        const maxY = window.innerHeight - helper.offsetHeight;

        helper.style.left = Math.max(0, Math.min(newX, maxX)) + 'px';
        helper.style.top = Math.max(0, Math.min(newY, maxY)) + 'px';
        helper.style.right = 'auto'; // Switch from right to left positioning
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    // Event Listeners
    document.getElementById('clipx-close-helper').onclick = () => {
        helper.remove();
        chrome.storage.local.remove(['crossPostPayload']); // Clear payload on close
    };

    document.getElementById('clipx-btn-copy-text').onclick = () => {
        const ta = document.getElementById('clipx-text-copy');
        ta.select();
        document.execCommand('copy');
        const btn = document.getElementById('clipx-btn-copy-text');
        const original = btn.innerText;
        btn.innerText = 'Copied!';
        setTimeout(() => btn.innerText = original, 2000);
    };

    if (imageUrls.length > 0) {
        // DOWNLOAD IMAGE(S)
        document.getElementById('clipx-btn-dl-img').onclick = async () => {
            const btn = document.getElementById('clipx-btn-dl-img');
            const originalText = btn.innerText;
            try {
                btn.innerText = 'Downloading...';
                for (let i = 0; i < imageUrls.length; i++) {
                    const blob = await fetchImageBlob(imageUrls[i]);
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = `clipx-image-${i + 1}.jpg`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(blobUrl);
                }
                btn.innerText = 'Done!';
            } catch (e) {
                console.error(e);
                btn.innerText = 'Error';
            }
            setTimeout(() => btn.innerText = originalText, 2000);
        };

        // AUTO-PASTE IMAGE(S) - Use file input method
        document.getElementById('clipx-btn-paste-img').onclick = async () => {
            const btn = document.getElementById('clipx-btn-paste-img');
            const originalText = btn.innerText;

            const uploaded = await uploadImagesToBinance(imageUrls, (status) => {
                btn.innerText = status;
            });

            if (uploaded) {
                btn.innerText = '✅ Done!';
            } else {
                btn.innerText = '❌ Failed';
            }
            setTimeout(() => btn.innerText = originalText, 3000);
        };
    }

    // VIDEO DOWNLOAD
    if (payload.videoUrl) {
        document.getElementById('clipx-btn-dl-video').onclick = async () => {
            const btn = document.getElementById('clipx-btn-dl-video');
            const originalText = btn.innerText;
            try {
                btn.innerText = 'Downloading...';
                window.open(payload.videoUrl, '_blank');
                btn.innerText = 'Opened!';
            } catch (e) {
                console.error(e);
                btn.innerText = 'Error';
            }
            setTimeout(() => btn.innerText = originalText, 2000);
        };
    }

    // DIRECT VIDEO DOWNLOAD (for protected blob videos - uses background extraction)
    if (payload.hasVideo && payload.tweetUrl && !payload.videoUrl) {
        const dlBtn = document.getElementById('clipx-btn-dl-video-ext');
        if (dlBtn) {
            dlBtn.onclick = async () => {
                const original = dlBtn.innerText;
                dlBtn.innerText = 'Extracting...';
                dlBtn.disabled = true;

                try {
                    const response = await new Promise((resolve) => {
                        chrome.runtime.sendMessage(
                            { action: 'extractTwitterVideo', tweetUrl: payload.tweetUrl },
                            resolve
                        );
                    });

                    if (response && response.success && response.videoUrl) {
                        dlBtn.innerText = 'Downloading...';
                        const a = document.createElement('a');
                        a.href = response.videoUrl;
                        a.download = 'twitter_video.mp4';
                        a.target = '_blank';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        dlBtn.innerText = '✅ Download Started!';
                    } else {
                        // Fallback: Open download service in new tab
                        dlBtn.innerText = '🔗 Opening...';
                        const downloadUrl = response?.downloadServiceUrl ||
                            `https://twittervideodownloader.com/download?url=${encodeURIComponent(payload.tweetUrl)}`;
                        window.open(downloadUrl, '_blank');
                        dlBtn.innerText = '📎 Use Service';
                    }
                } catch (err) {
                    console.error('Video download error:', err);
                    // Fallback to download service
                    window.open(`https://twittervideodownloader.com/download?url=${encodeURIComponent(payload.tweetUrl)}`, '_blank');
                    dlBtn.innerText = '📎 Use Service';
                }

                dlBtn.disabled = false;
                setTimeout(() => dlBtn.innerText = original, 4000);
            };
        }

        // UPLOAD VIDEO BUTTON (for protected blob videos)
        const uploadBtn = document.getElementById('clipx-btn-upload-video-ext');
        if (uploadBtn) {
            uploadBtn.onclick = async () => {
                const original = uploadBtn.innerText;

                const result = await uploadVideoToBinance(
                    payload.videoUrl,
                    payload.tweetUrl,
                    payload.hasVideo,
                    (status) => { uploadBtn.innerText = status; }
                );

                if (result.success) {
                    uploadBtn.innerText = '✅ Uploaded!';

                    // Step 2: Fill text in the video modal's text field
                    await new Promise(r => setTimeout(r, 1500));
                    uploadBtn.innerText = 'Filling text...';

                    const textFilled = await fillVideoModalText(payload.text || '');

                    uploadBtn.innerText = textFilled ? '✅ Ready to Post!' : '✅ Paste text & Post';
                } else {
                    uploadBtn.innerText = '❌ ' + (result.error || 'Failed');
                }
                setTimeout(() => uploadBtn.innerText = original, 4000);
            };
        }
    }

    // UPLOAD VIDEO BUTTON (for direct video URL)
    if (payload.videoUrl) {
        const uploadBtn = document.getElementById('clipx-btn-upload-video');
        if (uploadBtn) {
            uploadBtn.onclick = async () => {
                const original = uploadBtn.innerText;

                const result = await uploadVideoToBinance(
                    payload.videoUrl,
                    payload.tweetUrl,
                    true, // hasVideo = true since we have videoUrl
                    (status) => { uploadBtn.innerText = status; }
                );

                if (result.success) {
                    uploadBtn.innerText = '✅ Uploaded!';

                    // Fill text in the video modal's text field
                    await new Promise(r => setTimeout(r, 1500));
                    uploadBtn.innerText = 'Filling text...';

                    const textFilled = await fillVideoModalText(payload.text || '');

                    uploadBtn.innerText = textFilled ? '✅ Ready to Post!' : '✅ Paste text & Post';
                } else {
                    uploadBtn.innerText = '❌ ' + (result.error || 'Failed');
                }
                setTimeout(() => uploadBtn.innerText = original, 4000);
            };
        }
    }

    // COPY TWEET LINK
    if (payload.tweetUrl) {
        document.getElementById('clipx-btn-copy-link').onclick = () => {
            navigator.clipboard.writeText(payload.tweetUrl).then(() => {
                const btn = document.getElementById('clipx-btn-copy-link');
                const original = btn.innerText;
                btn.innerText = 'Copied!';
                setTimeout(() => btn.innerText = original, 2000);
            });
        };
    }

    document.getElementById('clipx-btn-autofill').onclick = async () => {
        const btn = document.getElementById('clipx-btn-autofill');
        const originalText = btn.innerText;

        // Step 1: Fill text
        btn.innerText = 'Filling text...';
        await attemptAutoFill(payload);

        // Step 2: Upload images using file input (NOT clipboard)
        if (imageUrls.length > 0) {
            const uploaded = await uploadImagesToBinance(imageUrls, (status) => {
                btn.innerText = status;
            });
            if (!uploaded) {
                btn.innerText = '⚠️ Image upload failed';
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // Step 3: Upload video if present (and no images - Binance may not support both)
        const hasVideo = payload.hasVideo && !imageUrls.length;
        if (hasVideo) {
            const videoResult = await uploadVideoToBinance(
                payload.videoUrl,
                payload.tweetUrl,
                payload.hasVideo,
                (status) => { btn.innerText = status; }
            );
            if (!videoResult.success && !videoResult.skipped) {
                btn.innerText = '⚠️ Video upload failed';
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // Step 4: Click the Post button (with retries for media)
        // Skip auto-post for videos - requires manual intervention
        if (hasVideo) {
            btn.innerText = '📹 Upload video manually';
            setTimeout(() => btn.innerText = originalText, 3000);
            return;
        }

        btn.innerText = 'Waiting for upload...';
        const hasMedia = imageUrls.length > 0;
        const posted = await waitAndClickPostButton(MAX_POST_RETRIES, hasMedia ? 2000 : 1000);

        if (posted) {
            btn.innerText = '✅ Posted!';
        } else {
            btn.innerText = '⚠️ Click Post manually';
        }
        setTimeout(() => btn.innerText = originalText, 3000);
    };

    // Initial auto-fill and post attempt (after Create Post button click has time to open editor)
    setTimeout(async () => {
        // Guard against multiple auto-post attempts
        if (autoPostAttempted) {
            console.log('[ClipX] Auto-post already attempted, skipping...');
            return;
        }
        autoPostAttempted = true;

        // Check if auto-post is enabled
        const settings = await new Promise(r => chrome.storage.local.get(['autoPostEnabled'], r));
        const autoPostEnabled = settings.autoPostEnabled !== false; // Default to true

        console.log('[ClipX] Auto-post enabled:', autoPostEnabled);

        // Wait a bit more for editor to be ready
        await new Promise(r => setTimeout(r, 500));

        // Step 1: ALWAYS fill text
        console.log('[ClipX] Filling text...');
        await attemptAutoFill(payload);

        // Check if this is a video tweet - skip image/video upload, show message
        const hasVideo = payload.hasVideo && !imageUrls.length;
        if (hasVideo) {
            console.log('[ClipX] Video tweet detected - skipping auto-post. Please upload video manually.');
            return;
        }

        // Step 2: ALWAYS upload images if present
        const hasImages = imageUrls.length > 0;
        if (hasImages) {
            console.log('[ClipX] Uploading images...');
            await uploadImagesToBinance(imageUrls, null);
        }

        // Step 3: Only click Post if auto-post is enabled
        if (!autoPostEnabled) {
            console.log('[ClipX] Auto-post is OFF - text and images filled, skipping Post click');
            return;
        }

        // Click Post with limited retries (MAX_POST_RETRIES = 3)
        console.log(`[ClipX] Attempting to click Post button (max ${MAX_POST_RETRIES} retries)...`);
        await waitAndClickPostButton(MAX_POST_RETRIES, hasImages ? 2000 : 1000);
    }, 3000);
});


// Find an editor element
function findEditor() {
    const selectors = [
        '[contenteditable="true"]',
        'textarea[placeholder*="thoughts"]',
        '.DraftEditor-root [contenteditable="true"]',
        '.public-DraftEditor-content'
    ];
    for (let sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
    }
    // Fallback: any contenteditable
    return document.querySelector('[contenteditable="true"]');
}


async function attemptAutoFill(payload) {
    console.log('[ClipX] Attempting Auto-Fill...');

    const editor = findEditor();

    if (editor) {
        console.log('[ClipX] Editor found:', editor);
        editor.focus();
        editor.click();

        const text = payload.text;

        if (editor.tagName === 'TEXTAREA') {
            editor.value = text;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            const lines = text.split('\n');
            editor.innerHTML = '';
            lines.forEach((line, index) => {
                const escapedLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                if (index === 0) {
                    editor.innerHTML = escapedLine;
                } else {
                    editor.innerHTML += '<br>' + escapedLine;
                }
            });
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));

            try {
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(editor);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (e) { }
        }

        console.log('[ClipX] Text inserted with formatting preserved');
    } else {
        console.warn('[ClipX] No editor found.');
    }
}


// Add ClipX watermark to an image blob
async function addWatermark(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const fontSize = Math.max(12, Math.min(img.width, img.height) * 0.025);
            ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

            const watermarkText = 'ClipX';
            const metrics = ctx.measureText(watermarkText);
            const textWidth = metrics.width;
            const textHeight = fontSize;

            const padding = fontSize * 0.5;
            const x = img.width - textWidth - padding * 2;
            const y = img.height - padding * 1.5;

            const bgPadding = fontSize * 0.3;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.beginPath();
            ctx.roundRect(
                x - bgPadding,
                y - textHeight + bgPadding / 2,
                textWidth + bgPadding * 2,
                textHeight + bgPadding,
                fontSize * 0.2
            );
            ctx.fill();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.fillText(watermarkText, x, y);

            canvas.toBlob((watermarkedBlob) => {
                resolve(watermarkedBlob);
            }, blob.type || 'image/jpeg', 0.95);
        };

        img.onerror = () => {
            console.warn('[ClipX] Watermark failed, using original image');
            resolve(blob);
        };

        img.src = URL.createObjectURL(blob);
    });
}

async function fetchImageBlob(url, withWatermark = true) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Fetch failed');
    let blob = await response.blob();

    if (withWatermark) {
        try {
            blob = await addWatermark(blob);
        } catch (e) {
            console.warn('[ClipX] Watermark error:', e);
        }
    }

    return blob;
}

// ============================================================
// SHARE TO X (TWITTER) FUNCTIONALITY
// ============================================================

// Add "Share to X" buttons to Binance Square posts
function addShareToXButtons() {
    // Find all posts on Binance Square
    const posts = document.querySelectorAll('article, [data-testid="post"], [class*="post-card"], [class*="PostCard"], [class*="feed-item"], [class*="FeedItem"]');

    posts.forEach(post => {
        // Skip if already processed
        if (post.dataset.clipxShareX === 'true') return;

        // Find action bar (where like/comment/share buttons are)
        const actionBar = post.querySelector('[class*="action"], [class*="toolbar"], [class*="footer"]');
        if (!actionBar) return;

        // Create Share to X button
        const shareBtn = document.createElement('button');
        shareBtn.innerHTML = `
            <div style="width:22px; height:22px; border-radius:50%; background:#000; display:flex; align-items:center; justify-content:center; cursor:pointer;" title="Share to X">
                <span style="font-size:12px; font-weight:bold; color:#fff;">𝕏</span>
            </div>
        `;
        shareBtn.style.cssText = 'background:none; border:none; padding:4px; cursor:pointer; display:inline-flex; align-items:center;';

        // Hover effect
        shareBtn.onmouseenter = () => shareBtn.style.opacity = '0.7';
        shareBtn.onmouseleave = () => shareBtn.style.opacity = '1';

        // Click handler - extract content and share to X
        shareBtn.onclick = async (e) => {
            e.stopPropagation();
            e.preventDefault();

            console.log('[ClipX] Share to X clicked');

            // Extract text content from the post
            let text = '';
            const textElements = post.querySelectorAll('p, [class*="content"], [class*="text"], [class*="body"]');
            textElements.forEach(el => {
                // Skip if it's a username, timestamp, etc.
                if (!el.closest('[class*="author"]') && !el.closest('[class*="time"]') && !el.closest('[class*="meta"]')) {
                    text += el.textContent.trim() + '\n';
                }
            });
            text = text.trim();

            // If no text found, try getting innerText of the post
            if (!text) {
                const contentDiv = post.querySelector('[class*="content"], [class*="body"]');
                if (contentDiv) {
                    text = contentDiv.innerText.trim();
                }
            }

            // Extract images from the post
            const images = post.querySelectorAll('img:not([class*="avatar"]):not([class*="profile"])');
            const imageUrls = [];
            images.forEach(img => {
                if (img.src && !img.src.includes('avatar') && !img.src.includes('profile') && img.width > 50) {
                    imageUrls.push(img.src);
                }
            });

            // Get post URL if available
            const postLink = post.querySelector('a[href*="/post/"]');
            const postUrl = postLink ? postLink.href : '';

            console.log('[ClipX] Extracted from Binance Square:', { text: text.substring(0, 100), imageCount: imageUrls.length, postUrl });

            // Prepare tweet text (add source attribution)
            let tweetText = text;
            if (postUrl) {
                tweetText += '\n\n📱 via Binance Square';
            }

            // Open X/Twitter with pre-filled text
            // X supports the "intent/tweet" URL for pre-filling content
            const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

            // Save image URLs to storage for potential upload on X (images can't be pre-filled via URL)
            if (imageUrls.length > 0) {
                chrome.storage.local.set({
                    xPostPayload: {
                        text: tweetText,
                        imageUrls,
                        source: 'binance_square',
                        timestamp: Date.now()
                    }
                });
            }

            // Open Twitter intent
            window.open(tweetUrl, '_blank');

            // Visual feedback
            const originalHtml = shareBtn.innerHTML;
            shareBtn.innerHTML = `
                <div style="width:22px; height:22px; border-radius:50%; background:#22c55e; display:flex; align-items:center; justify-content:center;">
                    <span style="font-size:10px; font-weight:bold; color:#fff;">✓</span>
                </div>
            `;
            setTimeout(() => { shareBtn.innerHTML = originalHtml; }, 2000);
        };

        // Append button to action bar
        actionBar.appendChild(shareBtn);
        post.dataset.clipxShareX = 'true';
    });
}

// Run the button injection
function initShareToX() {
    console.log('[ClipX] Initializing Share to X feature...');

    // Initial injection
    setTimeout(addShareToXButtons, 2000);

    // Re-run on DOM changes (infinite scroll, etc.)
    const observer = new MutationObserver(() => {
        addShareToXButtons();
    });

    observer.observe(document.body, { childList: true, subtree: true });
}

// Start Share to X feature
initShareToX();
