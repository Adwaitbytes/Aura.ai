// content_script.js
// CRANQ-Plus — with collapsible, resizable, and draggable AI suggestions box
// - injects "Generate with AI" only inside reply dialog
// - suggestions box is collapsible, resizable, and draggable
// - avoids overlapping Twitter's native reply UI

(() => {
  const BACKEND_GENERATE = 'http://127.0.0.1:8000/api/generate';
  const BTN_CLS = 'cranq-generate-btn-final';
  const SUG_BOX_CLS = 'cranq-suggestions-box-final';

  console.debug('[CRANQ+] content script loaded');

  function debounce(fn, ms = 150) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function findReplyDialogs() {
    return Array.from(document.querySelectorAll('div[role="dialog"]')).filter(d =>
      !!d.querySelector('div[role="textbox"], div[contenteditable="true"]')
    );
  }

  function extractContext(dialog) {
    let article = dialog.querySelector('article[role="article"]');
    if (!article) {
      const all = Array.from(document.querySelectorAll('article[role="article"]'));
      article = all.find(a => {
        const r = a.getBoundingClientRect();
        return r.top >= 0 && r.top < window.innerHeight * 0.6;
      }) || all[0];
    }
    const textEl = article ? article.querySelector('div[lang]') : null;
    const authorEl = article ? article.querySelector('a[role="link"] span') : null;
    const images = article ? Array.from(article.querySelectorAll('img')).map(i => i.src).slice(0, 5) : [];
    return {
      text: textEl ? textEl.innerText.trim() : '',
      author: authorEl ? authorEl.innerText.trim() : '',
      images
    };
  }

  function findReplyControlsContainer(dialog) {
    const selectors = [
      'div[data-testid="tweetButton"]',
      'div[data-testid="tweetButtonInline"]',
      'div[role="group"]',
      'div[aria-label="Reply"]',
      'div[role="toolbar"]'
    ];
    for (const sel of selectors) {
      const el = dialog.querySelector(sel);
      if (el) return el.parentElement || el;
    }
    const btns = Array.from(dialog.querySelectorAll('button'));
    for (const b of btns) {
      const t = (b.innerText || '').trim().toLowerCase();
      if (t === 'reply' || t === 'replying' || t === 'tweet' || t === 'send') {
        return b.parentElement || b;
      }
    }
    const textbox = dialog.querySelector('div[role="textbox"], div[contenteditable="true"]');
    return textbox ? (textbox.parentElement || dialog) : dialog;
  }

  function ensureGenerateBtn(dialog) {
    if (dialog.querySelector(`.${BTN_CLS}`)) return;
    const controls = findReplyControlsContainer(dialog);
    if (!controls) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLS;
    btn.textContent = 'Generate with AI';
    Object.assign(btn.style, {
      marginLeft: '8px',
      padding: '8px 14px',
      background: '#1d9bf0',
      color: '#fff',
      border: 'none',
      borderRadius: '18px',
      cursor: 'pointer',
      fontWeight: 600,
      fontSize: '13px'
    });

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await onGenerateClick(dialog, btn);
    });

    try { controls.appendChild(btn); }
    catch (err) { controls.parentElement && controls.parentElement.appendChild(btn); }
  }

  function makeDraggable(element, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return; // Don't drag when clicking buttons
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(element.style.left) || 0;
      startTop = parseInt(element.style.top) || 0;
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth - element.offsetWidth, startLeft + deltaX));
      const newTop = Math.max(0, Math.min(window.innerHeight - element.offsetHeight, startTop + deltaY));
      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
      element.style.right = 'auto'; // Remove right positioning when dragging
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        handle.style.cursor = 'grab';
      }
    });
  }

  function makeResizable(element) {
    const resizeHandle = document.createElement('div');
    Object.assign(resizeHandle.style, {
      position: 'absolute',
      bottom: '0',
      right: '0',
      width: '20px',
      height: '20px',
      background: 'rgba(255,255,255,0.1)',
      cursor: 'nw-resize',
      borderRadius: '0 0 12px 0',
      zIndex: '10'
    });

    // Add resize indicator
    resizeHandle.innerHTML = '<div style="position:absolute;bottom:2px;right:2px;width:0;height:0;border:5px solid transparent;border-bottom-color:#666;border-right-color:#666;"></div>';

    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = parseInt(getComputedStyle(element).width);
      startHeight = parseInt(getComputedStyle(element).height);
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(280, Math.min(600, startWidth + (e.clientX - startX)));
      const newHeight = Math.max(100, Math.min(500, startHeight + (e.clientY - startY)));
      element.style.width = `${newWidth}px`;
      element.style.height = `${newHeight}px`;
    });

    document.addEventListener('mouseup', () => {
      isResizing = false;
    });

    element.appendChild(resizeHandle);
  }

  function renderSuggestions(dialog, suggestions) {
    const old = dialog.querySelector(`.${SUG_BOX_CLS}`);
    if (old) old.remove();

    // Remove any existing suggestion boxes
    document.querySelectorAll(`.${SUG_BOX_CLS}`).forEach(box => box.remove());

    const dialogRect = dialog.getBoundingClientRect();
    
    const box = document.createElement('div');
    box.className = SUG_BOX_CLS;
    Object.assign(box.style, {
      position: 'fixed',
      top: `${Math.max(50, Math.min(dialogRect.bottom - 200, window.innerHeight - 250))}px`,
      right: '20px',
      width: '350px',
      height: '200px',
      minWidth: '280px',
      minHeight: '100px',
      padding: '0',
      background: '#0f1419',
      borderRadius: '12px',
      border: '1px solid rgba(255,255,255,0.2)',
      boxSizing: 'border-box',
      zIndex: 999999,
      boxShadow: '0 8px 25px rgba(0,0,0,0.6)',
      opacity: '0.98',
      overflow: 'hidden',
      resize: 'none'
    });

    // Header with drag handle
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px',
      background: 'rgba(255,255,255,0.05)',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      cursor: 'grab',
      userSelect: 'none'
    });

    const titleContainer = document.createElement('div');
    Object.assign(titleContainer.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flex: '1'
    });

    const title = document.createElement('span');
    title.textContent = 'AI Reply Suggestions';
    Object.assign(title.style, {
      color: '#e6eef3',
      fontSize: '14px',
      fontWeight: '600'
    });

    const toggle = document.createElement('button');
    toggle.textContent = '▼';
    Object.assign(toggle.style, {
      background: 'rgba(29, 155, 240, 0.1)',
      border: '1px solid rgba(29, 155, 240, 0.3)',
      color: '#1d9bf0',
      cursor: 'pointer',
      fontSize: '12px',
      fontWeight: '600',
      padding: '4px 8px',
      borderRadius: '6px',
      transition: 'all 0.2s ease'
    });

    // Button container for proper spacing
    const buttonContainer = document.createElement('div');
    Object.assign(buttonContainer.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      background: 'rgba(255,255,255,0.1)',
      border: 'none',
      color: '#9aa4ad',
      cursor: 'pointer',
      fontSize: '16px',
      fontWeight: '600',
      padding: '4px 8px',
      borderRadius: '6px',
      lineHeight: '1',
      transition: 'all 0.2s ease'
    });

    titleContainer.appendChild(title);
    buttonContainer.appendChild(toggle);
    buttonContainer.appendChild(closeBtn);
    header.appendChild(titleContainer);
    header.appendChild(buttonContainer);

    // Content container
    const content = document.createElement('div');
    Object.assign(content.style, {
      padding: '12px',
      height: 'calc(100% - 49px)', // Subtract header height
      overflowY: 'auto',
      transition: 'opacity 0.3s ease'
    });

    let expanded = true;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      expanded = !expanded;
      if (expanded) {
        content.style.display = 'block';
        content.style.opacity = '1';
        toggle.textContent = '▼';
        box.style.height = box.dataset.expandedHeight || '200px';
      } else {
        content.style.opacity = '0';
        setTimeout(() => content.style.display = 'none', 300);
        toggle.textContent = '▶';
        box.dataset.expandedHeight = box.style.height;
        box.style.height = '49px'; // Just header height
      }
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      box.remove();
    });

    // Hover effects for buttons
    toggle.addEventListener('mouseover', () => {
      toggle.style.background = 'rgba(29, 155, 240, 0.2)';
    });
    toggle.addEventListener('mouseout', () => {
      toggle.style.background = 'rgba(29, 155, 240, 0.1)';
    });

    closeBtn.addEventListener('mouseover', () => {
      closeBtn.style.background = 'rgba(255,255,255,0.2)';
      closeBtn.style.color = '#fff';
    });
    closeBtn.addEventListener('mouseout', () => {
      closeBtn.style.background = 'rgba(255,255,255,0.1)';
      closeBtn.style.color = '#9aa4ad';
    });

    box.appendChild(header);
    box.appendChild(content);

    suggestions.forEach((s, idx) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: idx === suggestions.length - 1 ? '0' : '12px',
        padding: '12px',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.1)',
        transition: 'all 0.2s ease'
      });

      row.addEventListener('mouseover', () => {
        row.style.background = 'rgba(255,255,255,0.08)';
        row.style.borderColor = 'rgba(255,255,255,0.2)';
      });
      row.addEventListener('mouseout', () => {
        row.style.background = 'rgba(255,255,255,0.05)';
        row.style.borderColor = 'rgba(255,255,255,0.1)';
      });

      const txt = document.createElement('div');
      txt.innerText = s.text || (typeof s === 'string' ? s : '');
      Object.assign(txt.style, {
        color: '#e6eef3',
        fontSize: '13px',
        lineHeight: '1.4',
        flex: '1',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: '80px',
        overflowY: 'auto',
        marginRight: '8px'
      });

      const actionsCol = document.createElement('div');
      Object.assign(actionsCol.style, { 
        display: 'flex', 
        flexDirection: 'column',
        gap: '6px', 
        alignItems: 'stretch',
        flexShrink: '0',
        minWidth: '60px'
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      Object.assign(copyBtn.style, {
        background: 'transparent',
        color: '#9aa4ad',
        border: '1px solid rgba(255,255,255,0.2)',
        padding: '6px 10px',
        borderRadius: '16px',
        cursor: 'pointer',
        fontSize: '11px',
        fontWeight: '500',
        transition: 'all 0.2s ease',
        textAlign: 'center'
      });
      
      copyBtn.addEventListener('mouseover', () => {
        copyBtn.style.background = 'rgba(255,255,255,0.1)';
        copyBtn.style.borderColor = 'rgba(255,255,255,0.3)';
      });
      copyBtn.addEventListener('mouseout', () => {
        copyBtn.style.background = 'transparent';
        copyBtn.style.borderColor = 'rgba(255,255,255,0.2)';
      });
      
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { 
          await navigator.clipboard.writeText(txt.innerText); 
          copyBtn.innerText = 'Copied!'; 
          setTimeout(() => copyBtn.innerText = 'Copy', 1500); 
        }
        catch { 
          fallbackCopyToClipboard(txt.innerText);
          copyBtn.innerText = 'Copied!'; 
          setTimeout(() => copyBtn.innerText = 'Copy', 1500);
        }
      });

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.textContent = 'Use';
      Object.assign(useBtn.style, {
        background: '#1d9bf0',
        color: '#fff',
        border: 'none',
        padding: '6px 14px',
        borderRadius: '16px',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: '600',
        transition: 'all 0.2s ease',
        textAlign: 'center'
      });
      
      useBtn.addEventListener('mouseover', () => {
        useBtn.style.background = '#1a8cd8';
        useBtn.style.transform = 'translateY(-1px)';
      });
      useBtn.addEventListener('mouseout', () => {
        useBtn.style.background = '#1d9bf0';
        useBtn.style.transform = 'translateY(0)';
      });
      
      useBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        insertIntoReplyBox(dialog, txt.innerText);
      });

      actionsCol.appendChild(copyBtn);
      actionsCol.appendChild(useBtn);
      row.appendChild(txt);
      row.appendChild(actionsCol);
      content.appendChild(row);
    });

    // Make draggable and resizable
    makeDraggable(box, header);
    makeResizable(box);

    // Append to document body to avoid overlap issues
    document.body.appendChild(box);

    // Auto-remove when dialog closes
    const observer = new MutationObserver(() => {
      if (!document.contains(dialog)) {
        box.remove();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Remove on escape key
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        box.remove();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Add subtle entrance animation
    box.style.opacity = '0';
    box.style.transform = 'translateY(20px)';
    setTimeout(() => {
      box.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      box.style.opacity = '0.98';
      box.style.transform = 'translateY(0)';
    }, 10);
  }

  function makeResizable(element) {
    const resizeHandle = document.createElement('div');
    Object.assign(resizeHandle.style, {
      position: 'absolute',
      bottom: '0',
      right: '0',
      width: '20px',
      height: '20px',
      cursor: 'nw-resize',
      zIndex: '10',
      background: 'transparent'
    });

    // Visual resize indicator
    const indicator = document.createElement('div');
    Object.assign(indicator.style, {
      position: 'absolute',
      bottom: '4px',
      right: '4px',
      width: '12px',
      height: '12px',
      backgroundImage: `
        linear-gradient(45deg, transparent 40%, rgba(255,255,255,0.3) 40%, rgba(255,255,255,0.3) 60%, transparent 60%),
        linear-gradient(45deg, transparent 25%, rgba(255,255,255,0.2) 25%, rgba(255,255,255,0.2) 45%, transparent 45%),
        linear-gradient(45deg, transparent 10%, rgba(255,255,255,0.1) 10%, rgba(255,255,255,0.1) 30%, transparent 30%)
      `,
      backgroundSize: '4px 4px',
      borderRadius: '0 0 12px 0'
    });

    resizeHandle.appendChild(indicator);

    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = parseInt(getComputedStyle(element).width);
      startHeight = parseInt(getComputedStyle(element).height);
      e.preventDefault();
      e.stopPropagation();
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = Math.max(280, Math.min(600, startWidth + (e.clientX - startX)));
      const newHeight = Math.max(100, Math.min(500, startHeight + (e.clientY - startY)));
      element.style.width = `${newWidth}px`;
      element.style.height = `${newHeight}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.userSelect = '';
      }
    });

    element.appendChild(resizeHandle);
  }

  function insertIntoReplyBox(dialog, text) {
    const textbox = dialog.querySelector('div[role="textbox"], div[contenteditable="true"]');
    if (!textbox) {
      fallbackCopyToClipboard(text);
      alert('Reply copied to clipboard. Paste into the reply box.');
      return;
    }
    
    try {
      // Focus the textbox first
      textbox.focus();
      textbox.click();
      
      // Clear any existing content
      textbox.innerHTML = '';
      textbox.innerText = '';
      
      // Wait a bit for focus to properly register
      setTimeout(() => {
        // Method 1: Try clipboard approach (most reliable for React)
        navigator.clipboard.writeText(text).then(() => {
          textbox.focus();
          textbox.click();
          
          // Simulate Ctrl+V paste
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: new DataTransfer()
          });
          pasteEvent.clipboardData.setData('text/plain', text);
          
          // Try paste event first
          if (textbox.dispatchEvent(pasteEvent)) {
            // If paste event worked, we're done
            placeCaretAtEnd(textbox);
            triggerReactEvents(textbox);
            return;
          }
          
          // Fallback: Direct insertion with React event simulation
          insertTextDirectly(textbox, text);
        }).catch(() => {
          // If clipboard fails, use direct insertion
          insertTextDirectly(textbox, text);
        });
      }, 50);
      
    } catch (err) {
      console.error('[CRANQ+] insert error:', err);
      insertTextDirectly(textbox, text);
    }
    
    // Remove the suggestions box after use
    setTimeout(() => {
      const sugBox = document.querySelector(`.${SUG_BOX_CLS}`);
      if (sugBox) {
        sugBox.style.opacity = '0';
        sugBox.style.transform = 'translateY(20px)';
        setTimeout(() => sugBox.remove(), 300);
      }
    }, 100);
  }

  function insertTextDirectly(textbox, text) {
    try {
      // Focus and select all first
      textbox.focus();
      textbox.click();
      
      // Clear content
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      
      // Insert new text
      const inserted = document.execCommand('insertText', false, text);
      
      if (!inserted) {
        // Fallback method
        textbox.innerText = text;
      }
      
      // Trigger comprehensive React events
      triggerReactEvents(textbox);
      placeCaretAtEnd(textbox);
      
      // Additional focus to ensure React state updates
      setTimeout(() => {
        textbox.focus();
        textbox.click();
        triggerReactEvents(textbox);
      }, 100);
      
    } catch (e) {
      console.error('[CRANQ+] direct insert error:', e);
      // Last resort
      textbox.innerText = text;
      triggerReactEvents(textbox);
    }
  }

  function triggerReactEvents(el) {
    try {
      // Comprehensive event triggering for React
      const events = [
        new Event('focus', { bubbles: true }),
        new Event('click', { bubbles: true }),
        new Event('input', { bubbles: true }),
        new Event('change', { bubbles: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 'a' }),
        new KeyboardEvent('keyup', { bubbles: true, key: 'a' }),
        new KeyboardEvent('keypress', { bubbles: true, key: 'a' }),
        new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: el.innerText }),
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: el.innerText })
      ];
      
      events.forEach(event => {
        try {
          el.dispatchEvent(event);
        } catch (e) {}
      });
      
      // Trigger React fiber updates
      const reactFiber = el._reactInternalFiber || el._reactInternalInstance;
      if (reactFiber) {
        try {
          const props = reactFiber.memoizedProps || reactFiber.pendingProps;
          if (props && props.onChange) {
            props.onChange({ target: { value: el.innerText } });
          }
        } catch (e) {}
      }
      
      // Force a render update
      el.blur();
      setTimeout(() => {
        el.focus();
        el.click();
      }, 10);
      
    } catch (e) {
      console.error('[CRANQ+] event dispatch error:', e);
    }
  }

  function placeCaretAtEnd(el) {
    try {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  function dispatchInputEvents(el) {
    // This function is now handled by triggerReactEvents
    triggerReactEvents(el);
  }

  function setTextContentReactively(el, text) {
    try {
      el.focus();
      el.innerText = '';
      const lines = text.split('\n');
      lines.forEach((ln, idx) => {
        el.appendChild(document.createTextNode(ln));
        if (idx < lines.length - 1) el.appendChild(document.createElement('br'));
      });
      dispatchInputEvents(el);
      placeCaretAtEnd(el);
    } catch (e) {
      try { el.innerText = text; dispatchInputEvents(el); } catch (e2) {}
    }
  }

  function fallbackCopyToClipboard(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  async function onGenerateClick(dialog, btn) {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Generating...';

    const ctx = extractContext(dialog);
    if (!ctx.text) {
      alert('Could not find tweet text to reply to.');
      btn.disabled = false;
      btn.textContent = original;
      return;
    }

    try {
      const res = await fetch(BACKEND_GENERATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { text: ctx.text, author: ctx.author, images: ctx.images } })
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error('[CRANQ+] backend error', res.status, txt);
        alert('AI generation failed (server). See console.');
        return;
      }

      const data = await res.json();
      const suggestions = (data.suggestions || data.replies || []).slice(0, 6);
      const normalized = suggestions.map(s => (typeof s === 'string' ? { text: s } : { text: s.text || s }));

      if (normalized.length === 0) {
        alert('No suggestions returned.');
      } else {
        renderSuggestions(dialog, normalized);
      }
    } catch (err) {
      console.error('[CRANQ+] network error', err);
      alert('AI generation failed (network). See console.');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  const run = debounce(() => {
    const dialogs = findReplyDialogs();
    dialogs.forEach(d => ensureGenerateBtn(d));
  }, 200);

  const mo = new MutationObserver(run);
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  run();
  
  // Cleanup on page unload
  window.addEventListener('unload', () => {
    mo.disconnect();
    // Remove any remaining suggestion boxes
    document.querySelectorAll(`.${SUG_BOX_CLS}`).forEach(box => box.remove());
  });
})();