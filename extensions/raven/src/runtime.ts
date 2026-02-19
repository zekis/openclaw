import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setRavenRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getRavenRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Raven runtime not initialized");
  }
  return runtime;
}
