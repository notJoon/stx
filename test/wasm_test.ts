import { add } from "data:application/wasm;base64,AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=";
import { load_add, wasm_bytes } from "../src/wasm.ts";

Deno.test("Deno can import wasm as a typed ES module", () => {
  assertEquals(add(5, 7), 12);
});

Deno.test("Deno can instantiate a wasm package through the WebAssembly API", async () => {
  const add = await load_add();

  assertEquals(add(20, 22), 42);
});

Deno.test("Deno can import wasm as an ES module from a package URL", async () => {
  const body = btoa(String.fromCharCode(...wasm_bytes()));
  const wasm = await import(`data:application/wasm;base64,${body}`);

  assertEquals(wasm.add(1, 2), 3);
});

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}
