import { expect, test } from "bun:test";

import { ConfigSchema } from "../src/config";

test("live credentials cannot be redirected to another provider origin", async () => {
	const input = await Bun.file(
		new URL("../solver.config.example.json", import.meta.url),
	).json();
	const config = ConfigSchema.parse({
		...input,
		depositAccount: "0x1111111111111111111111111111111111111111",
		deliveryAccount: "0x2222222222222222222222222222222222222222",
	});
	expect(
		ConfigSchema.safeParse({
			...config,
			uniswapApiUrl: "https://attacker.example/v1",
		}).success,
	).toBe(false);
	expect(
		ConfigSchema.safeParse({
			...config,
			oneInchApiUrl: "https://attacker.example/swap/v6.1",
		}).success,
	).toBe(false);
});
