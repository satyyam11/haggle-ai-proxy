export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: "Method Not Allowed"
      };
    }

    const incoming = JSON.parse(event.body);

    // BuildMyPrompt expects THIS shape
    const payload = {
      message: incoming.message,
      threadId: incoming.threadId || null,
      type: "user_message"
    };

    const response = await fetch(
      "https://connect.testmyprompt.com/webhook/696a92740b82d2902a88db02",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": process.env.WEBHOOK_SECRET
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    // Normalize reply for frontend
    const reply =
      data.reply ||
      data.message ||
      data.output ||
      "Let me think about that 🙂";

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: JSON.stringify({ reply })
    };
  } catch (err) {
    console.error("HAGGLE ERROR:", err);

    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        reply: "⚠️ Sorry, I’m having trouble right now."
      })
    };
  }
}
