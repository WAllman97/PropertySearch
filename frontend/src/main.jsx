import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./App.css";
import { isNativeApp } from "./lib/platform";

// Phone-app-only styles (safe areas, no hover effects) key off this class.
if (isNativeApp) document.documentElement.classList.add("native-app");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);