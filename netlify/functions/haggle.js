export async function handler(event) {
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

  // ---------- ENV CHECK ----------
  if (!process.env.WEBHOOK_SECRET) {
    console.error("WEBHOOK_SECRET missing");
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ reply: "Server misconfigured" }),
    };
  }

  try {
    // ---------- BODY PARSING ----------
    let incoming;
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf-8")
        : event.body;
      incoming = JSON.parse(raw);
    } catch {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid request payload" }),
      };
    }

    console.log("========== INCOMING FRONTEND PAYLOAD ==========");
    console.log(JSON.stringify(incoming, null, 2));
    console.log("==============================================");

    const userMessage = incoming.message;
    const product = incoming.product;
    let threadId = incoming.threadId || null;

    if (!userMessage || !product?.name || !product?.price) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Missing required fields" }),
      };
    }

    const basePrice = Number(product.price);
    if (isNaN(basePrice)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid product price" }),
      };
    }

    const floorPrice = Math.round(basePrice * 0.8);
    const safeFallbackPrice = Math.round(basePrice * 0.9);

    // ---------- SHORT, FAST PROMPT (PHASE-1) ----------
    const aiPrompt = `
You are HAGGLE, an Indian e-commerce price negotiator.

Product: ${product.name}
Price: ₹${basePrice}
Floor price: ₹${floorPrice}

Rules:
- Currency INR only
- Never go below floor
- Do NOT greet
- Respond ONLY in JSON

User says: "${userMessage}"

Return JSON only:
{
  "reply": "<message>",
  "agreed_price": <number|null>,
  "action": "NONE" | "ADD_TO_CART"
}
`.trim();

    const aiPayload = {
      message: aiPrompt,
      threadId,
      type: "user_message",
    };

    console.log("========== AI REQUEST PAYLOAD ==========");
    console.log(JSON.stringify(aiPayload, null, 2));
    console.log("========================================");

    // ---------- AI CALL ----------
    const aiResponse = await fetch(
      "https://connect.testmyprompt.com/webhook/696b75a82abe5e63ed202cde",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.WEBHOOK_SECRET,
        },
        body: JSON.stringify(aiPayload),
      }
    );

    const aiText = await aiResponse.text();

    console.log("========== RAW AI RESPONSE ==========");
    console.log(aiText);
    console.log("====================================");

    // ---------- SAFE PARSING + FALLBACK ----------
    let reply = `I can offer ₹${safeFallbackPrice}. Would you like me to lock it in?`;
    let agreed_price = null;
    let action = "NONE";

    try {
      const outer = JSON.parse(aiText);
      let inner = outer.response || outer.reply || "";

      inner = inner
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const match = inner.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        reply = parsed.reply || reply;
        agreed_price = parsed.agreed_price ?? null;
        action = parsed.action || "NONE";
      }

      threadId = outer.threadId || threadId;

    } catch (err) {
      console.error("AI parse failed — using fallback");
      console.error(err);
    }

    // ---------- RESPONSE ----------
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        reply,
        agreed_price,
        action,
        threadId,
      }),
    };

  } catch (err) {
    console.error("HAGGLE ERROR:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        reply: "Something went wrong. Let’s try again.",
      }),
    };
  }
}
