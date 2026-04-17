import { GlobalWindow } from "happy-dom";

const w = new GlobalWindow({ url: "http://localhost/" });

(globalThis as any).window = w;
(globalThis as any).self = w;
(globalThis as any).document = w.document;
(globalThis as any).navigator = w.navigator;
(globalThis as any).HTMLElement = w.HTMLElement;
(globalThis as any).HTMLDivElement = w.HTMLDivElement;
(globalThis as any).Node = w.Node;
(globalThis as any).MouseEvent = w.MouseEvent;

Object.defineProperty(w.navigator, "clipboard", {
  value: {},
  writable: true,
  configurable: true,
});
