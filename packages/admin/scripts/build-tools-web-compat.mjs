/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const admin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(admin, "package.json"));
const postcss = require("postcss");
const tailwind = require("tailwindcss");
if (!require("tailwindcss/package.json").version.startsWith("3."))
	throw new Error(
		"The isolated legacy Tools stylesheet requires Admin Tailwind 3"
	);
const plugin = require("tailwindcss/plugin");
const colors = Object.fromEntries(
	[
		"background",
		"foreground",
		"card",
		"card-foreground",
		"primary",
		"primary-foreground",
		"secondary",
		"secondary-foreground",
		"muted",
		"muted-foreground",
		"popover",
		"popover-foreground",
		"destructive",
		"border",
		"input",
		"ring",
	].map((name) => [name, `rgb(var(--tools-${name}) / <alpha-value>)`])
);
const config = {
	content: [
		path.join(admin, "../web/src/cinatoken/admin/tools/**/*.{ts,tsx}"),
		path.join(admin, "../web/src/cinatoken/admin/playground/**/*.{ts,tsx}"),
		path.join(admin, "../web/src/cinatoken/admin/simulator/**/*.{ts,tsx}"),
		path.join(
			admin,
			"../web/src/cinatoken/admin/chain-operations/**/*.{ts,tsx}"
		),
		...[
			"providers",
			"models",
			"endpoints",
			"routes",
			"routing-workbench",
			"presets",
			"guardrails",
			"data-policies",
			"policy-workbench",
		].map((domain) =>
			path.join(admin, `../web/src/cinatoken/admin/${domain}/**/*.{ts,tsx}`)
		),
		path.join(
			admin,
			"../web/src/cinatoken/admin/AdminDomainRecoveryDialog.tsx"
		),
		...[
			"button",
			"input",
			"dialog",
			"label",
			"textarea",
			"checkbox",
			"badge",
			"card",
			"alert",
		].map((name) => path.join(admin, `../web/src/components/ui/${name}.tsx`)),
		path.join(admin, "app/gateway/tools/LegacyToolsShell.tsx"),
		path.join(admin, "components/diagnostics/LegacyDiagnosticsShell.tsx"),
		path.join(
			admin,
			"components/chain-operations/LegacyChainOperationsShell.tsx"
		),
		path.join(
			admin,
			"components/routing-workbench/LegacyRoutingWorkbenchShell.tsx"
		),
		path.join(
			admin,
			"components/policy-workbench/LegacyPolicyWorkbenchShell.tsx"
		),
	],
	important: ".cinatoken-tools-host",
	corePlugins: { preflight: false },
	darkMode: ["selector", "html[data-console-theme='dark']"],
	theme: { extend: { colors, ringWidth: { 3: "3px" } } },
	plugins: [
		plugin(({ addVariant }) => {
			addVariant("data-open", "&[data-open]");
			addVariant("data-closed", "&[data-closed]");
		}),
	],
};
const light = {
	background: "255 255 255",
	foreground: "17 24 39",
	card: "255 255 255",
	"card-foreground": "17 24 39",
	primary: "14 116 144",
	"primary-foreground": "255 255 255",
	secondary: "229 231 235",
	"secondary-foreground": "17 24 39",
	muted: "243 244 246",
	"muted-foreground": "75 85 99",
	popover: "255 255 255",
	"popover-foreground": "17 24 39",
	destructive: "185 28 28",
	border: "209 213 219",
	input: "209 213 219",
	ring: "8 145 178",
};
const dark = {
	background: "17 24 39",
	foreground: "243 244 246",
	card: "31 41 55",
	"card-foreground": "243 244 246",
	primary: "103 232 249",
	"primary-foreground": "8 47 73",
	secondary: "55 65 81",
	"secondary-foreground": "243 244 246",
	muted: "31 41 55",
	"muted-foreground": "156 163 175",
	popover: "31 41 55",
	"popover-foreground": "243 244 246",
	destructive: "252 165 165",
	border: "75 85 99",
	input: "75 85 99",
	ring: "34 211 238",
};
const variables = (values) =>
	Object.entries(values)
		.map(([name, value]) => `--tools-${name}:${value};`)
		.join("");
// Never import Web's global preflight, theme presets or font assets into Next.
const source = `@tailwind utilities;
.cinatoken-tools-host{${variables(
	light
)}color:rgb(var(--tools-foreground));min-width:0;}
html[data-console-theme='dark'] .cinatoken-tools-host{${variables(dark)}}
.cinatoken-tools-host *{border-color:rgb(var(--tools-border));}
.cinatoken-tools-host :is(button,input,select,textarea,a):focus-visible{outline:2px solid rgb(var(--tools-ring));outline-offset:3px;}
.cinatoken-tools-host [data-slot='dialog-overlay']{position:fixed;inset:0;z-index:1000;background:rgb(0 0 0 / .35);}
.cinatoken-tools-host [data-slot='dialog-content']{position:fixed;z-index:1001;top:50%;left:50%;transform:translate(-50%,-50%);max-width:calc(100vw - 2rem);max-height:85dvh;overflow:auto;background:rgb(var(--tools-popover));color:rgb(var(--tools-popover-foreground));box-shadow:0 16px 48px rgb(0 0 0 / .25);}
.cinatoken-tools-host [data-slot='button']:disabled{pointer-events:none;opacity:.5;}
.cinatoken-tools-host input,.cinatoken-tools-host textarea,.cinatoken-tools-host select{color:inherit;background:rgb(var(--tools-background));}
@media(max-width:767px){.cinatoken-tools-host input,.cinatoken-tools-host textarea,.cinatoken-tools-host select{font-size:16px;}}
`;
const result = await postcss([tailwind(config)]).process(source, {
	from: undefined,
});
const output = path.join(
	admin,
	"app/gateway/tools/tools-web-compat.generated.css"
);
await fs.writeFile(
	output,
	"/* Generated by scripts/build-tools-web-compat.mjs. */\n" + result.css
);
console.log(
	`Legacy Tools isolated stylesheet: ${Buffer.byteLength(result.css)} bytes`
);
