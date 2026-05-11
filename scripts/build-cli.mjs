import esbuild from "esbuild";
import fs from "fs";

await esbuild.build({
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  outfile: "dist/weave.js",
});

fs.chmodSync("dist/weave.js", 0o755);
