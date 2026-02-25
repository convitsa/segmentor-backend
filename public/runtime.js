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

  /* ───── EDIT MODE (element picker for Segmentor dashboard) ───── */
  var isEditMode =
    new URLSearchParams(window.location.search).get("segmentor_edit") === "1";

  if (isEditMode) return;

  /* ───── ANTI-FOUC: the inline snippet already hides the page
     via <style id="segmentor-hide">. We just need to reveal after mutations. ───── */
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

  /* ───── RUNTIME MODE (apply personalization) ───── */

  var _isReturning = document.cookie.indexOf("seg_returning=1") !== -1;
  if (!_isReturning) {
    var _exp = new Date();
    _exp.setFullYear(_exp.getFullYear() + 1);
    document.cookie =
      "seg_returning=1; path=/; expires=" + _exp.toUTCString();
  }

  function getContext(geo) {
    var url = new URL(window.location.href);
    var search = url.searchParams;
    var utm = {
      source: search.get("utm_source") || "",
      medium: search.get("utm_medium") || "",
      campaign: search.get("utm_campaign") || "",
      term: search.get("utm_term") || "",
      content: search.get("utm_content") || "",
    };
    var ua = navigator.userAgent.toLowerCase();
    var device = /mobile|iphone|android/.test(ua)
      ? "mobile"
      : /ipad|tablet/.test(ua)
        ? "tablet"
        : "desktop";
    var lang = navigator.language || "";
    return {
      utm: utm,
      device: device,
      lang: lang,
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
    if (comparator === "endsWith")
      return val.slice(-target.length) === target;
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

    if (key === "hour") {
      return compare(String(now.getHours()), comp, target);
    }
    if (key === "dayOfWeek") {
      var days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
      var today = days[now.getDay()];
      return compare(today, comp, target.toLowerCase());
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
    else if (cond.type === "newReturning")
      v = ctx.isReturning ? "returning" : "new";
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
    var res = rule.conditions.map(function (c) {
      return conditionMatches(c, ctx);
    });
    return rule.logic === "AND"
      ? res.every(Boolean)
      : res.some(Boolean);
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
      if (m.field === "text") {
        el.textContent = ctx ? replaceTemplates(m.value, ctx) : m.value;
      } else if (m.field === "visible") {
        if (m.value === "false") el.style.display = "none";
        else if (m.value === "true") el.style.removeProperty("display");
      } else if (m.field === "href" && "href" in el) {
        el.href = m.value;
      } else if (m.field === "src") {
        el.setAttribute("src", m.value);
      } else if (m.field === "className") {
        el.classList.add(m.value);
      } else if (m.field === "style") {
        try {
          var styleObj = JSON.parse(m.value);
          Object.keys(styleObj).forEach(function (k) {
            el.style[k] = styleObj[k];
          });
        } catch (e) {}
      } else if (m.field === "attribute" && m.attributeName) {
        el.setAttribute(m.attributeName, m.value);
      }
    });
  }

  function getVisitorId() {
    var match = document.cookie.match(/(?:^|; )seg_vid=([^;]+)/);
    if (match) return match[1];
    var id = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var expires = new Date();
    expires.setFullYear(expires.getFullYear() + 2);
    document.cookie = "seg_vid=" + id + "; path=/; expires=" + expires.toUTCString();
    return id;
  }

  var visitorId = getVisitorId();

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

  var lastCtx = null;

  function applyConfig(config, geo) {
    var ctx = getContext(geo);
    lastCtx = ctx;
    config.elements.forEach(function (elem) {
      var nodes = document.querySelectorAll(elem.selector);
      if (!nodes.length) return;

      var activeVariant = null;
      var matchedRule = null;
      elem.rules
        .slice()
        .sort(function (a, b) {
          return a.priority - b.priority;
        })
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
      pendingEvents.push({
        elementId: elem.id,
        variantId: activeVariant.id,
        ruleId: matchedRule ? matchedRule.id : null,
        type: "impression",
        visitorId: visitorId,
        url: window.location.pathname,
        country: ctx.geo.country || "",
        countryCode: ctx.geo.countryCode || "",
        device: ctx.device || "",
      });
    });
  }

  var pendingEvents = [];
  var trackTimer = null;
  var flushedEventKeys = {};

  function flushEvents() {
    if (!pendingEvents.length) return;
    var unique = [];
    pendingEvents.forEach(function (e) {
      var key = e.elementId + ":" + e.variantId;
      if (!flushedEventKeys[key]) {
        flushedEventKeys[key] = true;
        unique.push(e);
      }
    });
    pendingEvents = [];
    if (!unique.length) return;
    var payload = JSON.stringify({ projectKey: projectKey, events: unique });
    try {
      fetch(baseUrl + "/public/track", {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  function applyWhenReady(config, geo) {
    function run() {
      applyConfig(config, geo);
      clearTimeout(foucTimer);
      reveal();
      clearTimeout(trackTimer);
      trackTimer = setTimeout(flushEvents, 500);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  }

  /* SPA: if content loads late, retry applying mutations */
  function retryApply(config, geo, maxRetries, interval) {
    var attempt = 0;
    function retry() {
      if (attempt >= maxRetries) {
        flushEvents();
        return;
      }
      attempt++;
      applyConfig(config, geo);
    }
    var iv = setInterval(retry, interval);
    setTimeout(function () { clearInterval(iv); flushEvents(); }, maxRetries * interval + 100);
  }

  function fetchAndApply() {
    var configUrl =
      baseUrl +
      "/public/project-config?projectKey=" +
      encodeURIComponent(projectKey);
    var geoUrl = baseUrl + "/public/geo";

    Promise.all([
      fetch(configUrl, { credentials: "omit", cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : null; }),
      fetch(geoUrl, { credentials: "omit" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; })
    ])
      .then(function (results) {
        var config = results[0];
        var geo = results[1] || { country: "", countryCode: "", region: "", city: "" };

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
      });
  }

  fetchAndApply();
  window.addEventListener("popstate", function () {
    fetchAndApply();
  });
})();
