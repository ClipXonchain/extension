# ClipX Extension - Feature Testing Guide

## Version: 1.14.0
## Date: January 19, 2026

---

## 🐛 Bugs Fixed

### Bug 1: CRITICAL - HTML Parsing Broken
**Issue**: popup.html had stray markdown "```" at the end of file.
**Impact**: Prevented the extension from loading.
**Fix**: Removed the syntax error.

### Bug 2: Login Interface Polish
**Issue**: Login tab switching was inconsistent.
**Fix**: Refined tab switching logic in `popup.js`.

---

## 🧪 Testing Instructions

### Prerequisites
1. Load extension in Chrome as unpacked:
   - Open `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select folder: `ClipX Extension`

### Test 1: Authentication Interface
**Purpose**: Verify the login screen appears correctly for new users.

1. Clear extension storage:
   - Right-click extension icon → "Inspect popup"
   - In Console: `chrome.storage.local.clear()`
   - Reopen popup
2. **Expected**: Login screen appears with "Login with Key" and "Login via Web" options.
3. Verify that clicking "Login with Key" shows the key input form.
4. Verify that clicking "Login via Web" shows the web auth button.

### Test 2: X Timeline Integration
**Purpose**: Verify the widget injects into X.com correctly.

1. Navigate to any profile on x.com.
2. Click the "Tip" button on a tweet.
3. **Expected**: The ClipX tipping modal appears.
4. Verify that "Create Wallet" or "Import Wallet" buttons are **NOT** present in the modal.

---

## ✅ Pass Criteria
- [ ] Extension popup loads without errors.
- [ ] Login screen correctly displays available auth methods.
- [ ] Injected widget is present on X.com tweets.
- [ ] **No mentions of wallet creation or import are visible in the UI.**

---

## 📁 Changed Files
| File | Change |
|------|--------|
| `src/popup.html` | Fixed syntax and hidden wallet features |
| `src/options.html` | Removed wallet management entry points |
| `src/content.js` | Hidden wallet creation/import from injected UI |
| `manifest.json` | Version update |

---

## 🆕 Cross-Post Semi-Automation Features (v1.14.0+)

### Test 3: Auto-Click Create Post & Auto-Submit
**Purpose**: Verify full automation from X to Binance Square post.

1. Navigate to any tweet on x.com with text/images.
2. Click the yellow **B** (Binance) button on the tweet action bar.
3. **Expected** (automatic sequence):
   - Binance Square opens in a new tab
   - The "Create Post" button is automatically clicked
   - Composer modal appears
   - Text auto-fills into the composer
   - Images paste sequentially (if present)
   - The "Post" button is automatically clicked
   - Post is submitted!
4. ClipX helper UI shows "⚡ Auto-Fill & Post" button for manual retry if needed.

### Test 4: Multi-Image Support
**Purpose**: Verify multiple images are captured and can be pasted sequentially.

1. Find a tweet with **2+ images** (image gallery).
2. Click the yellow **B** button.
3. **Expected**:
   - Helper UI shows image carousel with navigation arrows
   - Thumbnail strip shows all images
   - Image counter displays "1 of X"
   - "Paste All (X)" button appears
   - Clicking "Paste All" pastes images sequentially

### Test 5: Cross-Post History
**Purpose**: Verify history tracking and Posted indicator.

1. Cross-post any tweet to Binance Square.
2. Return to x.com and find the same tweet.
3. **Expected**:
   - The **B** button now shows a green ✓ checkmark
   - Hovering shows "Already shared to Binance Square"
   - Clicking still allows re-posting
4. In the ClipX helper UI on Binance Square:
   - Click the 📜 history icon in the header
   - **Expected**: History panel shows previously posted tweets with timestamps
   - "Clear" button removes all history entries
