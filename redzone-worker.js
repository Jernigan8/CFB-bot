#!/usr/bin/env node

const url = process.argv[2];
if (!url) {
  console.error("Usage: node src/probe-youtube-live.js <youtube-live-url>");
  process.exit(1);
}

const response = await fetch(url, {
  redirect: "follow",
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9"
  }
});
const text = await response.text();
const match = (regex) => text.match(regex)?.[1] || "";

console.log(JSON.stringify({
  status: response.status,
  finalUrl: response.url,
  canonical: match(/<link rel="canonical" href="([^"]+)"/),
  ogUrl: match(/<meta property="og:url" content="([^"]+)"/),
  ogTitle: match(/<meta property="og:title" content="([^"]+)"/),
  metaTitle: match(/<meta name="title" content="([^"]+)"/),
  videoId: match(/"videoId":"([^"]+)"/),
  isLiveNow: /"isLiveNow":true/.test(text),
  statusLive: /"status":"LIVE"/.test(text),
  liveBroadcastContent: match(/"liveBroadcastContent":"([^"]+)"/),
  hasNecf: /NECF/i.test(text),
  titleTag: match(/<title>([^<]+)<\/title>/)
}, null, 2));
