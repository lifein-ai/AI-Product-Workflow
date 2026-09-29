import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config({ path: ".env.local" });

const client = new OpenAI({
  apiKey: process.env.MODELFLARE_API_KEY,
  baseURL: process.env.MODELFLARE_BASE_URL,
});

async function main() {
  console.log("Model:", process.env.MODELFLARE_MODEL);

  const response = await client.chat.completions.create({
    model: process.env.MODELFLARE_MODEL!,
    messages: [
      {
        role: "user",
        content: "只回复：API连接成功",
      },
    ],
  });

  console.log(response.choices[0].message.content);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});