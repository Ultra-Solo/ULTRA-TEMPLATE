/**
 * Rules the architecture model must satisfy, written as plain functions over the LikeC4 model API.
 * Keeping them separate from the model loader is what lets a test feed each rule a hand-built model
 * that breaks it and watch it fire.
 *
 * Three of them exist because the rest cannot see the mistake they were added for. Every rule above
 * `routesDeclared` is topological: it reads elements, kinds and relationships, never a step label.
 * Measured on the model ADR-0049 introduced — which named `POST /api/tasks/{id}/move`, a route this
 * repository does not serve — all of them returned zero findings.
 */
import { readFileSync } from "node:fs";

const BUILT = new Set(["service", "webapp", "library", "script", "records"]);
const UNBUILT = new Set(["actor", "system"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]);

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
 * ADR-0049: every runtime relationship of the product — from the user into it, or between its own
 * elements — is a step of some dynamic view, so the flows a static view cannot show are narrated.
 */
export function runtimeFlowDocumented(model) {
  const dynamics = dynamicViews(model);
  return productRuntime(model)
    .filter((r) => !dynamics.some((view) => view.includesRelation(r)))
    .map((r) => `${r.source.id} -> ${r.target.id} is not a step of any dynamic view`);
}

// The flows a dynamic view would narrate: a user entering the product, or product talking to product.
const productRuntime = (model) =>
  [...model.relationships()].filter(
    (r) => (r.source.id === "user" && inProduct(r.target.id)) || (inProduct(r.source.id) && inProduct(r.target.id)),
  );

// What the product is made of, its own system aside. system.c4 declares `product` unconditionally and
// every element inside it carries the marker of the feature that draws it, so `--features architecture`
// generates a product that exists and is empty. "Nothing to narrate" is that, and only that: a product
// with a service and no client has contents, and a view of it that shows no step is the defect.
const productElements = (model) => [...model.elements()].filter((e) => e.id !== "product" && inProduct(e.id));

// --- What the topological rules cannot see -------------------------------------------------------
//
// LikeC4 validates a step's endpoints — the elements a step names must exist — but its label is free
// prose. A view can therefore assert a route this repository does not serve, indefinitely, and satisfy
// every rule above. The three rules below hold a view's prose to the files that state the truth.

const METHOD_AND_PATH = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[A-Za-z0-9{}/._-]*)/g;

const dynamicViews = (model) => [...model.views()].filter((view) => view.isDynamicView());
const stepsOf = (view) => [...view.edges()].filter((step) => step.isStep());

function defaultReadAssets() {
  // `../`, not `../../`: this file sits beside the directory it reads. One level too high escapes the
  // checkout, readFileSync throws, and the rule that depends on it goes quiet instead of loud.
  return readFileSync(new URL("../scripts/contract/openapi.json", import.meta.url), "utf8");
}

// Not exported: test/model.test.mjs treats every exported function as a rule, and this is not one.
// The declared routes, or null when no contract is in this checkout at all.
function declaredRoutes(read = defaultReadAssets) {
  let openapi;
  try {
    openapi = JSON.parse(read());
  } catch {
    return null;
  }
  return new Set(
    Object.entries(openapi.paths ?? {}).flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((key) => HTTP_METHODS.has(key.toUpperCase()))
        .map((method) => `${method.toUpperCase()} ${path}`),
    ),
  );
}

/**
 * Every HTTP route a dynamic view names is one the API contract declares.
 *
 * When the contract is absent — an `--features architecture` checkout ships no `scripts/contract` —
 * the rule must not fall silent: a route claim it cannot check is reported as unverifiable, never as
 * satisfied. A view that names no route asserts nothing about the HTTP surface and passes. Absence of
 * the contract is a deployment shape, not licence to assert anything (AGENTS.md: a check that could
 * not run is a failure to report, not a pass).
 */
export function routesDeclared(model, options = {}) {
  const declared = declaredRoutes(options.read);
  const mentioned = dynamicViews(model).flatMap((view) =>
    stepsOf(view).flatMap((step) =>
      [...String(step.label ?? "").matchAll(METHOD_AND_PATH)].map((match) => ({ view, step, route: `${match[1]} ${match[2]}` })),
    ),
  );
  if (declared === null) {
    return mentioned.map(
      ({ view, route }) => `${view.id}: step names ${route}, and this checkout has no scripts/contract to check it against`,
    );
  }
  return mentioned
    .filter(({ route }) => !declared.has(route))
    .map(({ view, step, route }) => `${view.id}: step "${step.label}" names ${route}, which the contract does not declare`);
}

/** ADR-0049: a dynamic view exists to narrate interactions, so it must narrate at least one, labelled. */
export function viewsSaySomething(model) {
  // A model with no product in it — `--features architecture` generates one — has nothing to narrate,
  // so a dynamic view without steps is the only honest view there, not a defect. Reporting it made the
  // rule fire on the clean model the generator's own test blesses. The premise is what the product is
  // made of, not the flows it happens to have: a product with a service and no client still has
  // something to narrate, and the checked premise says so.
  if (productElements(model).length === 0) return [];
  return dynamicViews(model).flatMap((view) => {
    const steps = stepsOf(view);
    if (steps.length === 0) return [`${view.id} is a dynamic view with no steps: it narrates nothing`];
    return steps
      .filter((step) => !String(step.label ?? "").trim())
      .map((step) => `${view.id}: step ${step.source.id} -> ${step.target.id} has no label`);
  });
}

/**
 * A step that enters an element of the product is heard from before the view ends.
 *
 * This is the sound half of "every step is backed by a declared relationship", which cannot be
 * enforced here: a response step and a self-call are legitimately unbound, and declaring the reverse
 * relationship to bind them would itself break `clientDependencies`. What is checkable without
 * guessing is that the flow comes back — and it compares endpoints, which LikeC4 validates, rather
 * than prose, which it does not.
 */
export function interactionsAnswered(model) {
  return dynamicViews(model).flatMap((view) => {
    const steps = stepsOf(view);
    const replied = new Set(steps.map((step) => `${step.source.id}->${step.target.id}`));
    return steps
      .filter((step) => step.source.id !== step.target.id && step.source.kind !== "actor" && !UNBUILT.has(step.target.kind))
      .filter((step) => !replied.has(`${step.target.id}->${step.source.id}`))
      .map((step) => `${view.id}: ${step.source.id} -> ${step.target.id} "${step.label}" has no reply step`);
  });
}

/**
 * One hand-built model per rule, keyed by the rule's export name, that breaks exactly that rule.
 * test/model.test.mjs fails when a rule has no entry here or does not fire on it, so a rule proven
 * only against a clean model cannot pass while broken (ADR-0043).
 */
const element = (id, kind, technology = "x", description = "x", links = [{ url: "https://example.com" }]) => ({
  id,
  kind,
  technology,
  description: { isEmpty: description === "" },
  links,
});

const dynamicView = (id, edges) => ({
  id,
  isDynamicView: () => true,
  edges: () => edges.map((edge) => ({ isStep: () => true, ...edge })),
  includesRelation: (r) => edges.some((edge) => edge.source.id === r.source.id && edge.target.id === r.target.id),
});

const step = (source, target, label) => ({ source: element(source, "service"), target: element(target, "webapp"), label });

export const violating = {
  undocumented: { elements: () => [element("product.api", "service", null, "")], relationships: () => [], views: () => [] },
  clientDependencies: {
    elements: () => [element("product.api", "service"), element("product.web", "webapp")],
    relationships: () => [{ source: element("product.api", "service"), target: element("product.web", "webapp") }],
    views: () => [],
  },
  orphaned: { elements: () => [element("product.tsLibrary", "library")], relationships: () => [], views: () => [] },
  chassisDecoupled: {
    elements: () => [element("chassis.verify", "script"), element("product.api", "service")],
    relationships: () => [{ source: element("chassis.verify", "script"), target: element("product.api", "service") }],
    views: () => [],
  },
  anchored: { elements: () => [element("chassis.verify", "script", "x", "x", [])], relationships: () => [], views: () => [] },
  runtimeFlowDocumented: {
    elements: () => [element("user", "actor"), element("product.api", "service"), element("product.web", "webapp")],
    relationships: () => [{ source: element("user", "actor"), target: element("product.api", "service") }],
    views: () => [],
  },
  routesDeclared: {
    elements: () => [],
    relationships: () => [],
    views: () => [dynamicView("taskMove", [step("product.web", "product.api", "POST /api/tasks/{id}/move")])],
  },
  viewsSaySomething: {
    elements: () => [element("product.api", "service")],
    relationships: () => [],
    views: () => [dynamicView("taskMove", [])],
  },
  interactionsAnswered: {
    elements: () => [],
    relationships: () => [],
    views: () => [dynamicView("taskMove", [step("product.web", "product.api", "PATCH /api/tasks/{id}/status")])],
  },
};
