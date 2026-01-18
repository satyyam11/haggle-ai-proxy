exports.handler = async function (event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // ---------- CORS ----------
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  if (!process.env.WEBHOOK_SECRET) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ reply: "Server misconfigured" }),
    };
  }

  try {
    // ---------- BODY ----------
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf-8")
      : event.body || "";

    const incoming = JSON.parse(rawBody);

    const userMessage = String(incoming.message || "").trim();
    const product = incoming.product || {};
    const threadId = incoming.threadId || null;

    if (!userMessage || !product.price) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid input" }),
      };
    }

    const basePrice = Number(product.price);
    if (isNaN(basePrice) || basePrice <= 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid price" }),
      };
    }

    const floorPrice = Math.round(basePrice * 0.8);
    const fallbackPrice = Math.round(basePrice * 0.9);

    // ---------- FAST PROMPT ----------
    const aiPrompt =
`You are HAGGLE, a playful Indian price negotiator.

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

Respond:
{"reply":"","agreed_price":null,"action":"NONE"}`;

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

    // ---------- SAFE PARSING ----------
    let reply = `I can offer ₹${fallbackPrice}. Want me to lock it in?`;
    let action = "NONE";
    let nextThreadId = threadId;

    try {
      const outer = JSON.parse(aiText);
      nextThreadId = outer.threadId || threadId;

      let inner = outer.response || "";
      inner = inner.replace(/```json|```/gi, "").trim();

      const jsonMatch = inner.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.reply) reply = parsed.reply;
        if (parsed.action) action = parsed.action;
      }
    } catch (_) {
      // fallback already set
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        reply,
        agreed_price: null,
        action,
        threadId: nextThreadId,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        reply: "⚠️ I'm having trouble right now. Please try again.",
      }),
    };
  }
};
