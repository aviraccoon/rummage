import { describe, expect, test } from "bun:test";
import { buildOutputDir } from "./fetch.ts";

describe("buildOutputDir", () => {
	test("returns revolut dir when no name", () => {
		const dir = buildOutputDir("/data/raw", undefined);
		expect(dir).toBe("/data/raw/revolut");
	});

	test("returns revolut dir when name is empty", () => {
		const dir = buildOutputDir("/data/raw");
		expect(dir).toBe("/data/raw/revolut");
	});

	test("adds name suffix when provided", () => {
		const dir = buildOutputDir("/data/raw", "personal");
		expect(dir).toBe("/data/raw/revolut-personal");
	});

	test("handles business account", () => {
		const dir = buildOutputDir("/home/user/rummage/data/raw", "business");
		expect(dir).toBe("/home/user/rummage/data/raw/revolut-business");
	});
});
