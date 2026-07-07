/**
 * Platform detection — Capacitor native shells and Sign in with Apple gating.
 */
(function (global) {
  'use strict';

  function getCapacitor() {
    try {
      return global.Capacitor || null;
    } catch (e) {
      return null;
    }
  }

  function getPlatform() {
    var cap = getCapacitor();
    if (cap && typeof cap.getPlatform === 'function') {
      return cap.getPlatform();
    }
    return 'web';
  }

  function isIOS() {
    var p = getPlatform();
    if (p === 'ios') return true;
    try {
      var ua = global.navigator && global.navigator.userAgent ? global.navigator.userAgent : '';
      return /iPhone|iPad|iPod/i.test(ua);
    } catch (e2) {
      return false;
    }
  }

  function isAndroid() {
    return getPlatform() === 'android';
  }

  function isNativeApp() {
    var p = getPlatform();
    return p === 'ios' || p === 'android';
  }

  /** True when Supabase Apple provider + Services ID are configured server-side. */
  function isAppleAuthEnabled() {
    var cfg = global.ARC_PUBLIC_CONFIG || {};
    return !!(cfg.auth && cfg.auth.appleEnabled);
  }

  function shouldShowAppleSignIn() {
    return isIOS() && isAppleAuthEnabled();
  }

  function isProdClient() {
    try {
      var host = global.location && global.location.hostname ? global.location.hostname : '';
      if (host === 'localhost' || host === '127.0.0.1') return false;
      var search = global.location && global.location.search ? global.location.search : '';
      if (search.indexOf('arc_debug=1') !== -1) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  global.ArcPlatform = {
    getCapacitor: getCapacitor,
    getPlatform: getPlatform,
    isIOS: isIOS,
    isAndroid: isAndroid,
    isNativeApp: isNativeApp,
    isAppleAuthEnabled: isAppleAuthEnabled,
    shouldShowAppleSignIn: shouldShowAppleSignIn,
    isProdClient: isProdClient
  };
})(typeof window !== 'undefined' ? window : this);
