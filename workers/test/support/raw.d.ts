// Vite `?raw` imports (used to load large generated JSON fixtures without TypeScript inferring their shape).
declare module "*.json?raw" {
  const content: string
  export default content
}
