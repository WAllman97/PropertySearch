import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./App.css";
import { isNativeApp } from "./lib/platform";
import { listenForNotificationTaps } from "./lib/push";

// Phone-app-only styles (safe areas, no hover effects) key off this class.
if (isNativeApp) document.documentElement.classList.add("native-app");

// Before rendering, so a notification tap that launched the app is caught.
listenForNotificationTaps();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);