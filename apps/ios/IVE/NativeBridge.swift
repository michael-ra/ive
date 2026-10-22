import UIKit
import WebKit

/// The small JS surface the native shell adds to the IVE web UI.
///
/// Web side (all optional; the web UI works without it):
///
///     if (window.iveNative) {
///       iveNative.haptic('light')          // light|medium|heavy|soft|rigid|selection|success|warning|error
///       iveNative.setPullToRefresh(false)  // e.g. while a terminal is full screen
///       iveNative.openSettings()           // native settings sheet (Mac, Face ID, re-pair)
///       iveNative.openExternal(url)        // open in Safari
///       iveNative.apnsToken                // APNs device token once registered (or null)
///     }
///     window.addEventListener('ive:apns-token', e => e.detail.token)
///
/// `navigator.standalone` reports true inside the app, so the web UI treats
/// it like the Home-Screen web app (no "Add to Home Screen" prompt, and
/// /pair.js jumps straight to "/" after pairing). The <html> element gets
/// the class `ive-native-ios`.
enum NativeBridge {
    static let hapticHandler = "iveHaptic"
    static let nativeHandler = "iveNative"

    static var documentStartScript: String {
        """
        (function () {
          try { Object.defineProperty(Navigator.prototype, 'standalone', { get: function () { return true }, configurable: true }) } catch (e) {}
          function post(name, msg) { try { window.webkit.messageHandlers[name].postMessage(msg) } catch (e) {} }
          window.iveNative = {
            platform: 'ios',
            version: '\(AppInfo.version)',
            apnsToken: null,
            haptic: function (style) { post('\(hapticHandler)', { style: String(style || 'light') }) },
            setPullToRefresh: function (on) { post('\(nativeHandler)', { type: 'pullToRefresh', enabled: !!on }) },
            openSettings: function () { post('\(nativeHandler)', { type: 'openSettings' }) },
            openExternal: function (url) { post('\(nativeHandler)', { type: 'openExternal', url: String(url) }) },
          };
          document.documentElement.classList.add('ive-native-ios');
        })();
        """
    }

    /// Haptic tick on the phone key bar from feat/mobile-overview
    /// (`[data-phone-keybar] [data-key]`), and pull-to-refresh switched off
    /// while a terminal is on screen so a downward swipe never reloads it.
    static var documentEndScript: String {
        """
        (function () {
          if (!window.iveNative || window.__iveNativeWired) return;
          window.__iveNativeWired = true;
          document.addEventListener('pointerdown', function (e) {
            var t = e.target && e.target.closest && e.target.closest('[data-phone-keybar] [data-key], [data-native-haptic]');
            if (t) window.iveNative.haptic(t.getAttribute('data-native-haptic') || 'light');
          }, { capture: true, passive: true });
          var last = null, queued = false;
          function sync() {
            queued = false;
            var busy = !!document.querySelector('[data-phone-keybar], [data-phone-session-head], .xterm');
            if (busy !== last) { last = busy; window.iveNative.setPullToRefresh(!busy); }
          }
          new MutationObserver(function () { if (!queued) { queued = true; requestAnimationFrame(sync) } })
            .observe(document.documentElement, { childList: true, subtree: true });
          sync();
        })();
        """
    }
}

extension WKWebView {
    /// Remove iOS's form accessory bar ("< > Done") above the keyboard. The
    /// web UI ships its own terminal key bar, and the system bar would sit on
    /// top of it. Done by swapping the content view's class for a subclass
    /// whose `inputAccessoryView` is nil (no private API calls).
    func ive_setKeyboardAccessoryHidden() {
        guard let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let baseClass = object_getClass(content)
        else { return }
        let name = "IVE_NoAccessory_\(NSStringFromClass(baseClass))"
        if NSStringFromClass(baseClass) == name { return }
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let made = objc_allocateClassPair(baseClass, name, 0) {
            let sel = #selector(getter: UIResponder.inputAccessoryView)
            let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            if let method = class_getInstanceMethod(UIView.self, sel) {
                class_addMethod(made, sel, imp_implementationWithBlock(block), method_getTypeEncoding(method))
            }
            objc_registerClassPair(made)
            subclass = made
        }
        if let subclass { object_setClass(content, subclass) }
    }
}
