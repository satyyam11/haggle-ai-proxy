export async function handler(event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // ✅ Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  // ✅ Allow only POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    console.log(
      "Webhook secret present:",
      Boolean(process.env.WEBHOOK_SECRET)
    );

    // ✅ Parse incoming body
    const incoming = event.body ? JSON.parse(event.body) : {};
    console.log("Incoming from frontend:", incoming);

    // ✅ NORMALIZE MESSAGE (THIS IS THE FIX)
    const userMessage =
      incoming.message ||
      incoming.text ||
      incoming.input ||
      incoming.prompt ||
      "";

    // ❌ If still no message, stop here
    if (!userMessage.trim()) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          reply: "No message received from frontend",
        }),
      };
    }

    // ✅ Payload AI EXPECTS
    const payload = {
      message: userMessage,
      threadId: incoming.threadId || null,
      type: "user_message",
    };

    const response = await fetch(
      "https://connect.testmyprompt.com/webhook/696a92740b82d2902a88db02",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.WEBHOOK_SECRET,
        },
        body: JSON.stringify(payload),
      }
    );

    const rawText = await response.text();
    console.log("Raw AI response:", rawText);

    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch {
      console.warn("AI returned non-JSON");
    }

    const reply =
      data.reply ||
      data.message ||
      data.output ||
      "Let me think about that 🙂";

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ reply }),
    };
  } catch (err) {
    console.error("HAGGLE ERROR:", err);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        reply: "⚠️ Sorry, I’m having trouble right now.",
      }),
    };
  }
}
