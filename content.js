// InstaFetch - Content Script
// Detects Instagram profile pages, shows download panel

(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────
  const IG_APP_ID = "936619743392459";

  // ── Safety / Throttle Config ───────────────────────────────────────────
  const SAFETY = {
    DELAY_API_PAGE: 900, // Delay between API pagination requests (ms)
    DELAY_MEDIA_DOWNLOAD: 650, // Delay between individual media downloads (ms)
    DELAY_HIGHLIGHT_GROUP: 1200, // Delay between highlight groups
    JITTER: 0.4, // Random ±40% variation to look more human
    WARN_THRESHOLD: 50, // Show warning above this many total items
    SOFT_LIMIT: 200, // Soft limit — strong warning
  };

  function safeDelay(baseMs) {
    const jitter = baseMs * SAFETY.JITTER * (Math.random() * 2 - 1);
    return sleep(Math.max(200, Math.round(baseMs + jitter)));
  }
  const RESERVED_PATHS = [
    "explore",
    "reels",
    "stories",
    "direct",
    "accounts",
    "p",
    "reel",
    "tv",
    "about",
    "legal",
    "privacy",
    "terms",
    "developer",
    "api",
    "static",
    "emails",
    "session",
    "directory",
    "lite",
    "web",
    "nametag",
    "challenge",
    "data",
    "graphql",
    "ar",
    "topics",
    "tags",
  ];

  // ── State ──────────────────────────────────────────────────────────────
  let currentUsername = null;
  let profileData = null;
  let panelElement = null;
  let fabElement = null;
  let singlePostBtnElement = null;
  let isDownloading = false;
  let isSinglePostDownloading = false;

  // ── URL Observer ───────────────────────────────────────────────────────
  function init() {
    observeUrlChanges();
    checkCurrentPage();
  }

  function observeUrlChanges() {
    let lastUrl = location.href;

    // Override pushState and replaceState to detect SPA navigation
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      onUrlChange();
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      onUrlChange();
    };

    window.addEventListener("popstate", onUrlChange);

    // Fallback: MutationObserver for SPA changes
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onUrlChange();
      }
    }).observe(document.body, { childList: true, subtree: true });

    function onUrlChange() {
      lastUrl = location.href;
      setTimeout(checkCurrentPage, 300);
    }
  }

  function checkCurrentPage() {
    const postMatch = window.location.pathname.match(
      /^\/p\/([a-zA-Z0-9_-]+)(?:\/|$)/,
    );
    if (postMatch) {
      showSinglePostDownloadButton(postMatch[1]);
    } else {
      hideSinglePostDownloadButton();
    }

    const match = window.location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);

    if (match && !RESERVED_PATHS.includes(match[1].toLowerCase())) {
      const username = match[1];
      if (username !== currentUsername) {
        currentUsername = username;
        profileData = null;
        closePanel();
      }
      showFab();
    } else {
      currentUsername = null;
      profileData = null;
      hideFab();
      closePanel();
    }
  }

  // ── Instagram API ──────────────────────────────────────────────────────

  function getCSRFToken() {
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? match[1] : "";
  }

  async function fetchProfileInfo(username) {
    const headers = {
      "x-ig-app-id": IG_APP_ID,
      "x-requested-with": "XMLHttpRequest",
      "x-csrftoken": getCSRFToken(),
    };

    // Try API v1 endpoint first
    try {
      const resp = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        { headers, credentials: "include" },
      );
      if (resp.ok) {
        const json = await resp.json();
        return json.data?.user || json.user || null;
      }
    } catch (e) {
      console.warn("InstaFetch: API v1 failed, trying fallback", e);
    }

    // Fallback: try fetching the profile page and extracting data
    try {
      const resp = await fetch(
        `https://www.instagram.com/${username}/?__a=1&__d=dis`,
        {
          headers,
          credentials: "include",
        },
      );
      if (resp.ok) {
        const json = await resp.json();
        return json.graphql?.user || json.data?.user || null;
      }
    } catch (e) {
      console.warn("InstaFetch: Fallback also failed", e);
    }

    return null;
  }

  async function fetchPostByShortcode(shortcode) {
    const headers = {
      "x-ig-app-id": IG_APP_ID,
      "x-requested-with": "XMLHttpRequest",
      "x-csrftoken": getCSRFToken(),
    };

    // Primary: v1 endpoint by shortcode
    try {
      const resp = await fetch(
        `https://www.instagram.com/api/v1/media/shortcode/${shortcode}/info/`,
        { headers, credentials: "include" },
      );
      if (resp.ok) {
        const json = await resp.json();
        const item = json.items?.[0] || json.data?.items?.[0];
        if (item) return item;
      } else {
        console.warn("InstaFetch: shortcode endpoint status", resp.status);
      }
    } catch (e) {
      console.warn("InstaFetch: v1 post endpoint failed", e);
    }

    // Fallback: page data endpoint
    try {
      const resp = await fetch(
        `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
        {
          headers,
          credentials: "include",
        },
      );
      if (resp.ok) {
        const json = await resp.json();
        return (
          json.graphql?.shortcode_media || json.data?.shortcode_media || null
        );
      } else {
        console.warn("InstaFetch: fallback page endpoint status", resp.status);
      }
    } catch (e) {
      console.warn("InstaFetch: fallback post endpoint failed", e);
    }

    return null;
  }

  async function fetchUserPosts(userId, count = 50) {
    const posts = [];
    let maxId = null;
    let hasMore = true;

    while (hasMore && posts.length < count) {
      try {
        let url = `https://www.instagram.com/api/v1/feed/user/${userId}/?count=${Math.min(33, count - posts.length)}`;
        if (maxId) url += `&max_id=${maxId}`;

        const resp = await fetch(url, {
          headers: {
            "x-ig-app-id": IG_APP_ID,
            "x-requested-with": "XMLHttpRequest",
            "x-csrftoken": getCSRFToken(),
          },
          credentials: "include",
        });

        if (!resp.ok) {
          console.warn("InstaFetch: Posts API returned", resp.status);
          break;
        }

        const json = await resp.json();
        const items = json.items || [];
        if (items.length === 0) break;

        for (const item of items) {
          posts.push(item);
        }

        hasMore = json.more_available || false;
        maxId = json.next_max_id || null;

        // Throttled delay between pages to avoid rate limiting
        if (hasMore) await safeDelay(SAFETY.DELAY_API_PAGE);
      } catch (e) {
        console.error("InstaFetch: Error fetching posts", e);
        break;
      }
    }

    return posts.slice(0, count);
  }

  async function fetchUserReels(userId, count = 50) {
    const reels = [];
    let maxId = null;
    let hasMore = true;

    while (hasMore && reels.length < count) {
      try {
        const body = new URLSearchParams();
        body.append("target_user_id", userId);
        body.append("page_size", Math.min(12, count - reels.length).toString());
        if (maxId) body.append("max_id", maxId);

        const resp = await fetch(
          "https://www.instagram.com/api/v1/clips/user/",
          {
            method: "POST",
            headers: {
              "x-ig-app-id": IG_APP_ID,
              "x-requested-with": "XMLHttpRequest",
              "x-csrftoken": getCSRFToken(),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            credentials: "include",
            body: body.toString(),
          },
        );

        if (!resp.ok) break;
        const json = await resp.json();

        const items = json.items || [];
        for (const item of items) {
          reels.push(item.media);
        }

        hasMore = json.paging_info?.more_available || false;
        maxId = json.paging_info?.max_id || null;

        if (hasMore) await safeDelay(SAFETY.DELAY_API_PAGE);
      } catch (e) {
        console.error("InstaFetch: Error fetching reels", e);
        break;
      }
    }

    return reels.slice(0, count);
  }

  async function fetchStoryHighlights(userId) {
    try {
      const variables = JSON.stringify({
        user_id: userId,
        include_chaining: false,
        include_reel: true,
        include_suggested_users: false,
        include_logged_out_extras: false,
        include_highlight_reels: true,
        include_live_status: false,
      });

      const resp = await fetch(
        `https://www.instagram.com/graphql/query/?query_hash=d4d88dc1500312af6f937f7b804c68c3&variables=${encodeURIComponent(variables)}`,
        {
          headers: {
            "x-ig-app-id": IG_APP_ID,
            "x-requested-with": "XMLHttpRequest",
            "x-csrftoken": getCSRFToken(),
          },
          credentials: "include",
        },
      );

      if (!resp.ok) return [];
      const json = await resp.json();
      return (
        json.data?.user?.edge_highlight_reels?.edges?.map((e) => e.node) || []
      );
    } catch (e) {
      console.error("InstaFetch: Error fetching highlights", e);
      return [];
    }
  }

  async function fetchHighlightItems(highlightId) {
    try {
      const variables = JSON.stringify({
        highlight_reel_ids: [highlightId],
        reel_ids: [],
        location_ids: [],
        precomposed_overlay: false,
      });

      const resp = await fetch(
        `https://www.instagram.com/graphql/query/?query_hash=45246d3fe16ccc6577e0bd297a5db1ab&variables=${encodeURIComponent(variables)}`,
        {
          headers: {
            "x-ig-app-id": IG_APP_ID,
            "x-requested-with": "XMLHttpRequest",
            "x-csrftoken": getCSRFToken(),
          },
          credentials: "include",
        },
      );

      if (!resp.ok) return [];
      const json = await resp.json();
      const reelsMedia = json.data?.reels_media || [];
      if (reelsMedia.length === 0) return [];
      return reelsMedia[0].items || [];
    } catch (e) {
      console.error("InstaFetch: Error fetching highlight items", e);
      return [];
    }
  }

  // ── Media URL extraction ───────────────────────────────────────────────

  function getPostMediaUrls(post) {
    const mediaItems = [];

    // v1 API: carousel_media for multi-image posts (media_type 8)
    if (post.carousel_media && post.carousel_media.length > 0) {
      for (const child of post.carousel_media) {
        const media = extractV1Media(child);
        if (media) mediaItems.push(media);
      }
    }
    // Legacy GraphQL: edge_sidecar_to_children
    else if (post.edge_sidecar_to_children) {
      for (const child of post.edge_sidecar_to_children.edges) {
        const node = child.node;
        if (node.is_video && node.video_url) {
          mediaItems.push({ url: node.video_url, type: "video", ext: "mp4" });
        } else {
          mediaItems.push({
            url: node.display_url || node.display_src,
            type: "image",
            ext: "jpg",
          });
        }
      }
    }
    // Single media item
    else {
      const media = extractV1Media(post);
      if (media) {
        mediaItems.push(media);
      } else if (post.is_video && post.video_url) {
        mediaItems.push({ url: post.video_url, type: "video", ext: "mp4" });
      } else if (post.display_url || post.display_src) {
        mediaItems.push({
          url: post.display_url || post.display_src,
          type: "image",
          ext: "jpg",
        });
      }
    }

    return mediaItems;
  }

  // Extract media URL from v1 API format
  function extractV1Media(item) {
    // media_type: 1 = photo, 2 = video, 8 = carousel
    if (
      item.media_type === 2 ||
      (item.video_versions && item.video_versions.length > 0)
    ) {
      const best = item.video_versions.reduce((a, b) =>
        a.width > b.width ? a : b,
      );
      return { url: best.url, type: "video", ext: "mp4" };
    }
    if (item.image_versions2?.candidates?.length > 0) {
      // First candidate is usually the highest resolution
      const best = item.image_versions2.candidates[0];
      return { url: best.url, type: "image", ext: "jpg" };
    }
    return null;
  }

  function getReelMediaUrl(reel) {
    // API v1 format
    if (reel.video_versions && reel.video_versions.length > 0) {
      // Get best quality
      const best = reel.video_versions.reduce((a, b) =>
        a.width > b.width ? a : b,
      );
      return { url: best.url, type: "video", ext: "mp4" };
    }
    if (reel.video_url) {
      return { url: reel.video_url, type: "video", ext: "mp4" };
    }
    // Fallback to image
    if (reel.image_versions2?.candidates?.length > 0) {
      const best = reel.image_versions2.candidates[0];
      return { url: best.url, type: "image", ext: "jpg" };
    }
    if (reel.display_url) {
      return { url: reel.display_url, type: "image", ext: "jpg" };
    }
    return null;
  }

  // Fallback for opened post: read media directly from DOM when API is blocked
  function getCurrentPostMediaUrlsFromDom() {
    const media = [];
    const seen = new Set();

    const article =
      document.querySelector("main article") ||
      document.querySelector("article");
    if (!article) return media;

    const videoEls = article.querySelectorAll("video[src]");
    for (const el of videoEls) {
      const url = el.currentSrc || el.src;
      if (url && !seen.has(url)) {
        seen.add(url);
        media.push({ url, type: "video", ext: "mp4" });
      }
    }

    const imgEls = article.querySelectorAll("img[src]");
    for (const el of imgEls) {
      const url = el.currentSrc || el.src;
      if (!url || seen.has(url)) continue;

      // Ignore tiny UI assets/avatars and focus on likely post media
      const w = el.naturalWidth || 0;
      const h = el.naturalHeight || 0;
      if (w < 320 || h < 320) continue;

      seen.add(url);
      media.push({ url, type: "image", ext: "jpg" });
    }

    return media;
  }

  async function getCurrentPostMediaUrlsFromDomWithRetry(
    attempts = 12,
    delayMs = 250,
  ) {
    for (let i = 0; i < attempts; i++) {
      const media = getCurrentPostMediaUrlsFromDom();
      if (media.length > 0) return media;
      await sleep(delayMs);
    }
    return [];
  }

  // ── Download & ZIP ─────────────────────────────────────────────────────

  async function fetchMediaBlob(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "fetchMedia", url }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    });
  }

  function dataURLtoBlob(dataURL) {
    const parts = dataURL.split(",");
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
    const byteString = atob(parts[1]);
    const arrayBuffer = new ArrayBuffer(byteString.length);
    const uint8Array = new Uint8Array(arrayBuffer);
    for (let i = 0; i < byteString.length; i++) {
      uint8Array[i] = byteString.charCodeAt(i);
    }
    return new Blob([uint8Array], { type: mime });
  }

  async function performDownload(options) {
    const zip = new JSZip();
    const username = currentUsername;
    let totalItems = 0;
    let processedItems = 0;
    let failedItems = 0;

    updateProgress(0, "Preparing...");

    // Calculate total
    if (options.profilePic) totalItems += 1;
    if (options.posts) totalItems += options.postsCount;
    if (options.reels) totalItems += options.reelsCount;
    if (options.highlights) totalItems += 10; // Estimate, will adjust

    // 1. Profile Picture
    if (options.profilePic && profileData) {
      updateProgress(
        processedItems / totalItems,
        "Downloading profile photo...",
      );
      try {
        const hdPicUrl =
          profileData.profile_pic_url_hd || profileData.profile_pic_url;
        const result = await fetchMediaBlob(hdPicUrl);
        if (result.data) {
          const blob = dataURLtoBlob(result.data);
          zip.file(`${username}_profile_pic.jpg`, blob);
        }
      } catch (e) {
        console.error("InstaFetch: Error downloading profile pic", e);
        failedItems++;
      }
      processedItems++;
    }

    // 2. Posts
    if (options.posts && profileData) {
      updateProgress(processedItems / totalItems, "Downloading posts...");
      try {
        const userId = profileData.id || profileData.pk;
        const posts = await fetchUserPosts(userId, options.postsCount);

        const postsFolder = zip.folder("posts");
        let postIndex = 0;

        for (const post of posts) {
          const mediaItems = getPostMediaUrls(post);
          let mediaIndex = 0;

          for (const media of mediaItems) {
            try {
              updateProgress(
                processedItems / totalItems,
                `Downloading post ${postIndex + 1}/${posts.length}...`,
              );

              const result = await fetchMediaBlob(media.url);
              if (result.data) {
                const blob = dataURLtoBlob(result.data);
                const takenAt = post.taken_at || post.taken_at_timestamp;
                const timestamp = takenAt
                  ? new Date(takenAt * 1000).toISOString().split("T")[0]
                  : `post_${postIndex}`;

                const filename =
                  mediaItems.length > 1
                    ? `${timestamp}_${postIndex + 1}_${mediaIndex + 1}.${media.ext}`
                    : `${timestamp}_${postIndex + 1}.${media.ext}`;

                postsFolder.file(filename, blob);
              }
              // Throttle between media downloads
              await safeDelay(SAFETY.DELAY_MEDIA_DOWNLOAD);
            } catch (e) {
              console.error(`InstaFetch: Error downloading post media`, e);
              failedItems++;
            }
            mediaIndex++;
          }

          postIndex++;
          processedItems++;
          updateProgress(
            processedItems / totalItems,
            `Downloading post ${postIndex}/${posts.length}...`,
          );
        }
      } catch (e) {
        console.error("InstaFetch: Error fetching posts", e);
      }
    }

    // 3. Reels
    if (options.reels && profileData) {
      updateProgress(processedItems / totalItems, "Downloading reels...");
      try {
        const userId = profileData.id || profileData.pk;
        const reels = await fetchUserReels(userId, options.reelsCount);

        const reelsFolder = zip.folder("reels");
        let reelIndex = 0;

        for (const reel of reels) {
          try {
            updateProgress(
              processedItems / totalItems,
              `Downloading reel ${reelIndex + 1}/${reels.length}...`,
            );

            const media = getReelMediaUrl(reel);
            if (media) {
              const result = await fetchMediaBlob(media.url);
              if (result.data) {
                const blob = dataURLtoBlob(result.data);
                const timestamp = reel.taken_at
                  ? new Date(reel.taken_at * 1000).toISOString().split("T")[0]
                  : `reel_${reelIndex}`;
                reelsFolder.file(
                  `${timestamp}_${reelIndex + 1}.${media.ext}`,
                  blob,
                );
              }
            }
          } catch (e) {
            console.error(`InstaFetch: Error downloading reel`, e);
            failedItems++;
          }

          reelIndex++;
          processedItems++;

          // Throttle between reel downloads
          await safeDelay(SAFETY.DELAY_MEDIA_DOWNLOAD);
        }
      } catch (e) {
        console.error("InstaFetch: Error fetching reels", e);
      }
    }

    // 4. Story Highlights
    if (options.highlights && profileData) {
      updateProgress(
        processedItems / totalItems,
        "Downloading story highlights...",
      );
      try {
        const userId = profileData.id || profileData.pk;
        const highlights = await fetchStoryHighlights(userId);

        const highlightsFolder = zip.folder("highlights");

        for (let hi = 0; hi < highlights.length; hi++) {
          const highlight = highlights[hi];
          const highlightTitle = (
            highlight.title || `highlight_${hi + 1}`
          ).replace(/[^a-zA-Z0-9_\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]/g, "_");
          const hFolder = highlightsFolder.folder(highlightTitle);

          updateProgress(
            processedItems / totalItems,
            `Downloading highlight "${highlight.title || hi + 1}"...`,
          );

          try {
            const items = await fetchHighlightItems(highlight.id);

            for (let ii = 0; ii < items.length; ii++) {
              const item = items[ii];
              try {
                const isVideo = item.is_video || item.video_url;
                const url = isVideo
                  ? item.video_url || item.video_resources?.[0]?.src
                  : item.display_url ||
                    item.display_resources?.slice(-1)[0]?.src;
                const ext = isVideo ? "mp4" : "jpg";

                if (url) {
                  const result = await fetchMediaBlob(url);
                  if (result.data) {
                    const blob = dataURLtoBlob(result.data);
                    hFolder.file(`${ii + 1}.${ext}`, blob);
                  }
                  await safeDelay(SAFETY.DELAY_MEDIA_DOWNLOAD);
                }
              } catch (e) {
                console.error(
                  "InstaFetch: Error downloading highlight item",
                  e,
                );
                failedItems++;
              }
            }
          } catch (e) {
            console.error("InstaFetch: Error fetching highlight items", e);
          }

          processedItems++;
          await safeDelay(SAFETY.DELAY_HIGHLIGHT_GROUP);
        }
      } catch (e) {
        console.error("InstaFetch: Error fetching highlights", e);
      }
    }

    // Generate ZIP
    updateProgress(0.95, "Creating ZIP archive...");

    try {
      const zipBlob = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        },
        (metadata) => {
          updateProgress(0.95 + metadata.percent * 0.0005, "Compressing...");
        },
      );

      // Trigger download
      const downloadUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `InstaFetch_${username}_${new Date().toISOString().split("T")[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      const sizeMB = (zipBlob.size / (1024 * 1024)).toFixed(2);
      updateProgress(
        1,
        `Done! Downloaded ${sizeMB} MB. Errors: ${failedItems}`,
      );
    } catch (e) {
      console.error("InstaFetch: Error generating ZIP", e);
      updateProgress(0, `ZIP generation error: ${e.message}`);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── UI: Floating Action Button ─────────────────────────────────────────

  function showFab() {
    if (fabElement) {
      fabElement.style.display = "flex";
      return;
    }

    fabElement = document.createElement("div");
    fabElement.id = "instafetch-fab";
    fabElement.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span>InstaFetch</span>
    `;

    fabElement.addEventListener("click", togglePanel);
    document.body.appendChild(fabElement);
  }

  function hideFab() {
    if (fabElement) {
      fabElement.style.display = "none";
    }
  }

  function showSinglePostDownloadButton(shortcode) {
    if (!singlePostBtnElement) {
      singlePostBtnElement = document.createElement("button");
      singlePostBtnElement.id = "instafetch-single-post-download";
      singlePostBtnElement.innerHTML =
        '<span class="if-single-icon">⬇</span><span>Download post</span>';
      document.body.appendChild(singlePostBtnElement);
    }

    singlePostBtnElement.style.display = "inline-flex";
    singlePostBtnElement.dataset.shortcode = shortcode;

    if (!singlePostBtnElement.dataset.bound) {
      singlePostBtnElement.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sc = singlePostBtnElement?.dataset.shortcode;
        if (!sc) return;
        await downloadSinglePost(sc);
      });
      singlePostBtnElement.dataset.bound = "1";
    }
  }

  function hideSinglePostDownloadButton() {
    if (singlePostBtnElement) {
      singlePostBtnElement.style.display = "none";
    }
  }

  async function downloadSinglePost(shortcode) {
    if (isSinglePostDownloading || !singlePostBtnElement) return;
    isSinglePostDownloading = true;

    const originalHtml = singlePostBtnElement.innerHTML;
    singlePostBtnElement.classList.add("loading");
    singlePostBtnElement.innerHTML =
      '<span class="if-single-icon">⏳</span><span>Downloading...</span>';

    try {
      const post = await fetchPostByShortcode(shortcode);

      let mediaItems = post ? getPostMediaUrls(post) : [];
      if (!mediaItems.length) {
        mediaItems = await getCurrentPostMediaUrlsFromDomWithRetry();
      }

      if (!mediaItems.length) {
        throw new Error(
          "No media available to download. Open the post directly and try again.",
        );
      }

      const createdAt =
        post?.taken_at ||
        post?.taken_at_timestamp ||
        Math.floor(Date.now() / 1000);
      const datePrefix = new Date(createdAt * 1000).toISOString().split("T")[0];

      if (mediaItems.length === 1) {
        const media = mediaItems[0];
        const result = await fetchMediaBlob(media.url);
        if (!result.data) {
          throw new Error("Failed to download post file");
        }

        const blob = dataURLtoBlob(result.data);
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `InstaFetch_post_${datePrefix}_${shortcode}.${media.ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
      } else {
        const zip = new JSZip();

        for (let i = 0; i < mediaItems.length; i++) {
          const media = mediaItems[i];
          const result = await fetchMediaBlob(media.url);
          if (result.data) {
            const blob = dataURLtoBlob(result.data);
            zip.file(`${datePrefix}_${shortcode}_${i + 1}.${media.ext}`, blob);
          }
          await safeDelay(SAFETY.DELAY_MEDIA_DOWNLOAD);
        }

        const zipBlob = await zip.generateAsync({
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });

        const downloadUrl = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `InstaFetch_post_${shortcode}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
      }

      singlePostBtnElement.innerHTML =
        '<span class="if-single-icon">✓</span><span>Done</span>';
      setTimeout(() => {
        if (singlePostBtnElement) singlePostBtnElement.innerHTML = originalHtml;
      }, 1800);
    } catch (e) {
      console.error("InstaFetch: Single post download failed", e);
      singlePostBtnElement.innerHTML =
        '<span class="if-single-icon">!</span><span>Error</span>';
      setTimeout(() => {
        if (singlePostBtnElement) singlePostBtnElement.innerHTML = originalHtml;
      }, 2000);
    } finally {
      isSinglePostDownloading = false;
      singlePostBtnElement.classList.remove("loading");
    }
  }

  // ── UI: Panel ──────────────────────────────────────────────────────────

  async function togglePanel() {
    if (panelElement) {
      closePanel();
      return;
    }
    openPanel();
  }

  async function openPanel() {
    if (panelElement) return;

    panelElement = document.createElement("div");
    panelElement.id = "instafetch-panel";
    panelElement.innerHTML = `
      <div class="instafetch-panel-inner">
        <div class="instafetch-header">
          <div class="instafetch-title">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <h3>InstaFetch</h3>
          </div>
          <button class="instafetch-close" id="instafetch-close-btn">&times;</button>
        </div>

        <div class="instafetch-profile-section" id="instafetch-profile">
          <div class="instafetch-loading">
            <div class="instafetch-spinner"></div>
            <span>Loading profile @${currentUsername}...</span>
          </div>
        </div>

        <div class="instafetch-options" id="instafetch-options" style="display:none;">
          <label class="instafetch-option">
            <input type="checkbox" id="instafetch-opt-pfp" checked>
            <div class="instafetch-option-info">
              <span class="instafetch-option-label">🖼️ Profile photo (HD)</span>
              <span class="instafetch-option-desc">Full-resolution profile photo</span>
            </div>
          </label>

          <label class="instafetch-option">
            <input type="checkbox" id="instafetch-opt-posts" checked>
            <div class="instafetch-option-info">
              <span class="instafetch-option-label">📸 Posts</span>
              <span class="instafetch-option-desc" id="instafetch-posts-count-label">Photos and videos from posts</span>
            </div>
            <div class="instafetch-count-control">
              <button class="instafetch-count-btn minus" data-target="instafetch-posts-num">−</button>
              <input type="number" id="instafetch-posts-num" value="12" min="1" max="200" class="instafetch-count-input">
              <button class="instafetch-count-btn plus" data-target="instafetch-posts-num">+</button>
            </div>
          </label>

          <label class="instafetch-option">
            <input type="checkbox" id="instafetch-opt-reels">
            <div class="instafetch-option-info">
              <span class="instafetch-option-label">🎬 Reels</span>
              <span class="instafetch-option-desc">Short videos</span>
            </div>
            <div class="instafetch-count-control">
              <button class="instafetch-count-btn minus" data-target="instafetch-reels-num">−</button>
              <input type="number" id="instafetch-reels-num" value="12" min="1" max="200" class="instafetch-count-input">
              <button class="instafetch-count-btn plus" data-target="instafetch-reels-num">+</button>
            </div>
          </label>

          <label class="instafetch-option">
            <input type="checkbox" id="instafetch-opt-highlights">
            <div class="instafetch-option-info">
              <span class="instafetch-option-label">⭐ Story highlights</span>
              <span class="instafetch-option-desc">All saved highlight stories</span>
            </div>
          </label>
        </div>

        <div class="instafetch-progress" id="instafetch-progress" style="display:none;">
          <div class="instafetch-progress-bar">
            <div class="instafetch-progress-fill" id="instafetch-progress-fill"></div>
          </div>
          <span class="instafetch-progress-text" id="instafetch-progress-text">Preparing...</span>
        </div>

        <div class="instafetch-actions" id="instafetch-actions" style="display:none;">
          <button class="instafetch-btn instafetch-btn-primary" id="instafetch-download-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download ZIP
          </button>
        </div>

        <div class="instafetch-footer">
          InstaFetch v1.0
        </div>
      </div>
    `;

    document.body.appendChild(panelElement);
    attachPanelEvents();
    await loadProfileData();
  }

  function closePanel() {
    if (panelElement) {
      panelElement.remove();
      panelElement = null;
    }
  }

  function attachPanelEvents() {
    // Close button
    document
      .getElementById("instafetch-close-btn")
      ?.addEventListener("click", (e) => {
        e.stopPropagation();
        closePanel();
      });

    // Click outside to close
    panelElement?.addEventListener("click", (e) => {
      if (e.target === panelElement) {
        closePanel();
      }
    });

    // Count buttons (+/-)
    panelElement?.querySelectorAll(".instafetch-count-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetId = btn.dataset.target;
        const input = document.getElementById(targetId);
        if (!input) return;
        const step = btn.classList.contains("plus") ? 12 : -12;
        const newVal = Math.max(
          parseInt(input.min) || 1,
          Math.min(parseInt(input.max) || 500, parseInt(input.value) + step),
        );
        input.value = newVal;
      });
    });

    // Download button
    document
      .getElementById("instafetch-download-btn")
      ?.addEventListener("click", async (e) => {
        e.preventDefault();
        if (isDownloading) return;
        isDownloading = true;

        const btn = document.getElementById("instafetch-download-btn");
        btn.disabled = true;
        btn.classList.add("disabled");

        document.getElementById("instafetch-progress").style.display = "block";

        const options = {
          profilePic: document.getElementById("instafetch-opt-pfp")?.checked,
          posts: document.getElementById("instafetch-opt-posts")?.checked,
          postsCount:
            parseInt(document.getElementById("instafetch-posts-num")?.value) ||
            12,
          reels: document.getElementById("instafetch-opt-reels")?.checked,
          reelsCount:
            parseInt(document.getElementById("instafetch-reels-num")?.value) ||
            12,
          highlights: document.getElementById("instafetch-opt-highlights")
            ?.checked,
        };

        // Calculate total items and show warnings
        let totalEstimate = 0;
        if (options.profilePic) totalEstimate += 1;
        if (options.posts) totalEstimate += options.postsCount;
        if (options.reels) totalEstimate += options.reelsCount;
        if (options.highlights) totalEstimate += 30; // rough estimate

        if (totalEstimate > SAFETY.SOFT_LIMIT) {
          const ok = confirm(
            `⚠️ InstaFetch - Warning!\n\n` +
              `You are about to download ~${totalEstimate} items. ` +
              `Downloading many media files at once increases the risk ` +
              `of a temporary Instagram action block.\n\n` +
              `Recommended maximum is ${SAFETY.SOFT_LIMIT} items per session.\n\n` +
              `Do you want to continue anyway?`,
          );
          if (!ok) {
            isDownloading = false;
            btn.disabled = false;
            btn.classList.remove("disabled");
            return;
          }
        } else if (totalEstimate > SAFETY.WARN_THRESHOLD) {
          const ok = confirm(
            `InstaFetch - Info\n\n` +
              `You are about to download ~${totalEstimate} items. ` +
              `This may take around ${Math.ceil((totalEstimate * 1.5) / 60)} min due to safety throttling.\n\nContinue?`,
          );
          if (!ok) {
            isDownloading = false;
            btn.disabled = false;
            btn.classList.remove("disabled");
            return;
          }
        }

        try {
          await performDownload(options);
        } catch (err) {
          console.error("InstaFetch: Download failed", err);
          updateProgress(0, `Error: ${err.message}`);
        } finally {
          isDownloading = false;
          btn.disabled = false;
          btn.classList.remove("disabled");
        }
      });

    // Prevent checkbox labels from interfering with count inputs
    panelElement
      ?.querySelectorAll(".instafetch-count-control")
      .forEach((ctrl) => {
        ctrl.addEventListener("click", (e) => {
          e.stopPropagation();
        });
      });

    panelElement
      ?.querySelectorAll(".instafetch-count-input")
      .forEach((input) => {
        input.addEventListener("click", (e) => {
          e.stopPropagation();
        });
      });
  }

  async function loadProfileData() {
    const profileSection = document.getElementById("instafetch-profile");
    const optionsSection = document.getElementById("instafetch-options");
    const actionsSection = document.getElementById("instafetch-actions");

    try {
      profileData = await fetchProfileInfo(currentUsername);

      if (!profileData) {
        profileSection.innerHTML = `
          <div class="instafetch-error">
            <span>❌ Failed to load profile data. Make sure you are logged in.</span>
          </div>
        `;
        return;
      }

      const fullName = profileData.full_name || currentUsername;
      const followersCount =
        profileData.edge_followed_by?.count ??
        profileData.follower_count ??
        "?";
      const postsCount =
        profileData.edge_owner_to_timeline_media?.count ??
        profileData.media_count ??
        "?";
      const isPrivate =
        profileData.is_private && !profileData.followed_by_viewer;
      const picUrl =
        profileData.profile_pic_url_hd || profileData.profile_pic_url;

      profileSection.innerHTML = `
        <div class="instafetch-profile-card">
          <img src="${picUrl}" alt="${currentUsername}" class="instafetch-avatar" />
          <div class="instafetch-profile-info">
            <strong>${fullName}</strong>
            <span class="instafetch-username">@${currentUsername}</span>
            <div class="instafetch-stats">
              <span>📸 ${formatNumber(postsCount)} posts</span>
              <span>👥 ${formatNumber(followersCount)} followers</span>
            </div>
            ${isPrivate ? '<div class="instafetch-private-badge">🔒 Private profile</div>' : ""}
          </div>
        </div>
      `;

      if (isPrivate) {
        profileSection.innerHTML += `
          <div class="instafetch-warning">
            ⚠️ This profile is private and you do not follow it.<br>Downloading content may be limited.
          </div>
        `;
      }

      // Update post count label
      const postsCountLabel = document.getElementById(
        "instafetch-posts-count-label",
      );
      if (postsCountLabel) {
        postsCountLabel.textContent = `Photos and videos from posts (available: ${formatNumber(postsCount)})`;
      }

      // Update max for posts input
      const postsInput = document.getElementById("instafetch-posts-num");
      if (postsInput && typeof postsCount === "number") {
        postsInput.max = postsCount;
        postsInput.value = Math.min(12, postsCount);
      }

      optionsSection.style.display = "block";
      actionsSection.style.display = "flex";
    } catch (e) {
      console.error("InstaFetch: Error loading profile", e);
      profileSection.innerHTML = `
        <div class="instafetch-error">
          <span>❌ Error: ${e.message}</span>
        </div>
      `;
    }
  }

  function updateProgress(fraction, text) {
    const fill = document.getElementById("instafetch-progress-fill");
    const label = document.getElementById("instafetch-progress-text");
    if (fill)
      fill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
    if (label) label.textContent = text;
  }

  function formatNumber(num) {
    if (typeof num !== "number") return num;
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toString();
  }

  // ── Initialize ─────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
