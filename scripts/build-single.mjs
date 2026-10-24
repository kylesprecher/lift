// Bundle the app into one self-contained HTML file (inline CSS + JS) that
// can be opened straight from disk or published as a claude.ai Artifact.
//
//   node scripts/build-single.mjs              -> dist/lift.html (full document)
//   node scripts/build-single.mjs --artifact   -> dist/lift.artifact.html
//                                                 (body content only; the
//                                                 Artifact host adds the
//                                                 doctype/head/body skeleton)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const artifact = process.argv.includes("--artifact");

// Dependency order: each module only imports modules listed before it.
const MODULES = ["seed", "logic", "store", "charts", "cloud", "app"];

function bundle() {
  const parts = [];
  for (const name of MODULES) {
    let src = read(`js/${name}.js`);
    // `import * as X from "./mod.js"` / `import { a, b } from "./mod.js"`
    src = src.replace(/^import \* as (\w+) from "\.\/(\w+)\.js";$/gm, "const $1 = __$2;");
    src = src.replace(/^import \{([^}]+)\} from "\.\/(\w+)\.js";$/gm, "const {$1} = __$2;");
    if (/^import /m.test(src)) throw new Error(`Unsupported import in js/${name}.js`);
    const exported = [...src.matchAll(/^export (?:async )?(?:function|const|let) (\w+)/gm)].map((m) => m[1]);
    src = src.replace(/^export /gm, "");
    parts.push(`const __${name} = (() => {\n${src}\nreturn { ${exported.join(", ")} };\n})();`);
  }
  // Keep a literal "</script" in the code from ending the inline script.
  return parts.join("\n\n").replace(/<\/script/gi, "<\\/script");
}

const html = read("index.html");
const body = html
  .slice(html.indexOf("<body>") + 6, html.indexOf("</body>"))
  .replace(/\s*<script type="module" src="js\/app.js"><\/script>/, "");
const css = read("css/styles.css");
const script = `<script type="module">\n${bundle()}\n</script>`;

const head = `<title>Lift</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Track workouts, sets, reps and progress against your training program.">`;

const out = artifact
  ? `${head}\n<style>\n${css}\n</style>\n${body}\n${script}\n`
  : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
<style>
${css}
</style>
</head>
<body>
${body}
${script}
</body>
</html>
`;

mkdirSync(join(root, "dist"), { recursive: true });
const file = join(root, "dist", artifact ? "lift.artifact.html" : "lift.html");
writeFileSync(file, out);
console.log(`Wrote ${file} (${(out.length / 1024).toFixed(0)} KB)`);
