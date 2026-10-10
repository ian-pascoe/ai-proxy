/** Go source: internal/translator/common/devin_tools.go. */

const EXEC_TARGET = "returning output or a session ID for ongoing interaction";

const EXEC_OBFUSCATED = "returning output or an session ID for ongoing interaction";

const STDIN_TARGET =
  "Writes characters to an existing unified exec session and returns recent output.";

const STDIN_OBFUSCATED =
  "Writes characters to a existing unified exec session and returns recent output.";

const equalFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `IsDevinCodexAppAutomationUpdate`: the `automation_update` method of the `mcp__codex_app` namespace. */
export const isDevinCodexAppAutomationUpdate = (namespace: string, toolName: string): boolean => {
  const cleanNamespace = namespace.trim();
  const cleanTool = toolName.trim();

  if (equalFold(cleanNamespace, "mcp__codex_app") && equalFold(cleanTool, "automation_update"))
    return true;

  return equalFold(cleanTool, "mcp__codex_app__automation_update");
};

export const obfuscateExecCommandDescription = (desc: string): string => {
  if (desc.includes(EXEC_OBFUSCATED)) return desc;

  if (desc.includes(EXEC_TARGET)) return desc.replaceAll(EXEC_TARGET, EXEC_OBFUSCATED);

  return desc.replace(
    /returning output or a session ID for ongoing interaction/gi,
    EXEC_OBFUSCATED,
  );
};

export const obfuscateWriteStdinDescription = (desc: string): string => {
  if (desc.includes(STDIN_OBFUSCATED)) return desc;

  if (desc.includes(STDIN_TARGET)) return desc.replaceAll(STDIN_TARGET, STDIN_OBFUSCATED);

  return desc.replace(
    /Writes characters to an existing unified exec session and returns recent output(\.?)/gi,
    "Writes characters to a existing unified exec session and returns recent output$1",
  );
};

/** `SanitizeDevinToolDescription`. */
export const sanitizeDevinToolDescription = (toolName: string, desc: string): string => {
  if (desc === "") return desc;
  const cleanTool = toolName.trim().toLowerCase();
  let out = desc;

  if (cleanTool === "exec_command" || cleanTool.endsWith("__exec_command"))
    out = obfuscateExecCommandDescription(out);

  if (cleanTool === "write_stdin" || cleanTool.endsWith("__write_stdin"))
    out = obfuscateWriteStdinDescription(out);

  return out;
};
