export function redact(value) {
  if (value === undefined || value === null) return value;

  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token": "[REDACTED]"');
  text = text.replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token": "[REDACTED]"');
  text = text.replace(/"accessToken"\s*:\s*"[^"]+"/gi, '"accessToken": "[REDACTED]"');
  text = text.replace(/"sessionKey"\s*:\s*"[^"]+"/gi, '"sessionKey": "[REDACTED]"');
  text = text.replace(/"code"\s*:\s*"[^"]+"/gi, '"code": "[REDACTED]"');
  text = text.replace(/"eadpClientSecret"\s*:\s*"[^"]+"/gi, '"eadpClientSecret": "[REDACTED]"');
  text = text.replace(/([?&]code=)[^&\s"]+/gi, "$1[REDACTED]");
  text = text.replace(/([?&]access_token=)[^&\s"]+/gi, "$1[REDACTED]");
  text = text.replace(/([?&]client_secret=)[^&\s"]+/gi, "$1[REDACTED]");

  return text;
}

export function previewBody(text, maxLength = 2500) {
  const redacted = redact(text);
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}\n...[truncated ${redacted.length - maxLength} chars]`;
}
