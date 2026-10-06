export default {
  "resolve": {
    "alias": {
      "@cinaauth/auth-web-contract": "C:/cinagroup/cinaauth/packages/auth-web-contract/src/index.ts",
      "vitest": "C:/cinagroup/cinaauth/node_modules/vitest/dist/index.js"
    }
  },
  "test": {
    "environment": "node",
    "include": [
      "workers/auth-api/test/cinatoken-oidc-client.test.ts"
    ],
    "testTimeout": 10000,
    "watch": false,
    "fileParallelism": false
  }
};
