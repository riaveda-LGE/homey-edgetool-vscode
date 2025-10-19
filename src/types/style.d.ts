// Allow importing plain CSS files in TS/TSX (webpack handles them)
declare module '*.css' {
  const css: string;
  export default css;
}
