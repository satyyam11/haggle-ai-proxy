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

    const floorPrice = Math.round(basePrice * 0.8);

    // ---------- AI PROMPT ----------
    const aiMessage = `
You are HAGGLE, a playful but professional price negotiator for an Indian e-commerce brand.

You are negotiating for:
- Product name: ${productName}
- Current selling price: ₹${basePrice} INR
- Absolute floor price: ₹${floorPrice} INR (20% max discount)

STRICT RULES:
- Currency is INR only.
- Never invent another product or price.
- Never go below ₹${floorPrice}.
- Do NOT greet again.
- Stop negotiating once user agrees.

DISCOUNT STEPS:
10% → 15% → 17% → 20% (final)

User message:
"${userMessage}"

Respond ONLY in valid JSON:
{
  "reply": "<message>",
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

    // ---------- ✅ CORRECT AI PARSING ----------
    let aiData;

    try {
      // 1️⃣ Parse outer wrapper
      const outer = JSON.parse(aiText);

      let inner = outer.response || outer.reply || outer.message;

      if (!inner) {
        throw new Error("Missing AI inner response");
      }

      // 2️⃣ Remove markdown
      inner = inner
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      // 3️⃣ Parse inner JSON
      aiData = JSON.parse(inner);

    } catch (err) {
      console.error("AI JSON parsing failed:", err);
      console.error("RAW AI:", aiText);
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          reply: "Sorry, please try again.",
          agreed_price: null,
          action: "NONE",
        }),
      };
    }

    // ---------- SUCCESS ----------
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        reply: aiData.reply,
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
