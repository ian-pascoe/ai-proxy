// What a failed management call tells the operator: the server's own message when it sent one, otherwise the likely
// cause and the recovery.
import { Cause, Option } from "effect";
import type { AsyncResult } from "effect/reactivity";
import { ManagementError } from "#contract/errors.ts";

/** Server messages are lower-case fragments ("the control plane is unavailable"); print them as a sentence. */
const asSentence = (message: string): string => {
  const trimmed = message.trim();

  if (trimmed === "") return "The server reported an error without a message.";

  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);

  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

export const failureMessage = <A, E>(result: AsyncResult.Failure<A, E>): string => {
  const failure = Cause.findErrorOption(result.cause);

  if (Option.isSome(failure) && failure.value instanceof ManagementError) {
    return asSentence(failure.value.error);
  }

  return "The server did not answer. If your Access session expired, reload the page to sign in again.";
};
