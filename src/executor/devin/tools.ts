/**
 * Devin tool naming/description rules.
 *
 * Go source: internal/translator/common/devin_tools.go (IsDevinCodexAppAutomationUpdate, ObfuscateExecCommandDescription,
 * ObfuscateWriteStdinDescription, SanitizeDevinToolDescription), internal/runtime/executor/helps/devin_wire.go (the
 * `task_id` -> `taskId` description rewrite).
 */

/** `IsDevinCodexAppAutomationUpdate`: the Codex desktop `automation_update` tool is never sent to Devin. */
export const isCodexAppAutomationUpdate = (namespace: string, toolName: string): boolean => {
  const ns = namespace.trim().toLowerCase()
  const tool = toolName.trim().toLowerCase()

  return (ns === "mcp__codex_app" && tool === "automation_update") || tool === "mcp__codex_app__automation_update"
}

const EXEC_TARGET = "returning output or a session ID for ongoing interaction"

const EXEC_OBFUSCATED = "returning output or an session ID for ongoing interaction"

const STDIN_TARGET = "Writes characters to an existing unified exec session and returns recent output."

const STDIN_OBFUSCATED = "Writes characters to a existing unified exec session and returns recent output."

const obfuscateExecCommand = (desc: string): string => {
  if (desc.includes(EXEC_OBFUSCATED)) return desc

  if (desc.includes(EXEC_TARGET)) return desc.replaceAll(EXEC_TARGET, EXEC_OBFUSCATED)

  return desc.replace(/returning output or a session ID for ongoing interaction/gi, EXEC_OBFUSCATED)
}

const obfuscateWriteStdin = (desc: string): string => {
  if (desc.includes(STDIN_OBFUSCATED)) return desc

  if (desc.includes(STDIN_TARGET)) return desc.replaceAll(STDIN_TARGET, STDIN_OBFUSCATED)

  return desc.replace(
    /Writes characters to an existing unified exec session and returns recent output(\.?)/gi,
    "Writes characters to a existing unified exec session and returns recent output$1"
  )
}

/** `SanitizeDevinToolDescription`. */
export const sanitizeDevinToolDescription = (toolName: string, description: string): string => {
  if (description === "") return description
  const tool = toolName.trim().toLowerCase()
  let desc = description

  if (tool === "exec_command" || tool.endsWith("__exec_command")) desc = obfuscateExecCommand(desc)

  if (tool === "write_stdin" || tool.endsWith("__write_stdin")) desc = obfuscateWriteStdin(desc)

  return desc
}

const TASK_ID_PHRASE = "Takes a task_id parameter identifying the task"

/** The wire description: Claude Code's `task_id` becomes the `taskId` Devin's tool environment expects. */
export const devinWireToolDescription = (toolName: string, description: string): string =>
  sanitizeDevinToolDescription(
    toolName,
    description.includes(TASK_ID_PHRASE)
      ? description.replaceAll(TASK_ID_PHRASE, "Takes a taskId parameter identifying the task")
      : description
  )
