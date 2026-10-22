// @xmcl/installer 6.3.6 imports this helper from a source-only subpath that
// @xmcl/core 2.16.2 omits from its npm tarball. Resolve it at bundle time.
export const isNotNull = value => value !== undefined;
