export async function handler(event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // ---------- CORS ----------
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
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
    // ---------- BODY PARSING (NETLIFY-SAFE) ----------
    let rawBody = "";

    if (typeof event.body === "string" && event.body.length > 0) {
      if (event.isBase64Encoded) {
        try {
          rawBody = Buffer.from(event.body, "base64").toString("utf-8");
        } catch (e) {
          console.error("Base64 decode failed", e);
          throw new Error("Invalid base64 body");
        }
      } else {
        rawBody = event.body;
      }
    }

    if (!rawBody) {
      console.warn("Empty request body received");
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          reply: "No request body received",
        }),
      };
    }

    let incoming;
    try {
      incoming = JSON.parse(rawBody);
    } catch (e) {
      console.error("JSON parse failed:", rawBody);
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          reply: "Invalid JSON payload",
        }),
      };
    }

    console.log("Incoming payload:", incoming);

    // ---------- MESSAGE NORMALIZATION ----------
    const userMessage =
      incoming.message ??
      incoming.text ??
      incoming.input ??
      incoming.prompt ??
      "";

    if (typeof userMessage !== "string" || !userMessage.trim()) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          reply: "Message field is required",
        }),
      };
    }

    // ---------- AI PAYLOAD ----------
    const aiPayload = {
      message: userMessage.trim(),
      threadId: incoming.threadId ?? null,
      type: "user_message",
    };

    // ---------- AI CALL ----------
    const aiResponse = await fetch(
      "https://connect.testmyprompt.com/webhook/696a92740b82d2902a88db02",
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
    console.log("Raw AI response:", aiText);

    let aiData = {};
    try {
      aiData = JSON.parse(aiText);
    } catch {
      console.warn("AI returned non-JSON");
    }

    const reply =
      aiData.reply ??
      aiData.response ??
      aiData.message ??
      aiData.output ??
      null;

    if (!reply) {
      console.error("AI response missing reply field");
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          reply: "AI did not return a valid response",
        }),
      };
    }

    // ---------- SUCCESS ----------
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ reply }),
    };
  } catch (err) {
    console.error("HAGGLE FATAL ERROR:", err);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        reply: "Internal server error",
      }),
    };
  }
}
