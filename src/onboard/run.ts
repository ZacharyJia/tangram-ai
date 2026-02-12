import { ensureOnboardDirs, getDefaultOnboardPaths, writeOnboardFiles } from "./files.js";
import { runOnboardPrompts } from "./prompts.js";
import {
  buildConfigJson,
  buildCronStoreTemplate,
  buildHeartbeatTemplate,
  buildSkillsReadmeTemplate,
} from "./templates.js";
import { installService } from "../deploy/systemdUser.js";

export async function runOnboard(): Promise<void> {
  const answers = await runOnboardPrompts();
  const paths = getDefaultOnboardPaths();

  await ensureOnboardDirs(paths);

  const files = [
    { filePath: paths.configPath, content: buildConfigJson(answers) },
    { filePath: paths.heartbeatPath, content: buildHeartbeatTemplate() },
    { filePath: paths.cronStorePath, content: buildCronStoreTemplate() + "\n" },
    { filePath: paths.skillsReadmePath, content: buildSkillsReadmeTemplate() + "\n" },
  ];

  const results = await writeOnboardFiles(files);

  let serviceMessage: string | undefined;
  if (answers.installSystemdService) {
    const result = await installService({ start: answers.startSystemdService });
    serviceMessage = result.started
      ? `systemd service installed and started (${result.serviceFile})`
      : `systemd service installed (${result.serviceFile}), not started`;
  }

  // eslint-disable-next-line no-console
  console.log("\nOnboard completed.\n");
  for (const r of results) {
    if (r.action === "backed_up_and_overwritten") {
      // eslint-disable-next-line no-console
      console.log(`- ${r.action}: ${r.filePath} (backup: ${r.backupPath})`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`- ${r.action}: ${r.filePath}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log("\nNext steps:");
  if (serviceMessage) {
    // eslint-disable-next-line no-console
    console.log(`- ${serviceMessage}`);
    // eslint-disable-next-line no-console
    console.log("- Check: tangram gateway status");
  } else {
    // eslint-disable-next-line no-console
    console.log("- Run: tangram gateway --verbose");
  }
}
