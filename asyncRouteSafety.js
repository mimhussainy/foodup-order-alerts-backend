function wrapAsyncHandler(handler) {
  if (Array.isArray(handler)) return handler.map(wrapAsyncHandler);
  if (typeof handler !== 'function') return handler;
  if (handler.__foodupAsyncWrapped) return handler;

  const wrapped = function foodupAsyncRouteWrapper(req, res, next) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch(next);
      }
      return result;
    } catch (err) {
      return next(err);
    }
  };

  wrapped.__foodupAsyncWrapped = true;
  return wrapped;
}

function installAsyncRouteSafety(target) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = target[method];
    if (typeof original !== 'function') continue;

    target[method] = function foodupSafeRouteRegistration(path, ...handlers) {
      // Preserve Express setting reads such as app.get('env').
      if (handlers.length === 0) return original.call(this, path);
      return original.call(this, path, ...handlers.map(wrapAsyncHandler));
    };
  }
  return target;
}

module.exports = { installAsyncRouteSafety, wrapAsyncHandler };
