const fetch = require("node-fetch");

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
      body: JSON.stringify({ reply: "Method Not Allowed" }),
    };
  }

  if (!process.env.WEBHOOK_SECRET) {
    console.error("❌ WEBHOOK_SECRET missing");
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ reply: "Server misconfigured" }),
    };
  }

  try {
    // ---------- BODY ----------
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf-8")
      : event.body;

    const incoming = JSON.parse(rawBody);

    console.log("========== INCOMING FRONTEND PAYLOAD ==========");
    console.log(JSON.stringify(incoming, null, 2));
    console.log("==============================================");

    const userMessage = incoming.message;
    const product = incoming.product;
    let threadId = incoming.threadId || null;

    if (!userMessage || !product || !product.price) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid input" }),
      };
    }

    const basePrice = Number(product.price);
    const floorPrice = Math.round(basePrice * 0.8); // 20% max
    const fallbackPrice = Math.round(basePrice * 0.9); // 10%

    // ---------- FAST + SAFE PROMPT ----------
    const aiPrompt = `
You are HAGGLE — a playful Indian price negotiator.

Product: ${product.name}
Price: ₹${basePrice}
Floor: ₹${floorPrice}

Rules:
- INR only
- Never below floor
- No greetings
- Max 2 short sentences
- JSON only

User: "${userMessage}"

Reply ONLY as JSON:
{
  "reply": "",
  "agreed_price": null,
  "action": "NONE"
}
`.trim();

    console.log("========== AI REQUEST PAYLOAD ==========");
    console.log(JSON.stringify({ message: aiPrompt, threadId }, null, 2));
    console.log("=======================================");

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
          threadId: threadId,
          type: "user_message",
        }),
      }
    );

    const aiText = await aiRes.text();

    console.log("========== RAW AI RESPONSE ==========");
    console.log(aiText);
    console.log("====================================");

    // ---------- PARSE AI ----------
    let reply = `I can offer ₹${fallbackPrice}. Want me to lock it in?`;
    let action = "NONE";

    try {
      const outer = JSON.parse(aiText);
      let inner = outer.response || "";

      inner = inner.replace(/```json|```/g, "").trim();
      const match = inner.match(/\{[\s\S]*\}/);

      if (match) {
        const parsed = JSON.parse(match[0]);
        reply = parsed.reply || reply;
        action = parsed.action || "NONE";
      }

      threadId = outer.threadId || threadId;
    } catch (err) {
      console.error("⚠️ AI PARSE FAILED, USING FALLBACK");
    }

    // ---------- FINAL ----------
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        reply,
        agreed_price: null,
        action,
        threadId,
      }),
    };

  } catch (err) {
    console.error("🔥 HAGGLE FATAL ERROR:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        reply: "I’m having trouble right now. Please try again.",
      }),
    };
  }
};
