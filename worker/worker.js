// Cloudflare Worker: a tiny proxy that keeps your Anthropic API key secret.
// The browser app sends requests here; this Worker attaches the key and
// forwards them to Anthropic, then returns the response.
//
// Secrets/vars (set in the Cloudflare dashboard or via wrangler):
//   ANTHROPIC_API_KEY  (secret, required)
//   ALLOWED_ORIGIN     (optional but recommended, e.g. https://yourname.github.io)

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowed === "*" ? "*" : allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: { message: "POST only" } }), {
        status: 405,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (allowed !== "*" && origin !== allowed) {
      return new Response(JSON.stringify({ error: { message: "Origin not allowed" } }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: { message: "Worker is missing the ANTHROPIC_API_KEY secret" } }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const body = await request.text();
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
