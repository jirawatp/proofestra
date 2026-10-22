// js-yaml 4 ships no type declarations; the contract test only needs `load`.
declare module "js-yaml" {
  export function load(input: string): unknown;
}
