import { render } from "solid-js/web";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/editor.css";
import "./styles/database.css";
import "./styles/graph.css";
import { App } from "./components/App";

render(() => <App />, document.getElementById("root")!);

// Automatischer Oberflächentest (nur wenn die native App ihn anfordert)
if (import.meta.env.VITE_SELFTEST && (window as any).__substratSelftest) void import("./selftest").then((m) => m.runSelftest());
