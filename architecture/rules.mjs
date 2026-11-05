/**
 * Rules the architecture model must satisfy, written as plain functions over the LikeC4 model API.
 * Keeping them separate from the model loader is what lets a test feed each rule a hand-built model
 * that breaks it and watch it fire.
 */

const BUILT = new Set(["service", "webapp", "library", "script", "records"]);

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

/** Every built element takes part in a relationship: a node nothing connects to is decoration, not architecture. */
export function orphaned(model) {
  const connected = new Set(model.relationships().flatMap((r) => [r.source.id, r.target.id]));
  return [...model.elements()].filter((e) => BUILT.has(e.kind) && !connected.has(e.id)).map((e) => `${e.id} has no relationship`);
}

// ADR-0044: the chassis and the system it builds stay decoupled; only the generator may point at the product.
const inChassis = (id) => id === "chassis" || id.startsWith("chassis.");
const inProduct = (id) => id === "product" || id.startsWith("product.");

/** No relationship may cross the chassis/product boundary except chassis.template -> product. */
export function chassisDecoupled(model) {
  return [...model.relationships()]
    .filter((r) => (inChassis(r.source.id) && inProduct(r.target.id)) || (inProduct(r.source.id) && inChassis(r.target.id)))
    .filter((r) => !(r.source.id === "chassis.template" && r.target.id === "product"))
    .map((r) => `${r.source.id} crosses the chassis boundary to ${r.target.id}`);
}

/** ADR-0046: every built element is anchored to a file: a node with no link is decoration, not architecture. */
export function anchored(model) {
  return [...model.elements()]
    .filter((element) => BUILT.has(element.kind) && (element.links ?? []).length === 0)
    .map((element) => `${element.id} has no link to a file`);
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
  orphaned: (() => {
    const element = (id, kind) => ({ id, kind, technology: "x", description: { isEmpty: false } });
    return { elements: () => [element("product.tsLibrary", "library")], relationships: () => [] };
  })(),
  chassisDecoupled: (() => {
    const element = (id, kind) => ({ id, kind, technology: "x", description: { isEmpty: false } });
    const verify = element("chassis.verify", "script");
    const api = element("product.api", "service");
    return { elements: () => [verify, api], relationships: () => [{ source: verify, target: api }] };
  })(),
  anchored: (() => {
    const element = (id, kind) => ({ id, kind, technology: "x", description: { isEmpty: false }, links: [] });
    return { elements: () => [element("chassis.verify", "script")], relationships: () => [] };
  })(),
};
