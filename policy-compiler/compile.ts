import Anthropic from "@anthropic-ai/sdk";
import Ajv from "ajv";
import * as fs from "fs";
import * as path from "path";

const schemaPath = path.join(__dirname, "schema.json");
const promptPath = path.join(__dirname, "prompt.md");

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
const promptTemplate = fs.readFileSync(promptPath, "utf-8");

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface CompiledPolicy {
  policy_id: string;
  max_trade_pct_of_portfolio_bps: number;
  trading_hours: {
    market_open_utc_seconds: number;
    market_close_utc_seconds: number;
  };
  regulatory_basis: string[];
  raw_policy_text: string;
  ambiguity_notes?: string[];
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export async function compilePolicy(
  policyText: string,
  maxRetries = 2
): Promise<CompiledPolicy> {
  const basePrompt = promptTemplate
    .replace("{{schema_json}}", JSON.stringify(schema, null, 2))
    .replace("{{policy_text}}", policyText);

  let lastError = "";
  let userContent = basePrompt;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: userContent }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : "";
    const cleaned = stripCodeFence(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      lastError = `JSON parse failed: ${(e as Error).message}\nRaw output: ${cleaned}`;
      userContent = `${basePrompt}\n\nYour previous output was not valid JSON. Error:\n${lastError}\nReturn only valid JSON.`;
      continue;
    }

    if (!validate(parsed)) {
      lastError = `Schema validation failed: ${JSON.stringify(validate.errors)}`;
      userContent = `${basePrompt}\n\nYour previous JSON did not pass schema validation. Error:\n${lastError}\nFix it and return only valid JSON.`;
      continue;
    }

    return parsed as CompiledPolicy;
  }

  throw new Error(
    `Policy Compiler did not produce valid output after ${maxRetries + 1} attempts. Last error: ${lastError}`
  );
}

if (require.main === module) {
  const inputText = process.argv[2];
  if (!inputText) {
    console.error(
      'Usage: ANTHROPIC_API_KEY=sk-xxx npx ts-node policy-compiler/compile.ts "policy text"'
    );
    process.exit(1);
  }
  compilePolicy(inputText)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error("Compilation failed:", err.message);
      process.exit(1);
    });
}