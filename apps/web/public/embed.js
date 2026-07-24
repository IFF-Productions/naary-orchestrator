/**
 * Naary embed loader (docs/design/EMBEDDED-PUBLIC-PAGES.md, Slice 2). Served static from our origin.
 * A tenant drops this on their site to embed a hosted form/chat WITHOUT hand-writing an iframe:
 *
 *   <script src="https://app.naar-y.com/embed.js" async></script>
 *   <div data-naary-form="FORM_ID"></div>   (or data-naary-chat="CHAT_ID")
 *
 * For each such element it injects an <iframe src=".../f/ID?embed=1"> (chrome-less render) and
 * auto-resizes it to the content: the embedded page postMessages its height ("naary:resize"); we
 * accept those messages ONLY from our own origin. Same-origin inside the frame → no CORS. Protection
 * stays with Turnstile + rate limits + the tenant budget cap. Vanilla ES5-ish, no dependencies.
 */
(function () {
  "use strict";
  // Our origin = where THIS script was loaded from (so the injected iframe + the origin check match).
  var self = document.currentScript;
  var ORIGIN = self ? new URL(self.src, location.href).origin : location.origin;

  function mount(el, kind, id) {
    if (!id || el.getAttribute("data-naary-mounted")) return;
    el.setAttribute("data-naary-mounted", "1");
    var iframe = document.createElement("iframe");
    var path = kind === "chat" ? "/c/" : "/f/";
    iframe.src = ORIGIN + path + encodeURIComponent(id) + "?embed=1";
    iframe.title = kind === "chat" ? "Chat" : "Form";
    iframe.loading = "lazy";
    iframe.setAttribute("data-naary-id", id);
    iframe.style.cssText =
      "border:0;width:100%;max-width:480px;height:" +
      (kind === "chat" ? "600" : "640") +
      "px;transition:height .15s ease;";
    el.appendChild(iframe);
  }

  function scan() {
    var forms = document.querySelectorAll("[data-naary-form]");
    for (var i = 0; i < forms.length; i++) {
      mount(forms[i], "form", forms[i].getAttribute("data-naary-form"));
    }
    var chats = document.querySelectorAll("[data-naary-chat]");
    for (var j = 0; j < chats.length; j++) {
      mount(chats[j], "chat", chats[j].getAttribute("data-naary-chat"));
    }
  }

  // Auto-resize: trust height messages ONLY from our own iframe origin.
  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || d.type !== "naary:resize" || typeof d.height !== "number") return;
    var frames = document.querySelectorAll("iframe[data-naary-id]");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].getAttribute("data-naary-id") === d.id) {
        frames[i].style.height = Math.max(0, Math.round(d.height)) + "px";
      }
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
