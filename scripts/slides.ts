import { $ } from "bun";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const presentation = join(root, "presentation");
const diagrams = join(presentation, "diagrams");
const mmdc = join(root, "node_modules", ".bin", "mmdc");

for (const name of ["diagram-1", "diagram-2", "diagram-3"]) {
	const output = join(diagrams, `${name}.svg`);
	await $`${mmdc} -i ${join(diagrams, `${name}.mmd`)} -o ${output} -c ${join(presentation, "mermaid.json")} -b transparent`;
	if ((await Bun.file(output).text()).includes("<foreignObject")) {
		throw new Error(`${name} contains HTML labels unsupported by Typst`);
	}
}

await $`typst compile --root ${root} ${join(presentation, "deck.typ")} ${join(presentation, "anyflo-solver.pdf")}`;
