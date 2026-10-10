/**
 * Claude structured-output instruction (system reminder helpers live in claude-messages.ts).
 *
 * Go source: internal/translator/common/claude_system.go, internal/util/claude_attribution.go.
 */
import { get, type Json } from "../../json/index.ts"
import { exists, str } from "./gjson.ts"

const JSON_ONLY_SUFFIX =
  "Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object."

/** `BuildClaudeStructuredOutputInstruction` for OpenAI `response_format`. */
export const buildClaudeStructuredOutputInstruction = (format: Json | undefined): string => {
  if (!exists(format)) return ""
  const formatType = str(get(format, "type")).trim().toLowerCase()

  switch (formatType) {
    case "json_object":
      return `You must format your entire response as a valid JSON object. ${JSON_ONLY_SUFFIX}`
    case "json_schema": {
      const jsonSchema = get(format, "json_schema")
      let schema = get(jsonSchema, "schema")

      if (!exists(schema)) schema = get(format, "schema")

      if (!exists(schema)) return `You must format your entire response as a valid JSON object. ${JSON_ONLY_SUFFIX}`

      let out =
        "You must format your entire response as valid JSON that conforms strictly to the following JSON schema:\n"

      const name = str(get(jsonSchema, "name")).trim() || str(get(format, "name")).trim()

      if (name !== "") out += `Schema Name: ${name}\n`
      const desc = str(get(jsonSchema, "description")).trim() || str(get(format, "description")).trim()

      if (desc !== "") out += `Schema Description: ${desc}\n`
      out += `JSON Schema:\n${JSON.stringify(schema)}\n${JSON_ONLY_SUFFIX}`

      return out
    }

    default:
      return ""
  }
}
