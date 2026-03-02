(function () {
  var script =
    document.currentScript ||
    document.querySelector("script[src*='runtime.js']");
  var projectKey = null;
  if (script) {
    try {
      var srcUrl = new URL(script.src);
      projectKey = srcUrl.searchParams.get("projectKey");
    } catch (e) {}
  }
  if (!projectKey) {
    var sp = new URLSearchParams(window.location.search);
    projectKey = sp.get("segmentor_project");
  }
  if (!projectKey) return;

  var baseUrl = "";
  if (script) {
    baseUrl = script.getAttribute("data-api") || "";
  }
  if (!baseUrl && script && script.src) {
    try {
      var u = new URL(script.src);
      baseUrl = u.origin;
    } catch (e) {}
  }

  var isEditMode =
    new URLSearchParams(window.location.search).get("segmentor_edit") === "1";
  if (isEditMode) return;

  /* ───── ANTI-FOUC ───── */
  var FOUC_TIMEOUT_MS = 3000;
  var hideStyle = document.getElementById("segmentor-hide");
  var revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    if (hideStyle && hideStyle.parentNode) {
      hideStyle.parentNode.removeChild(hideStyle);
    }
  }
  var foucTimer = setTimeout(reveal, FOUC_TIMEOUT_MS);

  /* ───── VISITOR ID ───── */
  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
    return match ? match[1] : null;
  }
  function setCookie(name, value, days) {
    var expires = new Date();
    expires.setDate(expires.getDate() + days);
    document.cookie = name + "=" + value + "; path=/; expires=" + expires.toUTCString() + "; SameSite=Lax";
  }

  var visitorId = getCookie("seg_vid");
  if (!visitorId) {
    visitorId = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    setCookie("seg_vid", visitorId, 730);
  }

  var _isReturning = !!getCookie("seg_returning");
  if (!_isReturning) {
    setCookie("seg_returning", "1", 365);
  }

  /* ───── SESSION ID ───── */
  var SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  var sessionId = getCookie("seg_sid");
  var sessionTs = parseInt(getCookie("seg_sts") || "0", 10);
  var now = Date.now();

  if (!sessionId || !sessionTs || (now - sessionTs > SESSION_TIMEOUT_MS)) {
    sessionId = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  setCookie("seg_sid", sessionId, 1);
  setCookie("seg_sts", String(now), 1);

  function touchSession() {
    setCookie("seg_sts", String(Date.now()), 1);
  }

  /* ───── CONTEXT ───── */
  function parseUA() {
    var ua = navigator.userAgent;
    var browser = "Other";
    if (/Edg\//i.test(ua)) browser = "Edge";
    else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = "Opera";
    else if (/Chrome\//i.test(ua)) browser = "Chrome";
    else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";
    else if (/Firefox\//i.test(ua)) browser = "Firefox";

    var os = "Other";
    if (/Windows/i.test(ua)) os = "Windows";
    else if (/Mac OS/i.test(ua)) os = "macOS";
    else if (/Linux/i.test(ua)) os = "Linux";
    else if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";

    var device = /mobile|iphone|android(?!.*tablet)/i.test(ua.toLowerCase())
      ? "mobile"
      : /ipad|tablet/i.test(ua.toLowerCase())
        ? "tablet"
        : "desktop";

    return { browser: browser, os: os, device: device };
  }

  function getUtm() {
    var params = new URLSearchParams(window.location.search);
    return {
      source: params.get("utm_source") || "",
      medium: params.get("utm_medium") || "",
      campaign: params.get("utm_campaign") || "",
      term: params.get("utm_term") || "",
      content: params.get("utm_content") || "",
    };
  }

  var uaInfo = parseUA();
  var utmData = getUtm();
  var geoData = { country: "", countryCode: "", region: "", city: "" };

  var context = {
    language: navigator.language || "",
    device: uaInfo.device,
    browser: uaInfo.browser,
    os: uaInfo.os,
    screenWidth: screen.width || 0,
    referrer: document.referrer || "",
    utm: utmData,
  };

  /* ───── PERSONALIZATION (kept intact) ───── */
  function getPersonalizationContext(geo) {
    var url = new URL(window.location.href);
    var search = url.searchParams;
    return {
      utm: {
        source: search.get("utm_source") || "",
        medium: search.get("utm_medium") || "",
        campaign: search.get("utm_campaign") || "",
        term: search.get("utm_term") || "",
        content: search.get("utm_content") || "",
      },
      device: uaInfo.device,
      lang: navigator.language || "",
      isReturning: _isReturning,
      url: url.pathname + url.search,
      referrer: document.referrer || "",
      geo: geo || { country: "", countryCode: "", region: "", city: "" },
    };
  }

  function compare(val, comparator, target) {
    if (val == null) val = "";
    if (target == null) target = "";
    if (comparator === "contains") return val.indexOf(target) !== -1;
    if (comparator === "startsWith") return val.indexOf(target) === 0;
    if (comparator === "endsWith") return val.slice(-target.length) === target;
    if (comparator === "greaterThan") return parseFloat(val) > parseFloat(target);
    if (comparator === "lessThan") return parseFloat(val) < parseFloat(target);
    if (comparator === "between") {
      var parts = target.split("-");
      if (parts.length === 2) {
        var n = parseFloat(val), lo = parseFloat(parts[0]), hi = parseFloat(parts[1]);
        return lo <= hi ? (n >= lo && n <= hi) : (n >= lo || n <= hi);
      }
      return false;
    }
    return val === target;
  }

  function timeMatches(cond) {
    var now = new Date();
    var key = cond.key || "hour";
    var comp = cond.comparator || "equals";
    var target = (cond.value || "").trim();
    if (key === "hour") return compare(String(now.getHours()), comp, target);
    if (key === "dayOfWeek") {
      var days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
      return compare(days[now.getDay()], comp, target.toLowerCase());
    }
    if (key === "timeRange") {
      var parts = target.split("-");
      if (parts.length !== 2) return false;
      var toMin = function(s) { var p = s.trim().split(":"); return parseInt(p[0]) * 60 + parseInt(p[1] || "0"); };
      var nowMin = now.getHours() * 60 + now.getMinutes();
      var startMin = toMin(parts[0]), endMin = toMin(parts[1]);
      if (startMin <= endMin) return nowMin >= startMin && nowMin <= endMin;
      return nowMin >= startMin || nowMin <= endMin;
    }
    return false;
  }

  function conditionMatches(cond, ctx) {
    if (cond.type === "always") return true;
    if (cond.type === "time") return timeMatches(cond);
    var v = "";
    if (cond.type === "utm") v = ctx.utm[cond.key] || "";
    else if (cond.type === "device") v = ctx.device;
    else if (cond.type === "language") v = ctx.lang;
    else if (cond.type === "newReturning") v = ctx.isReturning ? "returning" : "new";
    else if (cond.type === "url") v = ctx.url;
    else if (cond.type === "referrer") v = ctx.referrer;
    else if (cond.type === "geo") v = ctx.geo[cond.key] || "";
    return compare(v, cond.comparator || "equals", cond.value || "");
  }

  function ruleMatches(rule, ctx) {
    var now = new Date();
    if (rule.startDate && now < new Date(rule.startDate)) return false;
    if (rule.endDate && now > new Date(rule.endDate)) return false;
    if (!rule.conditions || !rule.conditions.length) return true;
    var res = rule.conditions.map(function (c) { return conditionMatches(c, ctx); });
    return rule.logic === "AND" ? res.every(Boolean) : res.some(Boolean);
  }

  function replaceTemplates(text, ctx) {
    return text.replace(/\{\{([^}]+)\}\}/g, function (match, key) {
      key = key.trim();
      if (key.indexOf("geo.") === 0) return ctx.geo[key.slice(4)] || "";
      if (key.indexOf("utm.") === 0) return ctx.utm[key.slice(4)] || "";
      if (key === "device") return ctx.device || "";
      if (key === "language") return ctx.lang || "";
      if (key === "url") return ctx.url || "";
      if (key === "referrer") return ctx.referrer || "";
      if (key === "visitorType") return ctx.isReturning ? "returning" : "new";
      return match;
    });
  }

  function applyMutations(el, mutations, ctx) {
    mutations.forEach(function (m) {
      if (m.field === "text") el.textContent = ctx ? replaceTemplates(m.value, ctx) : m.value;
      else if (m.field === "visible") {
        if (m.value === "false") el.style.display = "none";
        else if (m.value === "true") el.style.removeProperty("display");
      }
      else if (m.field === "href" && "href" in el) el.href = m.value;
      else if (m.field === "src") el.setAttribute("src", m.value);
      else if (m.field === "className") el.classList.add(m.value);
      else if (m.field === "style") {
        try {
          var styleObj = JSON.parse(m.value);
          Object.keys(styleObj).forEach(function (k) { el.style[k] = styleObj[k]; });
        } catch (e) {}
      }
      else if (m.field === "attribute" && m.attributeName) el.setAttribute(m.attributeName, m.value);
    });
  }

  function hashCode(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function pickSplitVariant(rule, elementId, variants) {
    if (!rule.splits || !rule.splits.length) {
      return variants.find(function (v) { return v.id === rule.variantId; }) || null;
    }
    var bucket = hashCode(visitorId + ":" + elementId + ":" + rule.id) % 100;
    var cumulative = 0;
    for (var i = 0; i < rule.splits.length; i++) {
      cumulative += rule.splits[i].weight;
      if (bucket < cumulative) {
        var vid = rule.splits[i].variantId;
        return variants.find(function (v) { return v.id === vid; }) || null;
      }
    }
    return null;
  }

  /* ───── EVENT QUEUE ───── */
  var pendingEvents = [];
  var flushTimer = null;
  var FLUSH_DELAY_MS = 1000;

  function queueEvent(evt) {
    evt.ts = Date.now();
    pendingEvents.push(evt);
    touchSession();
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushEvents, FLUSH_DELAY_MS);
  }

  function flushEvents() {
    flushTimer = null;
    if (!pendingEvents.length) return;
    var batch = pendingEvents.slice();
    pendingEvents = [];

    var payload = JSON.stringify({
      projectKey: projectKey,
      visitorId: visitorId,
      sessionId: sessionId,
      context: context,
      geo: geoData,
      events: batch,
    });

    try {
      fetch(baseUrl + "/public/ingest", {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "text/plain" },
        credentials: "omit",
        keepalive: true,
      }).catch(function () {
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon(baseUrl + "/public/ingest", new Blob([payload], { type: "text/plain" }));
          }
        } catch (e2) {}
      });
    } catch (e) {
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(baseUrl + "/public/ingest", new Blob([payload], { type: "text/plain" }));
        }
      } catch (e2) {}
    }
  }

  /* ───── PAGEVIEW TRACKING ───── */
  var currentPage = null;
  var pageEnteredAt = 0;
  var maxScrollDepth = 0;

  function trackPageview() {
    endCurrentPage();
    currentPage = window.location.pathname + window.location.search;
    pageEnteredAt = Date.now();
    maxScrollDepth = 0;

    queueEvent({
      type: "pageview",
      url: currentPage,
      title: document.title || "",
      referrer: document.referrer || "",
    });
  }

  function endCurrentPage() {
    if (!currentPage || !pageEnteredAt) return;
    var duration = Math.round((Date.now() - pageEnteredAt) / 1000);
    if (duration < 0) duration = 0;
    queueEvent({
      type: "pageview_end",
      url: currentPage,
      properties: { duration: duration, scrollDepth: maxScrollDepth },
    });
    currentPage = null;
    pageEnteredAt = 0;
    maxScrollDepth = 0;
  }

  /* ───── SCROLL DEPTH ───── */
  var scrollThrottle = null;
  function onScroll() {
    if (scrollThrottle) return;
    scrollThrottle = setTimeout(function () {
      scrollThrottle = null;
      var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var docHeight = Math.max(
        document.body.scrollHeight, document.documentElement.scrollHeight,
        document.body.offsetHeight, document.documentElement.offsetHeight
      );
      var winHeight = window.innerHeight;
      if (docHeight <= winHeight) { maxScrollDepth = 100; return; }
      var depth = Math.round((scrollTop + winHeight) / docHeight * 100);
      if (depth > maxScrollDepth) maxScrollDepth = depth;
    }, 200);
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ───── CLICK TRACKING ───── */
  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || !target.tagName) return;
    var el = target.closest("a, button, [role='button'], input[type='submit']");
    if (!el) return;

    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || el.value || "").trim().substring(0, 200);
    var href = el.getAttribute("href") || "";

    queueEvent({
      type: "click",
      url: window.location.pathname + window.location.search,
      properties: {
        tag: tag,
        text: text,
        href: href,
      },
    });
  }, true);

  /* ───── FORM TRACKING ───── */
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || form.tagName !== "FORM") return;
    queueEvent({
      type: "form_submit",
      url: window.location.pathname + window.location.search,
      properties: {
        formId: form.id || "",
        action: form.action || "",
        method: (form.method || "GET").toUpperCase(),
      },
    });
  }, true);

  /* ───── SPA NAVIGATION ───── */
  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;

  history.pushState = function () {
    origPushState.apply(this, arguments);
    onNavigation();
  };
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    onNavigation();
  };
  window.addEventListener("popstate", onNavigation);

  function onNavigation() {
    var newPage = window.location.pathname + window.location.search;
    if (newPage === currentPage) return;
    trackPageview();
  }

  /* ───── PAGE EXIT ───── */
  var sessionEndSent = false;

  function onPageExit() {
    endCurrentPage();
    if (!sessionEndSent) {
      sessionEndSent = true;
      queueEvent({ type: "session_end" });
    }
    flushEvents();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      onPageExit();
    } else if (document.visibilityState === "visible") {
      sessionEndSent = false;
    }
  });
  window.addEventListener("pagehide", onPageExit);

  /* ───── PUBLIC API ───── */
  window.segmentor = window.segmentor || {};
  window.segmentor.visitorId = visitorId;

  window.segmentor.track = function (name, properties) {
    if (!name || typeof name !== "string") return;
    queueEvent({
      type: "custom",
      name: name,
      url: window.location.pathname + window.location.search,
      properties: properties || {},
    });
  };

  window.segmentor.identify = function (email) {
    if (!email || typeof email !== "string") return;
    queueEvent({
      type: "identify",
      properties: { email: email.trim().toLowerCase() },
    });
  };

  /* ───── AUTO-TAG POLAR CHECKOUT LINKS ───── */
  var POLAR_HOSTS = ["polar.sh", "buy.polar.sh"];

  function tagPolarLinks() {
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      try {
        var u = new URL(a.href);
        var dominated = false;
        for (var j = 0; j < POLAR_HOSTS.length; j++) {
          if (u.hostname === POLAR_HOSTS[j] || u.hostname.endsWith("." + POLAR_HOSTS[j])) {
            dominated = true;
            break;
          }
        }
        if (!dominated) continue;
        if (u.searchParams.get("reference_id")) continue;
        u.searchParams.set("reference_id", visitorId);
        a.href = u.toString();
      } catch (e) {}
    }
  }

  function observePolarLinks() {
    tagPolarLinks();
    if (typeof MutationObserver !== "undefined") {
      var observer = new MutationObserver(function () { tagPolarLinks(); });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observePolarLinks);
  } else {
    observePolarLinks();
  }

  /* ───── PERSONALIZATION ENGINE ───── */
  var lastCtx = null;
  var flushedImpressionKeys = {};

  function applyConfig(config, geo) {
    var ctx = getPersonalizationContext(geo);
    lastCtx = ctx;
    config.elements.forEach(function (elem) {
      var nodes = document.querySelectorAll(elem.selector);
      if (!nodes.length) return;

      var activeVariant = null;
      var matchedRule = null;
      elem.rules
        .slice()
        .sort(function (a, b) { return a.priority - b.priority; })
        .some(function (rule) {
          if (rule.enabled && ruleMatches(rule, ctx)) {
            activeVariant = pickSplitVariant(rule, elem.id, elem.variants);
            if (activeVariant) matchedRule = rule;
            return !!activeVariant;
          }
          return false;
        });

      if (!activeVariant) return;
      nodes.forEach(function (node) {
        applyMutations(node, activeVariant.mutations, ctx);
      });

      var impKey = elem.id + ":" + activeVariant.id;
      if (!flushedImpressionKeys[impKey]) {
        flushedImpressionKeys[impKey] = true;
        queueEvent({
          type: "impression",
          elementId: elem.id,
          variantId: activeVariant.id,
          ruleId: matchedRule ? matchedRule.id : null,
          url: window.location.pathname,
          country: ctx.geo.country || "",
          countryCode: ctx.geo.countryCode || "",
          device: ctx.device || "",
        });
      }
    });
  }

  function applyWhenReady(config, geo) {
    function run() {
      applyConfig(config, geo);
      clearTimeout(foucTimer);
      reveal();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  }

  function retryApply(config, geo, maxRetries, interval) {
    var attempt = 0;
    function retry() {
      if (attempt >= maxRetries) return;
      attempt++;
      applyConfig(config, geo);
    }
    var iv = setInterval(retry, interval);
    setTimeout(function () { clearInterval(iv); }, maxRetries * interval + 100);
  }

  /* ───── INIT ───── */
  function fetchAndApply() {
    var configUrl = baseUrl + "/public/project-config?projectKey=" + encodeURIComponent(projectKey);
    var geoUrl = baseUrl + "/public/geo";

    Promise.all([
      fetch(configUrl, { credentials: "omit", cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : null; }),
      fetch(geoUrl, { credentials: "omit" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; }),
    ])
      .then(function (results) {
        var config = results[0];
        var geo = results[1] || { country: "", countryCode: "", region: "", city: "" };
        geoData = geo;

        trackPageview();

        if (!config || !config.elements || !config.elements.length) {
          clearTimeout(foucTimer);
          reveal();
          return;
        }
        applyWhenReady(config, geo);
        retryApply(config, geo, 5, 500);
      })
      .catch(function () {
        clearTimeout(foucTimer);
        reveal();
        trackPageview();
      });
  }

  fetchAndApply();
})();
