/**
 * Rules the architecture model must satisfy, written as plain functions over the LikeC4 model API.
 * Keeping them separate from the model loader is what lets a test feed each rule a hand-built model
 * that breaks it and watch it fire.
 */

const BUILT = new Set(["service", "webapp", "library"]);

/** Every element this project builds says what it is built with and what it is for. */
export function undocumented(model) {
  return [...model.elements()]
    .filter((element) => BUILT.has(element.kind))
    .flatMap((element) => [
      ...(element.technology ? [] : [`${element.id} has no technology`]),
      ...(element.description.isEmpty ? [`${element.id} has no description`] : []),
    ]);
}

/** A client depends on its API, never the reverse: no service may depend on a web app. */
export function clientDependencies(model) {
  return [...model.relationships()]
    .filter((r) => r.source.kind === "service" && r.target.kind === "webapp")
    .map((r) => `${r.source.id} depends on the web app ${r.target.id}`);
}

/**
 * One hand-built model per rule, keyed by the rule's export name, that breaks exactly that rule.
 * test/model.test.mjs fails when a rule has no entry here or does not fire on it, so a rule proven
 * only against a clean model cannot pass while broken (ADR-0043).
 */
export const violating = {
  undocumented: (() => {
    const element = (id, kind, technology, description) => ({ id, kind, technology, description: { isEmpty: description === "" } });
    return { elements: () => [element("product.api", "service", null, "")], relationships: () => [] };
  })(),
  clientDependencies: (() => {
    const element = (id, kind) => ({ id, kind, technology: "x", description: { isEmpty: false } });
    const api = element("product.api", "service");
    const web = element("product.web", "webapp");
    return { elements: () => [api, web], relationships: () => [{ source: api, target: web }] };
  })(),
};
