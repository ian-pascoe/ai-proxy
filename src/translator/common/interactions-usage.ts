/** Go source: internal/translator/common/interactions_usage.go. */
import { get, type Json } from "../../json/index.ts";

const PATHS = [
  "interaction.usage",
  "usage",
  "metadata.total_usage",
  "metadata.usage",
  "interaction.metadata.total_usage",
  "interaction.metadata.usage",
];

/** The first existing usage object of an Interactions payload, or `undefined`. */
export const interactionsUsage = (root: Json | undefined): Json | undefined => {
  for (const path of PATHS) {
    const value = get(root, path);

    if (value !== undefined) return value;
  }

  return undefined;
};
