import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type OnboardAnswers = {
  providerType: "openai" | "anthropic";
  providerKey: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  enableTelegram: boolean;
  telegramToken?: string;
  telegramAllowFrom: string[];
  shellEnabled: boolean;
  shellFullAccess: boolean;
  installSystemdService: boolean;
  startSystemdService: boolean;
  overwritePolicyDefault: "ask";
};

function toBool(inputText: string, defaultVal: boolean): boolean {
  const t = inputText.trim().toLowerCase();
  if (!t) return defaultVal;
  if (["y", "yes", "true", "1"].includes(t)) return true;
  if (["n", "no", "false", "0"].includes(t)) return false;
  return defaultVal;
}

function splitCsv(v: string): string[] {
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function askNonEmpty(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultValue?: string
): Promise<string> {
  while (true) {
    const answer = (await rl.question(defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `)).trim();
    const value = answer || defaultValue || "";
    if (value) return value;
    // eslint-disable-next-line no-console
    console.log("Value is required. Please try again.");
  }
}

export async function runOnboardPrompts(): Promise<OnboardAnswers> {
  const rl = createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log("\nTangram AI onboard wizard\n");

    const providerTypeRaw = (
      await rl.question("Provider type (openai/anthropic) [openai]: ")
    )
      .trim()
      .toLowerCase();
    const providerType = providerTypeRaw === "anthropic" ? "anthropic" : "openai";

    const providerKey = await askNonEmpty(rl, "Provider key", providerType);
    const apiKey = await askNonEmpty(rl, "API key");

    const baseUrlRaw = (await rl.question("Base URL (optional, press Enter to skip): ")).trim();
    const defaultModelRaw = (await rl.question("Default model (optional, press Enter to skip): ")).trim();

    const enableTelegram = toBool(
      await rl.question("Enable Telegram channel? (y/N): "),
      false
    );

    let telegramToken: string | undefined;
    let telegramAllowFrom: string[] = [];
    if (enableTelegram) {
      telegramToken = await askNonEmpty(rl, "Telegram bot token");
      const allowFromRaw = await rl.question(
        "Telegram allowFrom user IDs (comma-separated, blank means allow all): "
      );
      telegramAllowFrom = splitCsv(allowFromRaw);
    }

    const shellEnabled = toBool(
      await rl.question("Enable shell tool (developer default)? (Y/n): "),
      true
    );
    const shellFullAccess = shellEnabled
      ? toBool(
          await rl.question("Enable shell fullAccess (dangerous)? (y/N): "),
          false
        )
      : false;

    const installSystemdService = toBool(
      await rl.question("Install user-level systemd service for tangram? (Y/n): "),
      true
    );
    const startSystemdService = installSystemdService
      ? toBool(
          await rl.question("Start service now after install? (Y/n): "),
          true
        )
      : false;

    return {
      providerType,
      providerKey,
      apiKey,
      baseUrl: baseUrlRaw || undefined,
      defaultModel: defaultModelRaw || undefined,
      enableTelegram,
      telegramToken,
      telegramAllowFrom,
      shellEnabled,
      shellFullAccess,
      installSystemdService,
      startSystemdService,
      overwritePolicyDefault: "ask",
    };
  } finally {
    rl.close();
  }
}
