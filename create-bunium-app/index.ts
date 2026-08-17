#!/usr/bin/env bun
// create-bunium-app: minimal scaffolding CLI.
//
// All 6 planned combinations exist: {react,solid,vue} x {ts,js}, all on
// Vite (per PLAN.md Phase 4). "solid-ts" was proven first end-to-end, then
// the rest were generalized from it -- same shared shape (electron/main.ts
// or .js branching on NODE_ENV between Vite dev server and
// app.setAppRoot()+"bunium://app/" for prod, per-framework Vite plugin +
// component syntax layered on top). Adding a further template later means:
// (1) drop a new dir under templates/<name>/, (2) add its id to TEMPLATES
// below. The placeholder-substitution mechanism
// (__PROJECT_NAME__/__BUNIUM_VERSION__) and the copy/rename logic are
// already template-agnostic.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const TEMPLATES = [
  "solid-ts",
  "solid-js",
  "react-ts",
  "react-js",
  "vue-ts",
  "vue-js",
] as const;
type Template = (typeof TEMPLATES)[number];

function parseArgs(argv: string[]): { targetDir: string; template: Template } {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const targetDir = positional[0] ?? "bunium-app";

  const templateFlag = argv.find((a) => a.startsWith("--template="));
  const template = (templateFlag?.split("=")[1] ?? "solid-ts") as Template;

  if (!TEMPLATES.includes(template)) {
    console.error(
      `bunium: unknown template "${template}". Available: ${TEMPLATES.join(", ")}`,
    );
    process.exit(1);
  }

  return { targetDir, template };
}

// Substitutes __PROJECT_NAME__/__BUNIUM_VERSION__ placeholders in template
// files. Plain string replace, not a templating engine -- the template set
// is small and the placeholders are few; not worth a dependency for this.
function renderPlaceholders(content: string, projectName: string): string {
  return content
    .replaceAll("__PROJECT_NAME__", projectName)
    .replaceAll("__BUNIUM_VERSION__", "latest");
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".html",
  ".css",
  ".md",
  ".vue",
]);

// Extension-less dotfiles (e.g. ".gitignore") -- entry.slice(lastIndexOf("."))
// on a name that IS just ".gitignore" returns the whole filename, not "",
// so route these through the same text-render path explicitly by name
// rather than trying to make the extension check handle a leading-dot
// filename correctly.
const TEXT_FILENAMES = new Set([".gitignore"]);

function copyTemplate(
  srcDir: string,
  destDir: string,
  projectName: string,
): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyTemplate(srcPath, destPath, projectName);
      continue;
    }

    const ext = entry.slice(entry.lastIndexOf("."));
    if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(entry)) {
      const content = readFileSync(srcPath, "utf8");
      writeFileSync(destPath, renderPlaceholders(content, projectName));
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

function main(): void {
  const { targetDir, template } = parseArgs(process.argv.slice(2));
  const destDir = resolve(process.cwd(), targetDir);

  if (existsSync(destDir) && readdirSync(destDir).length > 0) {
    console.error(
      `bunium: target directory "${targetDir}" already exists and is not empty`,
    );
    process.exit(1);
  }

  const templateDir = join(import.meta.dirname, "templates", template);
  if (!existsSync(templateDir)) {
    console.error(`bunium: template "${template}" not found at ${templateDir}`);
    process.exit(1);
  }

  const projectName = targetDir.split("/").pop() ?? targetDir;
  copyTemplate(templateDir, destDir, projectName);

  console.log(`\nScaffolded "${projectName}" (${template}) in ${destDir}\n`);
  console.log("Next steps:");
  console.log(`  cd ${targetDir}`);
  console.log("  bun install");
  console.log("  bun run dev");
}

main();
