export default async function handler(req, res) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // ---------- CORS ----------
  if (req.method === "OPTIONS") {
    res.writeHead(200, corsHeaders);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, corsHeaders);
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  if (!process.env.WEBHOOK_SECRET) {
    res.writeHead(500, corsHeaders);
    res.end(JSON.stringify({ reply: "Server misconfigured" }));
    return;
  }

  try {
    const incoming = req.body || {};

    const userMessage = String(incoming.message || "").trim();
    const product = incoming.product || {};
    const threadId = incoming.threadId || null;

    if (!userMessage || !product.price) {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ reply: "Invalid input" }));
      return;
    }

    const basePrice = Number(product.price);
    if (isNaN(basePrice) || basePrice <= 0) {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ reply: "Invalid price" }));
      return;
    }

    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    // ---------- SIMPLE, WORKING PROMPT ----------
    const aiPrompt = `
You are HAGGLE, a playful Indian price negotiator.

Product: ${product.name}
Price: ₹${basePrice}
Floor: ₹${floorPrice}

Rules:
- INR only
- Never below floor
- No greetings
- Max 2 sentences
- JSON only

User: "${userMessage}"

Respond strictly as JSON:
{"reply":"","agreed_price":null,"action":"NONE"}
`.trim();

    // ---------- AI CALL ----------
    const aiRes = await fetch(
      "https://connect.testmyprompt.com/webhook/696b75a82abe5e63ed202cde",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          message: aiPrompt,
          threadId,
          type: "user_message",
        }),
      }
    );

    const aiText = await aiRes.text();

    // ---------- SAFE / FORGIVING PARSING ----------
    let reply = `I can offer ₹${fallbackPrice}. Want me to lock it in?`;
    let action = "NONE";
    let nextThreadId = threadId;

    try {
      const outer = JSON.parse(aiText);
      nextThreadId = outer.threadId || threadId;

      let inner = outer.response || "";
      inner = inner.replace(/```json|```/gi, "").trim();

      // extract first JSON block only
      const jsonMatch = inner.match(/\{[\s\S]*?\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.reply === "string" && parsed.reply.trim()) {
          reply = parsed.reply;
        }
        if (typeof parsed.action === "string") {
          action = parsed.action;
        }
      }
    } catch {
      // swallow parse errors intentionally
      // fallback reply already set
    }

    res.writeHead(200, corsHeaders);
    res.end(
      JSON.stringify({
        reply,
        agreed_price: null,
        action,
        threadId: nextThreadId,
      })
    );
  } catch (err) {
    res.writeHead(500, corsHeaders);
    res.end(
      JSON.stringify({
        reply: "⚠️ I'm having trouble right now. Please try again.",
      })
    );
  }
}
