// `*.bin` imports are bundled as Workers `Data` modules (an `ArrayBuffer`, no JavaScript to parse): Alchemy and the
// vitest config (`modulesRules`) both apply that rule.
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
