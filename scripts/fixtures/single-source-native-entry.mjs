import { createSingleSourceTestBoundary } from "../lib/single-source-test-boundary.mjs";

/** Unloaded test entry factory. The caller must provide the unchanged reviewed
 * ordinary module and a private seed, after context isolation and independent
 * review. No defaults, private-file loader, Gateway call, or model invocation.
 * The seed is a restriction, never authorization or a substitute for native
 * reply_dispatch / v2 invocation / authenticated Gateway facts. */
export function createSingleSourceNativeEntry(ordinary, seed, onBoundary = () => {}) {
  const boundary = createSingleSourceTestBoundary(seed);
  return {
    id: "stella-core",
    name: "Stella Core",
    register(api) {
      const complete = ordinary.createSourcePolicyCompletion(api, "main");
      const entry = ordinary.createOrdinaryPlugin({
        completeSourceAccess: params => boundary.complete(params, complete),
      });
      const wrappedApi = Object.create(api);
      Object.defineProperty(wrappedApi, "registerTool", { value(factory, options) {
        if (factory.contextVersion !== 2 || typeof factory.create !== "function") throw new Error("test_tool_factory_changed");
        return api.registerTool({ ...factory, create(ctx) {
          const tools = factory.create(ctx);
          if (tools === null || tools === undefined) return tools;
          if (!Array.isArray(tools)) throw new Error("test_tool_factory_shape_changed");
          return tools.map(tool => boundary.wrapTool(tool, ctx));
        } }, options);
      } });
      entry.register(wrappedApi);
      api.on("reply_dispatch", (event, ctx) => boundary.observeDispatch(event, ctx));
      api.on("before_prompt_build", (event, ctx) => boundary.beforePrompt(event, ctx));
      api.on("before_tool_call", (event, ctx) => boundary.beforeTool(event, ctx));
      api.on("agent_end", (event, ctx) => boundary.end(event, ctx));
      onBoundary(() => boundary.summary()); // Counters only; no body/ref/identity.
    },
  };
}
