#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_STATUS_ID = "necf-main";
const LIVE_GRACE_MINUTES = 10;
const WATCHER_VERSION = "2026-07-19-simple-youtube-live-page";

const args = new Set(process.argv.slice(2));
const watchMode = args.has("--watch");
const serverMode = args.has("--server") || process.env.REDZONE_SERVER === "1";
const intervalSeconds = Math.max(30, Number.parseInt(process.env.REDZONE_WATCH_INTERVAL_SECONDS || String(DEFAULT_INTERVAL_SECONDS), 10));
let lastManualRunAt = 0;
let serverTimer = null;

async function main() {
  if (serverMode) {
    await startServer();
    return;
  }

  do {
    await runRedzoneUpdate().catch((error) => {
      console.error(`[${new Date().toISOString()}] Redzone watcher failed: ${error.message}`);
      if (!watchMode) process.exitCode = 1;
    });
    if (watchMode) await sleep(intervalSeconds * 1000);
  } while (watchMode);
}

async function startServer() {
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        sendJson(response, {
          ok: true,
          service: "necf-redzone-watcher",
          version: WATCHER_VERSION,
          schedule: `every-${Math.round(intervalSeconds / 60)}-minutes`,
          hasYouTubeApiKey: Boolean(process.env.YOUTUBE_API_KEY),
          hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
          hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/run") {
        const payload = await runRedzoneUpdate({ manual: true, minAgeSeconds: 60 });
        sendJson(response, payload);
        return;
      }

      if (request.method === "GET" && url.pathname === "/debug/youtube") {
        const targetUrl = url.searchParams.get("url") || "";
        if (!targetUrl) {
          sendJson(response, { ok: false, error: "Add ?url=<youtube channel or live url>" }, 400);
          return;
        }
        const payload = await debugYoutubeLookup(targetUrl);
        sendJson(response, payload);
        return;
      }

      sendJson(response, { ok: false, error: "Not found" }, 404);
    } catch (error) {
      sendJson(response, { ok: false, error: error.message }, 500);
    }
  });

  server.listen(port, () => {
    console.log(`NECF Redzone watcher ${WATCHER_VERSION} listening on port ${port}`);
    console.log(`YouTube API key configured: ${process.env.YOUTUBE_API_KEY ? "yes" : "no"}`);
  });

  serverTimer = setInterval(() => {
    runRedzoneUpdate().catch((error) => {
      console.error(`[${new Date().toISOString()}] Scheduled Redzone update failed: ${error.message}`);
    });
  }, intervalSeconds * 1000);

  await runRedzoneUpdate().catch((error) => {
    console.error(`[${new Date().toISOString()}] Initial Redzone update failed: ${error.message}`);
  });
}

async function runRedzoneUpdate({ manual = false, minAgeSeconds = 0 } = {}) {
  if (manual && minAgeSeconds > 0) {
    const now = Date.now();
    if (now - lastManualRunAt < minAgeSeconds * 1000) {
      const snapshot = await fetchCurrentRedzoneSnapshot();
      return {
        ok: true,
        version: WATCHER_VERSION,
        rateLimited: true,
        checkedAt: snapshot?.checkedAt || "",
        liveCount: Array.isArray(snapshot?.live) ? snapshot.live.length : 0,
        channelCount: snapshot?.recentByKey ? Object.keys(snapshot.recentByKey).length : 0,
        manual
      };
    }
    lastManualRunAt = now;
  }

  const snapshot = await buildRedzoneSnapshot();
  await saveRedzoneSnapshot(snapshot);
  console.log(`[${new Date().toISOString()}] Redzone updated: ${snapshot.live.length} live, ${Object.keys(snapshot.recentByKey).length} channels checked.`);
  return {
    ok: true,
    version: WATCHER_VERSION,
    checkedAt: snapshot.checkedAt,
    liveCount: snapshot.live.length,
    channelCount: Object.keys(snapshot.recentByKey).length,
    manual
  };
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function buildRedzoneSnapshot() {
  const previousSnapshot = await fetchCurrentRedzoneSnapshot();
  const [profiles, leagueState] = await Promise.all([fetchProfiles(), fetchLeagueState()]);
  const teamsById = new Map((leagueState?.teams || []).map((team) => [team.id, team]));
  const redzoneProfiles = profiles.flatMap((profile) => streamProfilesFromProfile(profile, teamsById));
  const previousRecentByKey = previousSnapshot?.recentByKey || {};
  const checkedAt = new Date().toISOString();
  const live = [];
  const recentByKey = {};

  for (const profile of redzoneProfiles) {
    try {
      const result = profile.platform === "twitch"
        ? await twitchStreamsForProfile(profile)
        : await youtubeStreamsForProfile(profile);
      const liveMatches = result.live
        .filter((stream) => /necf/i.test(stream.title || ""))
        .map((stream) => ({ ...stream, lastSeenAt: checkedAt, staleLive: false }));
      recentByKey[profile.key] = mergeRecentStreams(liveMatches, result.recent, previousRecentByKey[profile.key]).slice(0, 5);
      live.push(...liveMatches);
    } catch (error) {
      recentByKey[profile.key] = Array.isArray(previousRecentByKey[profile.key]) ? previousRecentByKey[profile.key].slice(0, 5) : [];
      console.warn(`Skipped ${profile.label} ${profile.platformLabel}: ${error.message}`);
    }
  }

  return {
    checkedAt,
    source: "necf-stream-watcher",
    live: mergeLiveStreams(live, previousSnapshot?.live || [], previousSnapshot?.checkedAt || ""),
    recentByKey
  };
}

async function fetchCurrentRedzoneSnapshot() {
  try {
    const id = encodeURIComponent(process.env.REDZONE_STATUS_ID || process.env.SUPABASE_LEAGUE_STATE_ID || DEFAULT_STATUS_ID);
    const rows = await supabaseRequest(`/rest/v1/redzone_status?id=eq.${id}&select=data,updated_at`);
    return rows?.[0]?.data || null;
  } catch {
    return null;
  }
}

function mergeLiveStreams(currentLive, previousLive, previousCheckedAt = "") {
  const byKey = new Map();
  currentLive.filter(Boolean).forEach((stream) => {
    const key = stream.id || stream.url || `${stream.profileKey}:${stream.title}`;
    if (key) byKey.set(key, stream);
  });

  const graceMs = LIVE_GRACE_MINUTES * 60 * 1000;
  previousLive.filter(Boolean).forEach((stream) => {
    const key = stream.id || stream.url || `${stream.profileKey}:${stream.title}`;
    if (!key || byKey.has(key)) return;
    const lastSeenMs = Date.parse(stream.lastSeenAt || previousCheckedAt || stream.date || "") || 0;
    if (!lastSeenMs || Date.now() - lastSeenMs > graceMs) return;
    byKey.set(key, { ...stream, staleLive: true });
  });

  return [...byKey.values()].sort((a, b) => {
    const bMs = Date.parse(b.lastSeenAt || b.date || "") || 0;
    const aMs = Date.parse(a.lastSeenAt || a.date || "") || 0;
    return bMs - aMs;
  });
}

function mergeRecentStreams(...groups) {
  const byKey = new Map();
  groups.flat().filter(Boolean).forEach((stream) => {
    const key = stream.id || stream.url || `${stream.title}:${stream.date}`;
    if (!key || byKey.has(key)) return;
    byKey.set(key, stream);
  });
  return [...byKey.values()].sort((a, b) => {
    const bMs = Date.parse(b.date || "") || 0;
    const aMs = Date.parse(a.date || "") || 0;
    return bMs - aMs;
  });
}

async function fetchProfiles() {
  const rows = await supabaseRequest("/rest/v1/profiles?select=*");
  return (Array.isArray(rows) ? rows : [])
    .filter((profile) => profile.role !== "removed")
    .filter((profile) => profile.youtube_url || profile.twitch_url);
}

async function fetchLeagueState() {
  try {
    const id = encodeURIComponent(process.env.SUPABASE_LEAGUE_STATE_ID || DEFAULT_STATUS_ID);
    const rows = await supabaseRequest(`/rest/v1/league_state?id=eq.${id}&select=data`);
    return rows?.[0]?.data || {};
  } catch {
    return {};
  }
}

async function saveRedzoneSnapshot(snapshot) {
  const id = process.env.REDZONE_STATUS_ID || process.env.SUPABASE_LEAGUE_STATE_ID || DEFAULT_STATUS_ID;
  await supabaseRequest(`/rest/v1/redzone_status?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id,
      data: snapshot,
      updated_at: new Date().toISOString()
    })
  });
}

function streamProfilesFromProfile(profile, teamsById) {
  const team = teamsById.get(profile.team_id) || null;
  const base = {
    username: profile.username || profile.email || profile.id,
    memberName: profile.display_name || profile.username || profile.email || "League member",
    teamId: team?.id || profile.team_id || null,
    teamName: team?.name || "",
    label: team?.name || profile.display_name || profile.username || "League member",
    avatarUrl: profile.avatar_url || team?.logoUrl || team?.logo_url || "",
    youtubeUrl: normalizeStreamUrl(profile.youtube_url || "", "youtube"),
    twitchUrl: normalizeStreamUrl(profile.twitch_url || "", "twitch")
  };
  return [
    base.youtubeUrl ? streamProfileFromBase(base, "youtube", base.youtubeUrl) : null,
    base.twitchUrl ? streamProfileFromBase(base, "twitch", base.twitchUrl) : null
  ].filter(Boolean);
}

function streamProfileFromBase(base, platform, streamUrl) {
  const handle = platform === "twitch" ? twitchLoginFromUrl(streamUrl) : youtubeHandleFromUrl(streamUrl);
  return {
    key: `${base.username}:${platform}:${handle || streamUrl}`,
    username: base.username,
    teamId: base.teamId,
    teamName: base.teamName,
    label: base.label,
    memberName: base.memberName,
    avatarUrl: base.avatarUrl,
    platform,
    platformLabel: platform === "twitch" ? "Twitch" : "YouTube",
    handle,
    streamUrl
  };
}

async function youtubeStreamsForProfile(profile) {
  const ref = youtubeChannelRef(profile.streamUrl);
  const live = await youtubeLiveStream(ref, profile);
  const channelId = ref.channelId || await resolveYoutubeChannelId(ref).catch((error) => {
    console.warn(`YouTube channel ID lookup failed for ${profile.label}: ${error.message}`);
    return "";
  });
  const recent = channelId ? await youtubeRecentVideos(channelId, profile).catch((error) => {
    console.warn(`Recent YouTube lookup failed for ${profile.label}: ${error.message}`);
    return [];
  }) : [];
  return { live: live ? [live] : [], recent };
}

function youtubeChannelRef(value) {
  const url = safeUrl(value);
  if (!url) return { handle: "", channelId: "", videoId: "" };
  const parts = url.pathname.split("/").filter(Boolean);
  const videoId = youtubeVideoIdFromUrl(value);
  if (videoId) return { handle: "", channelId: "", videoId };
  const handle = parts.find((part) => part.startsWith("@")) || "";
  if (parts[0] === "channel" && parts[1]) return { handle, channelId: parts[1], videoId: "" };
  return { handle: handle || parts[0] || "", channelId: "", videoId: "" };
}

async function resolveYoutubeChannelId(ref) {
  if (ref.channelId) return ref.channelId;
  if (process.env.YOUTUBE_API_KEY && ref.handle?.startsWith("@")) {
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(ref.handle)}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`);
    const id = data?.items?.[0]?.id;
    if (id) return id;
  }
  if (!ref.handle) return "";
  const html = await fetchText(`https://www.youtube.com/${encodeURIComponent(ref.handle).replace("%40", "@")}`);
  return matchFirst(html, /"channelId":"(UC[^"]+)"/) || matchFirst(html, /\/channel\/(UC[a-zA-Z0-9_-]+)/) || "";
}

async function youtubeRecentVideos(channelId, profile) {
  if (process.env.YOUTUBE_API_KEY) {
    try {
      const data = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&maxResults=5&order=date&type=video&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`);
      return (data?.items || []).map((item) => youtubeVideoFromApiItem(item, profile));
    } catch (error) {
      console.warn(`YouTube API recent lookup failed for ${profile.label}; trying RSS fallback: ${error.message}`);
    }
  }

  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 5).map((match) => {
    const entry = match[1];
    const videoId = xmlText(entry, "yt:videoId");
    return {
      id: videoId,
      profileKey: profile.key,
      title: decodeHtml(xmlText(entry, "title") || "YouTube stream"),
      date: xmlText(entry, "published"),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : profile.streamUrl,
      embedUrl: videoId ? `https://www.youtube.com/embed/${videoId}` : "",
      thumbnailUrl: matchFirst(entry, /<media:thumbnail url="([^"]+)"/) || "",
      platform: "youtube",
      platformLabel: "YouTube",
      channelLabel: profile.label
    };
  });
}

function youtubeVideoFromApiItem(item, profile) {
  return {
    id: item.id?.videoId || item.etag,
    profileKey: profile.key,
    title: item.snippet?.title || "YouTube stream",
    date: item.snippet?.publishedAt || "",
    url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : profile.streamUrl,
    embedUrl: item.id?.videoId ? `https://www.youtube.com/embed/${item.id.videoId}` : "",
    thumbnailUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || "",
    platform: "youtube",
    platformLabel: "YouTube",
    channelLabel: profile.label
  };
}

async function youtubeLiveStream(ref, profile) {
  if (ref.videoId) {
    return youtubeLiveStreamFromVideo(ref.videoId, profile).catch((error) => {
      console.warn(`Direct YouTube live lookup failed for ${profile.label}: ${error.message}`);
      return null;
    });
  }

  const pageMatch = await youtubeLiveStreamFromPage(ref, profile).catch((error) => {
    console.warn(`YouTube /live page failed for ${profile.label}: ${error.message}`);
    return null;
  });
  return pageMatch;
}

async function youtubeLiveStreamFromApi(channelId, profile) {
  if (!process.env.YOUTUBE_API_KEY || !channelId) return null;
  const data = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&maxResults=3&type=video&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`);
  const items = data?.items || [];
  console.log(`YouTube API live lookup for ${profile.label}: ${items.length} live item(s).`);
  const match = items.find((item) => /necf/i.test(item.snippet?.title || ""));
  if (!match?.id?.videoId) return null;
  return {
    ...youtubeVideoFromApiItem(match, profile),
    embedUrl: `https://www.youtube.com/embed/${match.id.videoId}?autoplay=1&mute=1`
  };
}

async function youtubeLiveStreamFromRecentFeed(channelId, profile) {
  if (!channelId) return null;
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 8).map((match) => {
    const entry = match[1];
    return {
      id: xmlText(entry, "yt:videoId"),
      title: decodeHtml(xmlText(entry, "title") || "")
    };
  }).filter((entry) => entry.id);

  if (!entries.length) return null;

  if (process.env.YOUTUBE_API_KEY) {
    const ids = entries.map((entry) => entry.id).join(",");
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`);
    const match = (data?.items || []).find((item) => videoDetailsAreLive(item) && /necf/i.test(item.snippet?.title || ""));
    if (match) return youtubeVideoFromDetailsItem(match, profile);
  }

  return null;
}

async function youtubeLiveStreamFromPage(ref, profile) {
  if (!ref.handle && !ref.channelId) return null;
  const liveUrl = youtubeLiveUrl(ref);
  const livePage = await fetchPage(liveUrl);
  const videoId = youtubeVideoIdFromHtml(livePage.text) || youtubeVideoIdFromUrl(livePage.url);
  const title = youtubeTitleFromHtml(livePage.text);
  const isLive = youtubeHtmlIsLive(livePage.text);
  const hasNecfTitle = /necf/i.test(title);
  if (!isLive || !hasNecfTitle) return null;

  return {
    id: videoId || livePage.url || liveUrl,
    profileKey: profile.key,
    title: title || "NECF live stream",
    date: new Date().toISOString(),
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : livePage.url || liveUrl,
    embedUrl: videoId ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1` : "",
    thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
    platform: "youtube",
    platformLabel: "YouTube",
    channelLabel: profile.label,
    liveVerified: true,
    liveUrl
  };
}

async function youtubeLiveStreamFromVideo(videoId, profile, knownPage = null) {
  const apiItem = await youtubeVideoDetails(videoId).catch((error) => {
    console.warn(`YouTube video-details lookup failed for ${profile.label}: ${error.message}`);
    return null;
  });
  if (apiItem && videoDetailsAreLive(apiItem) && /necf/i.test(apiItem.snippet?.title || "")) {
    return youtubeVideoFromDetailsItem(apiItem, profile);
  }

  const [watchPage, directLivePage] = await Promise.all([
    fetchPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`),
    knownPage || fetchPage(`https://www.youtube.com/live/${encodeURIComponent(videoId)}`).catch(() => null)
  ]);
  const title = youtubeTitleFromHtml(directLivePage?.text || "") || youtubeTitleFromHtml(watchPage.text) || "NECF live stream";
  const pageHasNecf = /necf/i.test(directLivePage?.text || "") || /necf/i.test(watchPage.text);
  const titleHasNecf = /necf/i.test(title) || pageHasNecf;
  const isLive = youtubeHtmlIsLive(directLivePage?.text || "") || youtubeHtmlIsLive(watchPage.text) || pageHasNecf;
  if (!titleHasNecf) return null;

  return {
    id: videoId,
    profileKey: profile.key,
    title,
    date: new Date().toISOString(),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    platform: "youtube",
    platformLabel: "YouTube",
    channelLabel: profile.label,
    liveVerified: isLive
  };
}

async function youtubeVideoDetails(videoId) {
  if (!process.env.YOUTUBE_API_KEY || !videoId) return null;
  const data = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`);
  return data?.items?.[0] || null;
}

function videoDetailsAreLive(item) {
  const broadcastStatus = String(item?.snippet?.liveBroadcastContent || "").toLowerCase();
  const details = item?.liveStreamingDetails || {};
  return broadcastStatus === "live" || Boolean(details.actualStartTime && !details.actualEndTime);
}

function youtubeVideoFromDetailsItem(item, profile) {
  const videoId = item.id || "";
  return {
    id: videoId,
    profileKey: profile.key,
    title: item.snippet?.title || "NECF live stream",
    date: item.liveStreamingDetails?.actualStartTime || item.snippet?.publishedAt || new Date().toISOString(),
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : profile.streamUrl,
    embedUrl: videoId ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1` : "",
    thumbnailUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || "",
    platform: "youtube",
    platformLabel: "YouTube",
    channelLabel: profile.label,
    liveVerified: true
  };
}

function youtubeLiveUrl(ref) {
  if (ref.handle) return `https://www.youtube.com/${encodeURIComponent(ref.handle).replace("%40", "@")}/live`;
  return `https://www.youtube.com/channel/${ref.channelId}/live`;
}

function youtubeHtmlIsLive(html) {
  return /"isLiveNow":true/.test(html) ||
    /"status":"LIVE"/.test(html) ||
    /"liveBroadcastContent":"live"/i.test(html) ||
    /watching now/i.test(html) ||
    /started streaming/i.test(html) ||
    /live chat/i.test(html) ||
    /watching this live stream/i.test(html);
}

function youtubeTitleFromHtml(html) {
  return decodeYoutubeText(
    matchFirst(html, /<meta property="og:title" content="([^"]+)"/) ||
    matchFirst(html, /<meta name="title" content="([^"]+)"/) ||
    matchFirst(html, /"videoDetails":\{[\s\S]*?"title":"((?:\\"|[^"])*)"/) ||
    matchFirst(html, /"title":"((?:\\"|[^"])*)"/)
  );
}

function youtubeVideoIdFromHtml(html) {
  return matchFirst(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{8,})"/) ||
    matchFirst(html, /<meta property="og:url" content="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{8,})"/) ||
    matchFirst(html, /watch\?v=([a-zA-Z0-9_-]{8,})/) ||
    matchFirst(html, /"videoId":"([^"]+)"/);
}

function youtubeVideoIdFromUrl(value) {
  const url = safeUrl(value);
  if (!url) return "";
  if (url.searchParams.get("v")) return url.searchParams.get("v");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") return parts[1] || "";
  return "";
}

async function debugYoutubeLookup(value) {
  const ref = youtubeChannelRef(value);
  const channelId = ref.channelId || await resolveYoutubeChannelId(ref).catch((error) => `ERROR: ${error.message}`);
  const result = {
    ok: true,
    version: WATCHER_VERSION,
    input: value,
    handle: ref.handle,
    channelId,
    videoId: ref.videoId,
    hasYouTubeApiKey: Boolean(process.env.YOUTUBE_API_KEY)
  };

  if (ref.videoId) {
    try {
      const apiItem = await youtubeVideoDetails(ref.videoId).catch((error) => {
        result.videoDetailsError = error.message;
        return null;
      });
      if (apiItem) {
        result.videoDetails = {
          title: apiItem.snippet?.title || "",
          liveBroadcastContent: apiItem.snippet?.liveBroadcastContent || "",
          actualStartTime: apiItem.liveStreamingDetails?.actualStartTime || "",
          actualEndTime: apiItem.liveStreamingDetails?.actualEndTime || "",
          isLive: videoDetailsAreLive(apiItem),
          hasNecf: /necf/i.test(apiItem.snippet?.title || "")
        };
      }
      const directPage = await fetchPage(`https://www.youtube.com/live/${encodeURIComponent(ref.videoId)}`);
      const watchPage = await fetchPage(`https://www.youtube.com/watch?v=${encodeURIComponent(ref.videoId)}`);
      result.directVideo = {
        liveUrl: `https://www.youtube.com/live/${ref.videoId}`,
        watchUrl: `https://www.youtube.com/watch?v=${ref.videoId}`,
        finalUrl: directPage.url,
        title: youtubeTitleFromHtml(directPage.text) || youtubeTitleFromHtml(watchPage.text),
        isLive: youtubeHtmlIsLive(directPage.text) || youtubeHtmlIsLive(watchPage.text),
        hasNecf: /necf/i.test(directPage.text) || /necf/i.test(watchPage.text)
      };
    } catch (error) {
      result.directVideoError = error.message;
    }
    return result;
  }

  if (process.env.YOUTUBE_API_KEY && channelId && !String(channelId).startsWith("ERROR:")) {
    try {
      const data = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&maxResults=5&type=video&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`);
      result.apiLiveItems = (data?.items || []).map((item) => ({
        videoId: item.id?.videoId || "",
        title: item.snippet?.title || "",
        publishedAt: item.snippet?.publishedAt || ""
      }));
    } catch (error) {
      result.apiError = error.message;
    }
  }

  try {
    const liveUrl = youtubeLiveUrl(ref);
    const livePage = await fetchPage(liveUrl);
    const videoId = youtubeVideoIdFromHtml(livePage.text) || youtubeVideoIdFromUrl(livePage.url);
    result.page = {
      status: "ok",
      liveUrl,
      finalUrl: livePage.url,
      videoId,
      title: youtubeTitleFromHtml(livePage.text),
      isLive: youtubeHtmlIsLive(livePage.text),
      hasNecf: /necf/i.test(livePage.text)
    };
    if (videoId) {
      const directPage = await fetchPage(`https://www.youtube.com/live/${encodeURIComponent(videoId)}`);
      result.directLivePage = {
        finalUrl: directPage.url,
        title: youtubeTitleFromHtml(directPage.text),
        isLive: youtubeHtmlIsLive(directPage.text),
        hasNecf: /necf/i.test(directPage.text)
      };
    }
  } catch (error) {
    result.pageError = error.message;
  }

  return result;
}

async function fetchPage(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Lookup failed: ${response.status}${text ? ` - ${text.slice(0, 180)}` : ""}`);
  }
  return { url: response.url, text: await response.text() };
}

async function twitchStreamsForProfile(profile) {
  const login = twitchLoginFromUrl(profile.streamUrl);
  if (!login || !process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return { live: [], recent: [] };
  const token = await twitchToken();
  const userData = await fetchJson(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, twitchHeaders(token));
  const user = userData?.data?.[0];
  if (!user) return { live: [], recent: [] };

  const streamData = await fetchJson(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, twitchHeaders(token));
  const live = (streamData?.data || [])
    .filter((stream) => /necf/i.test(stream.title || ""))
    .map((stream) => ({
      id: stream.id,
      profileKey: profile.key,
      title: stream.title,
      date: stream.started_at,
      url: `https://www.twitch.tv/${login}`,
      embedUrl: "",
      thumbnailUrl: stream.thumbnail_url?.replace("{width}", "640").replace("{height}", "360") || "",
      platform: "twitch",
      platformLabel: "Twitch",
      channelLabel: profile.label
    }));

  const videosData = await fetchJson(`https://api.twitch.tv/helix/videos?user_id=${encodeURIComponent(user.id)}&first=5&type=archive`, twitchHeaders(token));
  const recent = (videosData?.data || []).map((video) => ({
    id: video.id,
    profileKey: profile.key,
    title: video.title,
    date: video.published_at || video.created_at,
    url: video.url,
    embedUrl: "",
    thumbnailUrl: video.thumbnail_url || "",
    platform: "twitch",
    platformLabel: "Twitch",
    channelLabel: profile.label
  }));

  return { live, recent };
}

async function twitchToken() {
  const data = await fetchJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });
  return data.access_token;
}

function twitchHeaders(token) {
  return {
    headers: {
      "Client-ID": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`
    }
  };
}

async function supabaseRequest(path, options = {}) {
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL || readSupabaseUrlFromBrowserConfig());
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) throw new Error("Set SUPABASE_URL or configure web/supabase-config.js.");
  if (!serviceKey) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY for the watcher. Do not put this key in browser files.");
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed ${response.status}: ${text}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function readSupabaseUrlFromBrowserConfig() {
  try {
    const configText = fs.readFileSync(new URL("../web/supabase-config.js", import.meta.url), "utf8");
    return matchFirst(configText, /url:\s*"([^"]+)"/);
  } catch {
    return "";
  }
}

function normalizeSupabaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function normalizeStreamUrl(value, provider = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const urlText = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(urlText);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const allowedHosts = {
      youtube: new Set(["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"]),
      twitch: new Set(["twitch.tv", "m.twitch.tv"])
    };
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (provider && allowedHosts[provider] && !allowedHosts[provider].has(hostname)) return "";
    url.protocol = "https:";
    return url.toString();
  } catch {
    return "";
  }
}

function youtubeHandleFromUrl(value) {
  const url = normalizeStreamUrl(value, "youtube");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const handle = parts.find((part) => part.startsWith("@"));
    if (handle) return handle;
    if (parts[0] === "channel" && parts[1]) return parts[1];
    if (parts[0] === "c" && parts[1]) return parts[1];
    return parts[0] || "";
  } catch {
    return "";
  }
}

function twitchLoginFromUrl(value) {
  const url = normalizeStreamUrl(value, "twitch");
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

function safeUrl(value) {
  try {
    const raw = String(value || "").trim();
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Lookup failed: ${response.status}${text ? ` - ${text.slice(0, 180)}` : ""}`);
  }
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Lookup failed: ${response.status}${text ? ` - ${text.slice(0, 180)}` : ""}`);
  }
  return response.json();
}

function xmlText(xml, tag) {
  return decodeHtml(matchFirst(xml, new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) || "");
}

function matchFirst(value, regex) {
  return String(value || "").match(regex)?.[1] || "";
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeYoutubeText(value) {
  const text = String(value || "").replace(/\\"/g, '"').replace(/\\u0026/g, "&");
  return decodeHtml(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
