function infIndexOf(str: string, c: string) {
	const r = str.indexOf(c);
	if (r === -1) return Infinity;
	return r;
}

function max2(...args: [number, number][]) {
	const lowest = Math.min(...args.map(a => a[0]));
	return args.find(a => a[0] === lowest)!;
}

export function parseDG(
	dg: string,
	cleanText: (txt: string) => string,
	callFunction: (
		name: string,
		args: { clean: string; raw: string }[],
	) => string,
): { resRaw: string; resClean: string; remaining: string } {
	let resRaw = "";
	let resClean = "";

	while (dg) {
		const nextOpenBracket = infIndexOf(dg, "{{");
		const nextCloseBracket = infIndexOf(dg, "}}");
		const nextLine = infIndexOf(dg, "|");
		const [closest, size] = max2(
			[nextOpenBracket, 2],
			[nextCloseBracket, 2],
			[nextLine, 1],
			[dg.length, 0],
		);

		resRaw += dg.substr(0, closest);
		resClean += cleanText(dg.substr(0, closest));

		if (
			nextCloseBracket < nextOpenBracket ||
			nextLine < nextOpenBracket ||
			closest === dg.length
		) {
			dg = dg.substr(closest);
			break;
		}
		dg = dg.substr(closest + size);

		{
			let firstLine = infIndexOf(dg, "|");
			let firstCloseBracket = infIndexOf(dg, "}}");
			let [closest, size] = max2([firstLine, 1], [firstCloseBracket, 2]);

			const argName = dg.substr(0, closest);

			const args: { clean: string; raw: string }[] = [];

			while (size === 1) {
				const cut = dg.substr(closest + size);

				const parsed = parseDG(cut, cleanText, callFunction);

				dg = parsed.remaining;
				args.push({ clean: parsed.resClean, raw: parsed.resRaw });

				firstLine = infIndexOf(dg, "|");
				firstCloseBracket = infIndexOf(dg, "}}");
				[closest, size] = max2([firstLine, 1], [firstCloseBracket, 2]);
			}

			dg = dg.substr(closest + size);

			const callResult = callFunction(argName, args);
			resRaw += callResult;
			resClean += callResult;
		}
	}
	return { resRaw, resClean, remaining: dg };
}

/*
test "parseDG" {
	`test {{Something|arg1|arg2|{{thingthree|arg4}}}}`
}
*/
