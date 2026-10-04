// Copied from Control Panel 1.01 (src-tauri/src/lib.rs, create_child_webview):
// web tabs get an in-page "fullscreen" instead of a real one.
(function() {
  let fullscreenElement = null;

  const style = document.createElement('style');
  style.textContent = `
    .tauri-fake-fullscreen {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483647 !important;
      margin: 0 !important;
      padding: 0 !important;
      box-sizing: border-box !important;
      background: black !important;
    }
    .tauri-fake-fullscreen video {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
    }
  `;
  
  const insertStyle = () => {
    if (document.head || document.documentElement) {
      (document.head || document.documentElement).appendChild(style);
    } else {
      setTimeout(insertStyle, 1);
    }
  };
  insertStyle();

  function triggerFullscreenChange() {
    const event = new Event('fullscreenchange', { bubbles: true, cancelable: true });
    if (typeof document.onfullscreenchange === 'function') {
      try { document.onfullscreenchange(event); } catch(e) {}
    }
    document.dispatchEvent(event);
    ['webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(eventName => {
      const e = new Event(eventName, { bubbles: true, cancelable: true });
      const onProp = 'on' + eventName.toLowerCase();
      if (typeof document[onProp] === 'function') {
        try { document[onProp](e); } catch(err) {}
      }
      document.dispatchEvent(e);
    });
  }

  Element.prototype.requestFullscreen = function() {
    return new Promise((resolve, reject) => {
      try {
        if (fullscreenElement) {
          document.exitFullscreen();
        }
        fullscreenElement = this;
        this.classList.add('tauri-fake-fullscreen');
        triggerFullscreenChange();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  };

  Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
  Element.prototype.webkitRequestFullScreen = Element.prototype.requestFullscreen;
  Element.prototype.mozRequestFullScreen = Element.prototype.requestFullscreen;
  Element.prototype.msRequestFullscreen = Element.prototype.requestFullscreen;

  Object.defineProperty(document, 'fullscreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'webkitFullscreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'mozFullScreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'msFullscreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });

  Object.defineProperty(document, 'fullscreenEnabled', {
    get: function() { return true; },
    configurable: true
  });
  Object.defineProperty(document, 'webkitFullscreenEnabled', {
    get: function() { return true; },
    configurable: true
  });
  Object.defineProperty(document, 'mozFullScreenEnabled', {
    get: function() { return true; },
    configurable: true
  });
  Object.defineProperty(document, 'msFullscreenEnabled', {
    get: function() { return true; },
    configurable: true
  });

  Object.defineProperty(document, 'fullscreen', {
    get: function() { return !!fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'webkitIsFullScreen', {
    get: function() { return !!fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'mozFullScreen', {
    get: function() { return !!fullscreenElement; },
    configurable: true
  });

  document.exitFullscreen = function() {
    return new Promise((resolve, reject) => {
      try {
        if (fullscreenElement) {
          fullscreenElement.classList.remove('tauri-fake-fullscreen');
          fullscreenElement = null;
          triggerFullscreenChange();
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  };

  document.webkitExitFullscreen = document.exitFullscreen;
  document.webkitCancelFullScreen = document.exitFullscreen;
  document.mozCancelFullScreen = document.exitFullscreen;
  document.msExitFullscreen = document.exitFullscreen;

  window.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && fullscreenElement) {
      document.exitFullscreen();
    }
  }, true);
})();
