/**
 * Workers Logs integration: Effect logs become one structured object per `console.log` call (`level`, `message`,
 * `timestamp`, `annotations`, `fiberId`, `cause`), which Workers Logs indexes field by field. Log with
 * `Effect.logInfo(...)` plus `Effect.annotateLogs({...})` using plain, non-secret data only (see platform/logging.ts).
 */
import { Logger } from "effect"

export const WorkersLoggerLayer = Logger.layer([Logger.consoleStructured])
