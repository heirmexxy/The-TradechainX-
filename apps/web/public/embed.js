/*!
 * TradeChainX widgets — embed live XOwn offerings and listings on a partner site.
 *
 *   <script src="https://tradechainx.com/embed.js" data-api="https://api.tradechainx.com" defer></script>
 *
 *   <div data-tradechainx="offering"   data-vault="0x…"   data-ref="yourcode"></div>
 *   <div data-tradechainx="offerings"  data-limit="3"     data-ref="yourcode"></div>
 *   <div data-tradechainx="buy-button" data-vault="0x…"   data-ref="yourcode"></div>
 *   <div data-tradechainx="buy-button" data-listing="12"  data-ref="yourcode" data-label="Invest now"></div>
 *
 * Optional: data-theme="dark". Widgets render in a Shadow DOM so the host page's CSS can't break them.
 * No payments happen on the partner site: buttons open TradeChainX, where the buyer signs in, is
 * verified, and completes the purchase. data-ref credits the sale to the partner.
 * Dependency-free, ~8 KB, no cookies, no tracking.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var API = ((script && script.getAttribute("data-api")) || "https://api.tradechainx.com").replace(/\/$/, "");

  var CSS =
    ":host{all:initial;display:block;font-family:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;color:#141C3F}" +
    ".card{border:1px solid #D9DDE6;border-radius:8px;background:#fff;padding:16px;max-width:360px;box-sizing:border-box}" +
    ".dark .card{background:#141C3F;border-color:#2B3A78;color:#F1F3FA}" +
    ".eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7285;margin:0 0 4px}" +
    ".dark .eyebrow{color:#AEB3C2}" +
    "h3{font-size:17px;line-height:1.3;margin:0 0 6px;font-weight:600}" +
    "p{font-size:13px;line-height:1.45;margin:0 0 10px;color:#3B4256}" +
    ".dark p{color:#E4E8F4}" +
    ".row{display:flex;justify-content:space-between;font-size:13px;margin:4px 0}" +
    ".row b{font-weight:600}" +
    ".bar{height:6px;border-radius:3px;background:#E4E8F4;overflow:hidden;margin:10px 0 4px}" +
    ".bar i{display:block;height:100%;background:#2F7D4F}" +
    ".btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;margin-top:12px;padding:10px 14px;border-radius:6px;background:#1E2A5A;color:#fff;font-weight:600;font-size:14px;line-height:1;font-family:inherit;text-decoration:none;cursor:pointer;border:0}" +
    ".btn:hover{background:#2B3A78}.btn.inline{width:auto}" +
    ".btn[aria-disabled=true]{background:#AEB3C2;pointer-events:none}" +
    ".by{font-size:11px;color:#6B7285;margin-top:10px;text-align:right}.by a{color:inherit}" +
    ".grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}" +
    ".err{font-size:13px;color:#B42318}";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function q(ref) {
    return ref && /^[a-z0-9]{4,16}$/.test(ref) ? "?ref=" + encodeURIComponent(ref) : "";
  }

  function get(path) {
    return fetch(API + path, { credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function mount(host) {
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.innerHTML = "";
    var style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    var wrap = el("div", host.getAttribute("data-theme") === "dark" ? "dark" : "");
    root.appendChild(wrap);
    return wrap;
  }

  function button(href, label, open) {
    var a = el("a", "btn", label);
    if (open) {
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
    } else {
      a.setAttribute("aria-disabled", "true");
    }
    return a;
  }

  function byline() {
    var d = el("div", "by");
    d.appendChild(document.createTextNode("Powered by "));
    var a = el("a", null, "TradeChainX");
    a.href = "https://tradechainx.com";
    a.target = "_blank";
    a.rel = "noopener";
    d.appendChild(a);
    return d;
  }

  function offeringCard(o, label) {
    var c = el("div", "card");
    c.appendChild(el("p", "eyebrow", "XOwn \u00b7 " + (o.equipmentType || "Equipment") + (o.location ? " \u00b7 " + o.location : "")));
    c.appendChild(el("h3", null, o.name));
    if (o.description) c.appendChild(el("p", null, o.description));
    var r1 = el("div", "row");
    r1.appendChild(el("span", null, "Price per share"));
    r1.appendChild(el("b", null, o.pricePerShareUsdc + " USDC"));
    c.appendChild(r1);
    if (o.expectedAnnualYieldPct != null) {
      var r2 = el("div", "row");
      r2.appendChild(el("span", null, "Expected yearly earnings"));
      r2.appendChild(el("b", null, o.expectedAnnualYieldPct + "% (not guaranteed)"));
      c.appendChild(r2);
    }
    var bar = el("div", "bar");
    var fill = el("i");
    fill.style.width = Math.min(100, o.percentFunded) + "%";
    bar.appendChild(fill);
    c.appendChild(bar);
    c.appendChild(el("div", "row", o.percentFunded + "% funded \u00b7 closes " + new Date(o.deadline * 1000).toLocaleDateString()));
    var open = o.state === "fundraising";
    c.appendChild(button(o.url, open ? label || "View and invest" : "Closed", open));
    c.appendChild(byline());
    return c;
  }

  var renderers = {
    offering: function (host, wrap) {
      var vault = host.getAttribute("data-vault");
      return get("/embed/v1/offerings/" + vault + q(host.getAttribute("data-ref"))).then(function (d) {
        wrap.appendChild(offeringCard(d.offering, host.getAttribute("data-label")));
      });
    },
    offerings: function (host, wrap) {
      var limit = Number(host.getAttribute("data-limit") || 3);
      var ref = host.getAttribute("data-ref");
      return get("/embed/v1/offerings" + (q(ref) ? q(ref) + "&" : "?") + "limit=" + limit).then(function (d) {
        var g = el("div", "grid");
        d.offerings.forEach(function (o) {
          g.appendChild(offeringCard(o, host.getAttribute("data-label")));
        });
        if (!d.offerings.length) g.appendChild(el("p", null, "No open offerings right now."));
        wrap.appendChild(g);
      });
    },
    "buy-button": function (host, wrap) {
      var ref = q(host.getAttribute("data-ref"));
      var vault = host.getAttribute("data-vault");
      var listing = host.getAttribute("data-listing");
      var path = vault ? "/embed/v1/offerings/" + vault + ref : "/embed/v1/listings/" + listing + ref;
      return get(path).then(function (d) {
        var item = d.offering || d.listing;
        var open = d.offering ? item.state === "fundraising" : item.status === "for_sale";
        var label = host.getAttribute("data-label") || (d.offering ? "Invest on TradeChainX" : "Buy on TradeChainX");
        var b = button(item.url, open ? label : "No longer available", open);
        b.className += " inline";
        wrap.appendChild(b);
      });
    },
  };

  function render(host) {
    var kind = host.getAttribute("data-tradechainx");
    var fn = renderers[kind];
    if (!fn || host.__tcx) return;
    host.__tcx = true;
    var wrap = mount(host);
    fn(host, wrap).catch(function () {
      wrap.appendChild(el("p", "err", "This TradeChainX widget couldn't load."));
    });
  }

  function scan() {
    var nodes = document.querySelectorAll("[data-tradechainx]");
    for (var i = 0; i < nodes.length; i++) render(nodes[i]);
  }

  window.TradeChainX = { render: render, scan: scan };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
