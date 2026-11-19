// Cloudflare Pages Function: POST /api/translate
// Sends OCR text to GonkaRouter and returns a natural Burmese translation.
// The API key is read from the secret GONKA_API_KEY and never reaches the browser.

interface Env {
  GONKA_API_KEY?: string;
  GONKA_MODEL?: string;
}

const API_URL = "https://api.gonkarouter.io/v1/chat/completions";
const DEFAULT_MODEL = "zai-org/GLM-5.3-Flash";
const MAX_CHARS = 4000;

const LANG_NAMES: Record<string, string> = {
  auto: "the original language (detect it)",
  eng: "English",
  jpn: "Japanese",
  kor: "Korean",
  chi_sim: "Chinese",
  mya: "Burmese",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.GONKA_API_KEY) {
    return json({ error: "server_not_configured", message: "GONKA_API_KEY secret မသတ်မှတ်ရသေးပါ" }, 500);
  }

  let payload: { text?: unknown; from?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad_request", message: "JSON မမှန်ပါ" }, 400);
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return json({ error: "empty", message: "ဘာသာပြန်စရာ စာသား မရှိပါ" }, 400);
  if (text.length > MAX_CHARS) {
    return json({ error: "too_long", message: `စာသားရှည်လွန်းသည် (အများဆုံး ${MAX_CHARS} လုံး)` }, 413);
  }

  const from = typeof payload.from === "string" && payload.from in LANG_NAMES ? payload.from : "auto";

  const system =
    "You are a professional comic (manga, manhwa, manhua) translator into natural, spoken Burmese (Myanmar language, Unicode). " +
    "The input is raw OCR text from one comic page and may contain recognition errors, broken lines and several speech bubbles. " +
    "Rules: translate meaning and tone, not word for word; keep dialogue sounding like real people talking; " +
    "keep character names, place names and honorifics in their original form or a common Burmese transliteration; " +
    "briefly render sound effects; fix obvious OCR mistakes using context; keep the original bubble order, one bubble per line. " +
    "Output ONLY the Burmese translation, with no explanations, notes or quotation marks.";

  let upstream: Response;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.GONKA_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.GONKA_MODEL || DEFAULT_MODEL,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Source language: ${LANG_NAMES[from]}\n\n${text}` },
        ],
      }),
    });
  } catch {
    return json({ error: "upstream_unreachable", message: "AI server ကို ချိတ်မရပါ" }, 502);
  }

  if (!upstream.ok) {
    return json({ error: "upstream_error", status: upstream.status, message: `AI server အမှား (${upstream.status})` }, 502);
  }

  const data = (await upstream.json().catch(() => null)) as
    | { choices?: { message?: { content?: string } }[] }
    | null;
  const translation = data?.choices?.[0]?.message?.content?.trim();
  if (!translation) return json({ error: "empty_response", message: "AI က အဖြေ မပြန်ပါ" }, 502);

  return json({ translation });
};

export const onRequest = () => json({ error: "method_not_allowed" }, 405);
