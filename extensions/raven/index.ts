import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { ravenPlugin } from "./src/channel.js";
import { handleRavenWebhookRequest } from "./src/monitor.js";
import { setRavenRuntime } from "./src/runtime.js";

const plugin = {
  id: "raven",
  name: "Raven",
  description: "Raven (The Commit Company) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setRavenRuntime(api.runtime);
    api.registerChannel({ plugin: ravenPlugin as ChannelPlugin });
    api.registerHttpHandler(handleRavenWebhookRequest);
  },
};

export default plugin;
