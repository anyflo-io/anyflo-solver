import { $ } from "bun";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const presentation = join(root, "presentation");
const diagrams = join(presentation, "diagrams");
const mmdc = join(root, "node_modules", ".bin", "mmdc");

for (const file of readdirSync(diagrams)
	.filter((f) => f.endsWith(".mmd"))
	.sort()) {
	const name = file.slice(0, -4);
	const output = join(diagrams, `${name}.svg`);
	await $`${mmdc} -i ${join(diagrams, file)} -o ${output} -c ${join(presentation, "mermaid.json")} -b transparent`;
	if ((await Bun.file(output).text()).includes("<foreignObject")) {
		throw new Error(`${name} contains HTML labels unsupported by Typst`);
	}
}

await $`typst compile --root ${root} ${join(presentation, "deck.typ")} ${join(presentation, "anyflo-solver.pdf")}`;
