// Wrangler's default module rules ship `*.bin` files as `Data` modules (an `ArrayBuffer`, no JavaScript to parse).
declare module "*.bin" {
  const data: ArrayBuffer
  export default data
}
