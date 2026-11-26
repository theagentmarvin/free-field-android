// Drop dev-only baggage (jsdom, vitest, eslint, firebase-tools...) from the
// vendored @ff/* packages so the mobile install stays small and has a single
// resolution of every runtime dependency.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name && pkg.name.startsWith("@ff/")) {
        pkg.devDependencies = {};
      }
      return pkg;
    },
  },
};
