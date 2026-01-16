export async function handler(event) {
  try {
    const body = JSON.parse(event.body);

    const response = await fetch(
      "https://connect.testmyprompt.com/webhook/696a92740b82d2902a88db02",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret":
            "d7e36c27f9df5507aea77393dac4d36b14c5ab03e07b80b7fb606547ad59ed4d"
        },
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ error: "Proxy error" })
    };
  }
}
