// InstaFetch - Background Service Worker
// Handles media fetching to bypass CORS restrictions

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchMedia") {
    fetchMediaAsBase64(message.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.action === "fetchBatch") {
    fetchBatch(message.urls)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "downloadZip") {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: true,
    });
    sendResponse({ success: true });
    return false;
  }
});

async function fetchMediaAsBase64(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();
    const reader = new FileReader();

    return new Promise((resolve, reject) => {
      reader.onloadend = () => {
        resolve({
          data: reader.result,
          type: blob.type,
          size: blob.size,
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchBatch(urls) {
  const results = [];
  // Process in chunks of 5 to avoid overwhelming the network
  const chunkSize = 5;

  for (let i = 0; i < urls.length; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (item) => {
        const result = await fetchMediaAsBase64(item.url);
        return {
          ...result,
          filename: item.filename,
          index: item.index,
        };
      }),
    );

    for (const result of chunkResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({ error: result.reason?.message || "Unknown error" });
      }
    }
  }

  return results;
}
