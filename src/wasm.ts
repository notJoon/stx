const add_wasm = "AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags=";

export function wasm_bytes() {
  return Uint8Array.from(atob(add_wasm), (c) => c.charCodeAt(0));
}

export async function load_add() {
  const { instance } = await WebAssembly.instantiate(wasm_bytes());
  return instance.exports.add as (a: number, b: number) => number;
}
