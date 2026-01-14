/// <reference types="vite/client" />

// Declare module for Vite's ?url import syntax
declare module "*?url" {
  const content: string;
  export default content;
}

// Specific declaration for pdfjs-dist worker
declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
  const content: string;
  export default content;
}
