const DEFAULT_STATUS_ID = "necf-main";
const MANUAL_REFRESH_SECONDS = 60;
const LIVE_GRACE_MINUTES = 10;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRedzoneUpdate(env, { cron: controller.cron }));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsResponse();
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "necf-redzone-watcher",
        schedule: env.REDZONE_CRON_LABEL || "cloudflare-cron"
      });
    }
    if (url.pathname === "/run") {
      const result = await runRedzoneUpdate(env, { manual: true, minAgeSeconds: MANUAL_REFRESH_SECONDS });
      return jsonResponse(result);
    }
    if (url.pathname === "/probe") {
      const result = await probeYoutubeLiveUrl(env, url.searchParams.get("url") || "");
      return jsonResponse(result);
    }
    return jsonResponse({
      ok: true,
      message: "NECF Redzone watcher is waiting for the next scheduled run."
    });
  }
};

async function runRedzoneUpdate(env, meta = {}) {
  const cached = await fetchCurrentRedzoneSnapshot(env);
  if (meta.minAgeSeconds) {
    const checkedAt = cached?.data?.checkedAt || cached?.updated_at || "";
    const checkedMs = checkedAt ? Date.parse(checkedAt) : 0;
    const ageSeconds = checkedMs ? (Date.now() - checkedMs) / 1000 : Number.POSITIVE_INFINITY;
    if (ageSeconds < meta.minAgeSeconds) {
      return {
        ok: true,
        rateLimited: true,
        checkedAt,
        retryAfterSeconds: Math.ceil(meta.minAgeSeconds - ageSeconds),
        liveCount: Array.isArray(cached?.data?.live) ? cached.data.live.length : 0,
        channelCount: cached?.data?.recentByKey ? Object.keys(cached.data.recentByKey).length : 0,
        manual: Boolean(meta.manual)
      };
    }
  }
  const snapshot = await buildRedzoneSnapshot(env, cached?.data || {});
  await saveRedzoneSnapshot(env, snapshot);
  console.log(`Redzone updated: ${snapshot.live.length} live, ${Object.keys(snapshot.recentByKey).length} channels checked.`);
  return {
    ok: true,
    checkedAt: snapshot.checkedAt,
    liveCount: snapshot.live.length,
    channelCount: Object.keys(snapshot.recentByKey).length,
    ...meta
  };
}

async function fetchCurrentRedzoneSnapshot(env) {
  try {
    const id = encodeURIComponent(env.REDZONE_STATUS_ID || env.SUPABASE_LEAGUE_STATE_ID || DEFAULT_STATUS_ID);
    const rows = await supabaseRequest(env, `/rest/v1/redzone_status?id=eq.${id}&select=data,updated_at`);
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

async function buildRedzoneSnapshot(env, previousSnapshot = {}) {
  const [profiles, leagueState] = await Promise.all([fetchProfiles(env), fetchLeagueState(env)]);
  const teamsById = new Map((leagueState?.teams || []).map((team) => [team.id, team]));
  const redzoneProfiles = profiles.flatMap((profile) => streamProfilesFromProfile(profile, teamsById));
  const previousRecentByKey = previousSnapshot?.recentByKey || {};
  const checkedAt = new Date().toISOString();
  const live = [];
  const recentByKey = {};

  for (const profile of redzoneProfiles) {
    try {
      const result = profile.platform === "twitch"
        ? await twitchStreamsForProfile(env, profile)
        : await youtubeStreamsForProfile(env, profile);
      const liveMatches = result.live
        .filter((stream) => /necf/i.test(stream.title || ""))
        .map((stream) => ({ ...stream, lastSeenAt: checkedAt, staleLive: false }));
      live.push(...liveMatches);
      recentByKey[profile.key] = mergeRecentStreams(liveMatches, result.recent, previousRecentByKey[profile.key]).slice(0, 5);
    } catch (error) {
      recentByKey[profile.key] = Array.isArray(previousRecentByKey[profile.key]) ? previousRecentByKey[profile.key].slice(0, 5) : [];
      console.warn(`Skipped ${profile.label} ${profile.platformLabel}: ${error.message}`);
    }
  }

  const liveWithGrace = mergeLiveStreams(live, previousSnapshot?.live || [], previousSnapshot?.checkedAt || "");
  return {
    checkedAt,
    source: "necf-redzone-cloudflare-worker",
    live: liveWithGrace,
    recentByKey
  };
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

async function fetchProfiles(env) {
  const rows = await supabaseRequest(env, "/rest/v1/profiles?select=*");
  return (Array.isArray(rows) ? rows : [])
    .filter((profile) => profile.role !== "removed")
    .filter((profile) => profile.youtube_url || profile.twitch_url);
}

async function fetchLeagueState(env) {
  try {
    const id = encodeURIComponent(env.SUPABASE_LEAGUE_STATE_ID || DEFAULT_STATUS_ID);
    const rows = await supabaseRequest(env, `/rest/v1/league_state?id=eq.${id}&select=data`);
    return rows?.[0]?.data || {};
  } catch {
    return {};
  }
}

async function saveRedzoneSnapshot(env, snapshot) {
  const id = env.REDZONE_STATUS_ID || env.SUPABASE_LEAGUE_STATE_ID || DEFAULT_STATUS_ID;
  await supabaseRequest(env, "/rest/v1/redzone_status?on_conflict=id", {
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

async function youtubeStreamsForProfile(env, profile) {
  const ref = youtubeChannelRef(profile.streamUrl);
  const channelId = ref.channelId || await resolveYoutubeChannelId(env, ref);
  let recentApiItems = [];
  let recent = [];
  if (channelId) {
    if (env.YOUTUBE_API_KEY) {
      recentApiItems = await youtubeRecentApiItems(env, channelId);
      recent = recentApiItems.map((item) => youtubeVideoFromApiItem(item, profile));
    } else {
      recent = await youtubeRecentVideos(env, channelId, profile);
    }
  }
  const live = await youtubeLiveStream(env, ref, channelId, profile, recentApiItems);
  return { live: live ? [live] : [], recent };
}

function youtubeChannelRef(value) {
  const url = safeUrl(value);
  if (!url) return { handle: "", channelId: "" };
  const parts = url.pathname.split("/").filter(Boolean);
  const handle = parts.find((part) => part.startsWith("@")) || "";
  if (parts[0] === "channel" && parts[1]) return { handle, channelId: parts[1] };
  return { handle: handle || parts[0] || "", channelId: "" };
}

async function resolveYoutubeChannelId(env, ref) {
  if (ref.channelId) return ref.channelId;
  if (env.YOUTUBE_API_KEY && ref.handle?.startsWith("@")) {
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(ref.handle)}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
    const id = data?.items?.[0]?.id;
    if (id) return id;
  }
  if (!ref.handle) return "";
  const html = await fetchText(`https://www.youtube.com/${encodeURIComponent(ref.handle).replace("%40", "@")}`);
  return matchFirst(html, /"channelId":"(UC[^"]+)"/) || matchFirst(html, /\/channel\/(UC[a-zA-Z0-9_-]+)/) || "";
}

async function youtubeRecentVideos(env, channelId, profile) {
  if (env.YOUTUBE_API_KEY) {
    const items = await youtubeRecentApiItems(env, channelId);
    return items.map((item) => youtubeVideoFromApiItem(item, profile));
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

async function youtubeRecentApiItems(env, channelId) {
  const data = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&maxResults=5&order=date&type=video&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
  return data?.items || [];
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

function youtubeVideoFromDetailsItem(item, profile) {
  return {
    id: item.id || item.etag,
    profileKey: profile.key,
    title: item.snippet?.title || "YouTube stream",
    date: item.liveStreamingDetails?.actualStartTime || item.snippet?.publishedAt || "",
    url: item.id ? `https://www.youtube.com/watch?v=${item.id}` : profile.streamUrl,
    embedUrl: item.id ? `https://www.youtube.com/embed/${item.id}` : "",
    thumbnailUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || "",
    platform: "youtube",
    platformLabel: "YouTube",
    channelLabel: profile.label
  };
}

async function youtubeLiveStream(env, ref, channelId, profile, recentApiItems = []) {
  const recentLiveMatch = recentApiItems.find((item) => /necf/i.test(item.snippet?.title || "") && item.snippet?.liveBroadcastContent === "live");
  if (recentLiveMatch?.id?.videoId) {
    return {
      ...youtubeVideoFromApiItem(recentLiveMatch, profile),
      embedUrl: `https://www.youtube.com/embed/${recentLiveMatch.id.videoId}`
    };
  }

  if (env.YOUTUBE_API_KEY && recentApiItems.length) {
    const ids = recentApiItems.map((item) => item.id?.videoId).filter(Boolean).join(",");
    if (ids) {
      try {
        const details = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
        const detailsMatch = (details?.items || []).find((item) => {
          const liveDetails = item.liveStreamingDetails || {};
          return /necf/i.test(item.snippet?.title || "") && liveDetails.actualStartTime && !liveDetails.actualEndTime;
        });
        if (detailsMatch?.id) return youtubeVideoFromDetailsItem(detailsMatch, profile);
      } catch {
        // Fall through to the channel /live page backup.
      }
    }
  }

  if (env.YOUTUBE_API_KEY && channelId) {
    try {
      const data = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&maxResults=3&type=video&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
      const match = (data?.items || []).find((item) => /necf/i.test(item.snippet?.title || ""));
      if (match?.id?.videoId) {
        return {
          ...youtubeVideoFromApiItem(match, profile),
          embedUrl: `https://www.youtube.com/embed/${match.id.videoId}`
        };
      }
    } catch {
      // Fall through to the channel /live page backup.
    }
  }

  try {
    if (!ref.handle && !channelId) return null;
    const liveUrl = ref.handle ? `https://www.youtube.com/${encodeURIComponent(ref.handle).replace("%40", "@")}/live` : `https://www.youtube.com/channel/${channelId}/live`;
    const liveHtml = await fetchText(liveUrl);
    const videoId = matchFirst(liveHtml, /"videoId":"([^"]+)"/) || matchFirst(liveHtml, /watch\?v=([a-zA-Z0-9_-]{8,})/);
    const livePageIsLive = /"isLiveNow":true/.test(liveHtml) || /"status":"LIVE"/.test(liveHtml);
    let watchHtml = "";
    if (videoId && !livePageIsLive) {
      watchHtml = await fetchText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    }
    const watchPageIsLive = watchHtml ? /"isLiveNow":true/.test(watchHtml) || /"status":"LIVE"/.test(watchHtml) : false;
    if (!livePageIsLive && !watchPageIsLive) return null;
    const html = watchHtml || liveHtml;
    const title = decodeHtml(
      matchFirst(html, /<meta property="og:title" content="([^"]+)"/) ||
      matchFirst(html, /<meta name="title" content="([^"]+)"/) ||
      matchFirst(html, /"title":"([^"]+)"/) ||
      "NECF live stream"
    );
    if (!/necf/i.test(title)) return null;
    return {
      id: videoId || liveUrl,
      profileKey: profile.key,
      title,
      date: new Date().toISOString(),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : liveUrl,
      embedUrl: videoId ? `https://www.youtube.com/embed/${videoId}?autoplay=1` : "",
      thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
      platform: "youtube",
      platformLabel: "YouTube",
      channelLabel: profile.label
    };
  } catch {
    return null;
  }
}

async function probeYoutubeLiveUrl(env, value) {
  const streamUrl = normalizeStreamUrl(value, "youtube");
  if (!streamUrl) return { ok: false, error: "Provide a YouTube channel URL in ?url=" };
  const ref = youtubeChannelRef(streamUrl);
  const channelId = ref.channelId || await resolveYoutubeChannelId(env, ref).catch(() => "");
  const liveUrl = ref.handle ? `https://www.youtube.com/${encodeURIComponent(ref.handle).replace("%40", "@")}/live` : `https://www.youtube.com/channel/${ref.channelId}/live`;
  const api = await probeYoutubeApi(env, channelId);
  try {
    const liveHtml = await fetchText(liveUrl);
    const videoId = matchFirst(liveHtml, /"videoId":"([^"]+)"/) || matchFirst(liveHtml, /watch\?v=([a-zA-Z0-9_-]{8,})/);
    const livePageTitle = decodeHtml(
      matchFirst(liveHtml, /<meta property="og:title" content="([^"]+)"/) ||
      matchFirst(liveHtml, /<meta name="title" content="([^"]+)"/) ||
      matchFirst(liveHtml, /"title":"([^"]+)"/)
    );
    const livePageIsLive = /"isLiveNow":true/.test(liveHtml) || /"status":"LIVE"/.test(liveHtml);
    let watchTitle = "";
    let watchPageIsLive = false;
    if (videoId) {
      const watchHtml = await fetchText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
      watchTitle = decodeHtml(
        matchFirst(watchHtml, /<meta property="og:title" content="([^"]+)"/) ||
        matchFirst(watchHtml, /<meta name="title" content="([^"]+)"/) ||
        matchFirst(watchHtml, /"title":"([^"]+)"/)
      );
      watchPageIsLive = /"isLiveNow":true/.test(watchHtml) || /"status":"LIVE"/.test(watchHtml);
    }
    return {
      ok: true,
      liveUrl,
      videoId,
      livePageTitle,
      livePageIsLive,
      watchTitle,
      watchPageIsLive,
      hasNecf: /necf/i.test(`${livePageTitle} ${watchTitle}`),
      api
    };
  } catch (error) {
    return { ok: false, liveUrl, error: error.message, api };
  }
}

async function probeYoutubeApi(env, channelId) {
  if (!env.YOUTUBE_API_KEY) return { ok: false, error: "No YOUTUBE_API_KEY secret configured." };
  if (!channelId) return { ok: false, error: "No channel id resolved." };
  const output = { ok: true, channelId, recent: [], details: [], liveSearch: [] };
  try {
    const recentItems = await youtubeRecentApiItems(env, channelId);
    output.recent = recentItems.map((item) => ({
      id: item.id?.videoId || "",
      title: item.snippet?.title || "",
      liveBroadcastContent: item.snippet?.liveBroadcastContent || "",
      publishedAt: item.snippet?.publishedAt || ""
    }));
    const ids = output.recent.map((item) => item.id).filter(Boolean).join(",");
    if (ids) {
      const details = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
      output.details = (details?.items || []).map((item) => ({
        id: item.id || "",
        title: item.snippet?.title || "",
        actualStartTime: item.liveStreamingDetails?.actualStartTime || "",
        actualEndTime: item.liveStreamingDetails?.actualEndTime || ""
      }));
    }
  } catch (error) {
    output.recentError = error.message;
  }
  try {
    const liveSearch = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&maxResults=5&type=video&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
    output.liveSearch = (liveSearch?.items || []).map((item) => ({
      id: item.id?.videoId || "",
      title: item.snippet?.title || "",
      liveBroadcastContent: item.snippet?.liveBroadcastContent || "",
      publishedAt: item.snippet?.publishedAt || ""
    }));
  } catch (error) {
    output.liveSearchError = error.message;
  }
  return output;
}

async function twitchStreamsForProfile(env, profile) {
  const login = twitchLoginFromUrl(profile.streamUrl);
  if (!login || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return { live: [], recent: [] };
  const token = await twitchToken(env);
  const userData = await fetchJson(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, twitchHeaders(env, token));
  const user = userData?.data?.[0];
  if (!user) return { live: [], recent: [] };

  const streamData = await fetchJson(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, twitchHeaders(env, token));
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

  const videosData = await fetchJson(`https://api.twitch.tv/helix/videos?user_id=${encodeURIComponent(user.id)}&first=5&type=archive`, twitchHeaders(env, token));
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

async function twitchToken(env) {
  const data = await fetchJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });
  return data.access_token;
}

function twitchHeaders(env, token) {
  return {
    headers: {
      "Client-ID": env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`
    }
  };
}

async function supabaseRequest(env, path, options = {}) {
  const supabaseUrl = normalizeSupabaseUrl(env.SUPABASE_URL);
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) throw new Error("Set SUPABASE_URL in wrangler.toml.");
  if (!serviceKey) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY as a Cloudflare Worker secret.");
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
  if (!response.ok) throw new Error(`Lookup failed: ${response.status}`);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Lookup failed: ${response.status}`);
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

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      ...(init.headers || {})
    }
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
