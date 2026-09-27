using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "smoke", worker = (
      modules = [(name = "smoke.mjs", esModule = embed "smoke.mjs")],
      compatibilityDate = "2026-08-24",
      compatibilityFlags = ["nodejs_compat", "enable_request_signal"]
    )),
    (name = "internet", network = (allow = []))
  ]
);
