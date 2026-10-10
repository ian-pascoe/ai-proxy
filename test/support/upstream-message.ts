// Constructors for the upstream WebSocket frames (`UpstreamMessage` is a plain tagged union without constructors).
import { Data } from "effect";

type Frame = Data.TaggedEnum<{
  text: { readonly data: string };
  binary: {};
  close: { readonly code: number; readonly reason: string };
  error: { readonly message: string };
}>;

export const Frames = Data.taggedEnum<Frame>();
