import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  // Pinned rather than left to tsdown's defaults: this build produces the
  // published package, and a pre-1.0 tool is free to change its defaults
  // between minors. `target` is deliberately absent — tsdown reads it from
  // engines.node, so the supported floor lives in one place.
  format: ["esm"],
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  deps: {
    // @napi-rs/keyring is a native module: bundling it breaks the platform
    // binary resolution, so it stays external and is required at runtime.
    neverBundle: ["@napi-rs/keyring"],
  },
});
