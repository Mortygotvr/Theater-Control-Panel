// window.__TAURI__ for app pages hosted by the Theater Control Panel plugin: the part of Tauri's
// global API (withGlobalTauri) the Control Panel uses, carried over WebView2's
// postMessage. Replies and events come back through window.__TAURI_OBS__.
(() => {
  if (window.__TAURI_OBS__) return;

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const post = (message) => window.chrome.webview.postMessage(JSON.stringify(message));

  Object.defineProperty(window, '__TAURI_OBS__', {
    value: Object.freeze({
      resolve(id, ok, value) {
        const call = pending.get(id);
        if (!call) return;
        pending.delete(id);
        if (ok) call.resolve(value);
        else call.reject(value);
      },
      dispatch(event, payload) {
        for (const [id, handler] of [...(listeners.get(event) || [])]) {
          try {
            handler({ event, id, payload });
          } catch (e) {
            console.error(e);
          }
        }
      },
    }),
  });

  const invoke = (cmd, args = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ kind: 'invoke', id, cmd, args });
    });

  const addListener = (event, handler) => {
    const id = nextId++;
    if (!listeners.has(event)) listeners.set(event, new Map());
    listeners.get(event).set(id, handler);
    return id;
  };
  const unlistener = (event, id) => () => listeners.get(event)?.delete(id);

  const listen = (event, handler) => Promise.resolve(unlistener(event, addListener(event, handler)));
  const once = (event, handler) => {
    const id = addListener(event, (e) => {
      listeners.get(event)?.delete(id);
      handler(e);
    });
    return Promise.resolve(unlistener(event, id));
  };
  const emit = (event, payload) => {
    post({ kind: 'emit', event, payload });
    return Promise.resolve();
  };

  window.__TAURI__ = Object.freeze({
    core: Object.freeze({ invoke }),
    event: Object.freeze({ listen, once, emit }),
  });
})();
