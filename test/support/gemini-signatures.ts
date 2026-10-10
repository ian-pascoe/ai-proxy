// Builds a structurally valid Gemini thought signature (field 2 wrapping one field-1 record that starts with the
// Tink prefix byte), which the replay policy accepts as provider-native.
export const sig = (payload = "cipher-text-bytes"): string => {
  const inner = new Uint8Array([
    0x01,
    0x0c,
    0x39,
    0xd6,
    0xc7,
    ...new TextEncoder().encode(payload),
  ]);
  const container = new Uint8Array([0x0a, inner.length, ...inner]);
  const outer = new Uint8Array([0x12, container.length, ...container]);
  let binary = "";

  for (const byte of outer) binary += String.fromCharCode(byte);

  return btoa(binary);
};
