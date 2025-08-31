// extension/service_worker.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'generate_suggestions') {
    fetch('http://localhost:8000/api/generate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({context: msg.context})
    }).then(r => r.json()).then(data => sendResponse(data)).catch(err => sendResponse({error: err.message}));
    return true; // keep channel open
  }
});
