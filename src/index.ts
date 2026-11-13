import { Plugin } from "@opencode/plugin";
import { registerTools } from "./tools.ts";

export { registerTools } from "./tools.ts";

export default Plugin.define({ id: "hffmnnj.runes", setup: registerTools });
