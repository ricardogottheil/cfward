import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // @napi-rs/keyring is a native module: bundling it breaks the platform
  // binary resolution, so it stays external and is required at runtime.
  external: ["@napi-rs/keyring"],
  banner: { js: "#!/usr/bin/env node" },
});
