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
    let rawBody = "";
    if (typeof event.body === "string" && event.body.length > 0) {
      rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf-8")
        : event.body;
    }

    if (!rawBody) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "No request body received" }),
      };
    }

    let incoming;
    try {
      incoming = JSON.parse(rawBody);
    } catch {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid JSON payload" }),
      };
    }

    console.log("========== INCOMING FRONTEND PAYLOAD ==========");
    console.log(JSON.stringify(incoming, null, 2));
    console.log("==============================================");

    // ---------- USER MESSAGE ----------
    const userMessage =
      incoming.message ??
      incoming.text ??
      incoming.input ??
      "";

    if (!userMessage || typeof userMessage !== "string") {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Message field is required" }),
      };
    }

    // ---------- PRODUCT & PRICE LOGIC ----------
    const productName = incoming.product?.name ?? "this product";
    const basePrice = Number(incoming.product?.price);

    if (!basePrice || isNaN(basePrice)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ reply: "Invalid product price" }),
      };
    }

    const floorPrice = Math.round(basePrice * 0.8); // 20% max discount

    // ---------- AI MESSAGE (FINAL PRODUCTION PROMPT) ----------
    const aiMessage = `
You are HAGGLE, a playful but professional price negotiator for an Indian e-commerce brand.

You are negotiating for the following product (DO NOT CHANGE THESE DETAILS):
- Product name: ${productName}
- Current selling price: ₹${basePrice} INR
- Maximum allowed discount: 20%
- Absolute floor price: ₹${floorPrice} INR

IMPORTANT RULES (NON-NEGOTIABLE):
- Currency is INR only. Never use USD or $.
- Never invent a different product or price.
- Never offer or accept anything below ₹${floorPrice}.
- If the user agrees to a price, STOP negotiating immediately.
- Do NOT reintroduce yourself again.

NEGOTIATION STRATEGY:
- Always ask for the user's offer first.
- Never start by discounting yourself.
- Counter offers must follow this order:
  10% → 15% → 17% → 20% (floor)
- Do NOT jump steps.
- Prefer closing at the highest accepted price.
- Always ask: “Should I lock this price for you?”

User message:
"${userMessage}"

Respond ONLY in valid JSON:
{
  "reply": "<what you say to the customer>",
  "agreed_price": <number or null>,
  "action": "NONE" | "ADD_TO_CART"
}
`.trim();

    const aiPayload = {
      message: aiMessage,
      threadId: incoming.threadId ?? null,
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

let aiData = {};
let cleanedText = aiText;

// 🔥 Strip markdown code fences if AI wraps JSON
cleanedText = cleanedText
  .replace(/```json/gi, "")
  .replace(/```/g, "")
  .trim();

try {
  aiData = JSON.parse(cleanedText);
} catch (err) {
  console.error("Failed to parse AI JSON:", cleanedText);
  return {
    statusCode: 502,
    headers: corsHeaders,
    body: JSON.stringify({
      reply: "AI returned invalid response",
    }),
  };
}


    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        reply: aiData.reply ?? "Sorry, please try again.",
        agreed_price: aiData.agreed_price ?? null,
        action: aiData.action ?? "NONE",
        threadId: aiData.threadId ?? incoming.threadId ?? null,
      }),
    };
  } catch (err) {
    console.error("HAGGLE ERROR:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ reply: "Internal server error" }),
    };
  }
}
