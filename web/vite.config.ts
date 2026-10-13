import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/** Der Dev-Server braucht eine WebSocket-Verbindung (HMR); im ausgelieferten Build bleibt sie verboten. */
function devCsp(): Plugin {
  return {
    name: "substrat-dev-csp",
    apply: "serve",
    transformIndexHtml: (html) => html.replace("connect-src 'self' app:", "connect-src 'self' app: ws://localhost:* ws://127.0.0.1:*"),
  };
}

export default defineConfig({
  plugins: [solid(), devCsp()],
  base: "./",
  build: {
    outDir: "../build/web",
    emptyOutDir: true,
    target: "safari17",
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  worker: { format: "es" },
  server: { port: 5173, strictPort: true },
});
