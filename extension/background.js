const MAX_SNAPSHOTS_PER_DOMAIN = 50;
const MAX_ACTIVITY_PER_DOMAIN = 300;

// Serialise storage writes so quick successive messages can't overwrite each other.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.error("Dark Pattern Watch:", e));
  return queue;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "DP_SCAN_RESULT") {
    enqueue(() => append(`dp_history_${msg.payload.domain}`, msg.payload, MAX_SNAPSHOTS_PER_DOMAIN));
    return false;
  }
  if (msg.type === "DP_ACTIVITY_RESULT") {
    enqueue(() => append(`dp_activity_${msg.payload.domain}`, msg.payload, MAX_ACTIVITY_PER_DOMAIN));
    return false;
  }
  if (msg.type === "DP_GET_HISTORY") {
    read(`dp_history_${msg.domain}`).then(sendResponse);
    return true;
  }
  if (msg.type === "DP_GET_ACTIVITY") {
    read(`dp_activity_${msg.domain}`).then(sendResponse);
    return true;
  }
  if (msg.type === "DP_EXPORT_ALL") {
    // Everything stored for every site, for offline analysis.
    chrome.storage.local.get(null).then((all) => {
      const out = { exportedAt: Date.now(), history: [], activity: [] };
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith("dp_history_")) out.history.push(...v);
        else if (k.startsWith("dp_activity_")) out.activity.push(...v);
      }
      sendResponse(out);
    });
    return true;
  }
  if (msg.type === "DP_CLEAR_HISTORY") {
    chrome.storage.local
      .remove([`dp_history_${msg.domain}`, `dp_activity_${msg.domain}`])
      .then(() => sendResponse(true));
    return true;
  }
});

async function append(key, item, max) {
  const data = await chrome.storage.local.get(key);
  const list = data[key] || [];
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
  await chrome.storage.local.set({ [key]: list });
}

async function read(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] || [];
}
