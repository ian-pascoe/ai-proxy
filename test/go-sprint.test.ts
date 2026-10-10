// `goSprint` (src/http/json-text.ts) against `fmt.Sprint` of `encoding/json`-decoded values; expected strings were
// printed by Go 1.27.
import { describe, expect, it } from "vitest";
import { goSprint } from "../src/http/json-text.ts";

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["429", "429"],
  ["1000000", "1e+06"],
  ["123456", "123456"],
  ["1234567", "1.234567e+06"],
  ["0.0001", "0.0001"],
  ["0.00001", "1e-05"],
  ["1.5e-7", "1.5e-07"],
  ["-2.5", "-2.5"],
  ["1e21", "1e+21"],
  ["true", "true"],
  ["null", "<nil>"],
  ['["a",1,null,[2]]', "[a 1 <nil> [2]]"],
  ['{"b":1,"a":{"z":"x"}}', "map[a:map[z:x] b:1]"],
  ["-0", "-0"],
  ["100000", "100000"],
];

describe("goSprint", () => {
  it.each(CASES)("formats %s like fmt.Sprint", (json, expected) => {
    expect(goSprint(JSON.parse(json))).toBe(expected);
  });
});
