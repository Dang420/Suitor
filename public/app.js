/* ============ Suitor — production frontend (API-driven) ============ */
(function () {
  "use strict";

  var AVATAR_COLORS = ["#ff5c8a", "#8a5cf6", "#3aa8ff", "#2fbf71", "#f2a14e", "#f2c14e"];

  /* ---------------- Conversation openers ----------------
     Tappable first-message suggestions shown in an empty thread.
     Tap fills the input (user can edit before sending) — never auto-sends. */
  var OPENERS = [
    "Quick — what's the most spontaneous thing you've ever done?",
    "I was going to open with something clever, but your smile beat me to it.",
    "Let's skip the small talk — what's your idea of a perfect night?",
    "What's something small that always makes your day better?",
    "Two truths and a lie — you go first.",
    "Fair warning: I'm much more charming in person. Coffee will prove it.",
    "Be honest — did you feel that spark too, or is it just me?",
    "You have kind eyes. I had to say hi.",
    "What's your most controversial food opinion?",
    "You seem like someone with great stories. Tell me your favorite one.",
    "Dinner's on me if you can make me laugh in the next five minutes.",
    "What's a dream you're still chasing?",
    "I have a feeling you're trouble. Confirm or deny.",
    "I don't usually do this, but some people are worth the tokens.",
    "I'm only here for one reason, and it's you. Hi.",
    "Tell me about the best day you've had this year.",
    "On a scale of 1 to 'let's elope,' how adventurous are you?",
    "What's your go-to late-night craving?",
    "Beach day or city night?",
    "What song do you have on repeat right now?",
    "Coffee or cocktails for a first date?",
    "What's the best trip you've ever taken?",
    "Are you a 'plan everything' person or a 'let's see where the night goes' person?",
    "What's something you're weirdly good at?"
  ];

  function pickOpeners(n) {
    var copy = OPENERS.slice(), out = [];
    while (out.length < n && copy.length) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
  }

  function renderOpeners() {
    var peer = S.threadPeer;
    var wrap = el(
      '<div class="empty-state"><div class="e-emoji">👋</div>' +
      "<h3>Say hi to " + esc(peer.name) + "</h3>" +
      "<p>First impressions count. Tap one to use it:</p>" +
      '<div class="opener-chips"></div></div>'
    );
    var chips = wrap.querySelector(".opener-chips");
    function fill() {
      chips.innerHTML = "";
      pickOpeners(3).forEach(function (text) {
        var b = el('<button class="opener-chip" type="button">' + esc(text) + "</button>");
        b.addEventListener("click", function () {
          var input = document.getElementById("t-input");
          if (input) {
            input.value = text;
            input.focus();
            input.style.height = "auto";
            input.style.height = Math.min(input.scrollHeight, 110) + "px";
          }
        });
        chips.appendChild(b);
      });
      var sh = el('<button class="opener-shuffle" type="button">↻ new ones</button>');
      sh.addEventListener("click", function (e) { e.preventDefault(); fill(); });
      chips.appendChild(sh);
    }
    fill();
    return wrap;
  }

  /* ---------------- State (in-memory only; truth lives on the server) ---------------- */
  var S = {
    user: null,          // { id, name, gender, age, avatarColor, bio, tokenBalance }
    cfg: { costPerMessage: 10, welcomeTokens: 25, paypalConfigured: false, paypalClientId: null },
    route: "welcome",
    threadConv: null,    // conversation id
    threadPeer: null,    // peer user object
    wallet: { balance: 0, packs: [] },
  };

  /* ---------------- API ---------------- */
  function api(path, opts) {
    opts = opts || {};
    return fetch("/api" + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || "request_failed");
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------------- Helpers ---------------- */
  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function fmtTime(ts) {
    var d = new Date(ts), h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }

  function fmtDateTime(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString() + " " + fmtTime(ts);
  }

  function toast(msg) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var t = el('<div class="toast">' + esc(msg) + "</div>");
    document.getElementById("root").appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }

  function modal(html) {
    closeModal();
    var o = el('<div class="modal-overlay"><div class="modal">' + html + "</div></div>");
    o.addEventListener("click", function (e) { if (e.target === o) closeModal(); });
    document.getElementById("root").appendChild(o);
  }

  function closeModal() {
    var o = document.querySelector(".modal-overlay");
    if (o) o.remove();
  }

  function openTopup(cost) {
    modal(
      '<div class="m-emoji">🪙</div>' +
      "<h3>Out of tokens</h3>" +
      "<p>You need " + cost + " tokens per message to keep chatting. Top up to continue the conversation.</p>" +
      '<div class="m-actions">' +
      '<button class="btn-gold" id="m-topup">Get tokens</button>' +
      '<button class="btn-secondary" id="m-close">Maybe later</button>' +
      "</div>"
    );
    document.getElementById("m-topup").addEventListener("click", function () {
      closeModal();
      go("wallet");
    });
    document.getElementById("m-close").addEventListener("click", closeModal);
  }

  /* ---------------- Shell ---------------- */
  var root;
  var pollTimer = null;
  var unreadTimer = null;

  function render() {
    stopPolling();
    root.innerHTML = "";
    closeModal();

    if (S.route === "auth") { vAuth(); return; }
    if (S.route === "welcome" || !S.user) { vWelcome(); return; }

    var header = el(
      '<header class="app-header">' +
      '<div class="logo">Suitor</div>' +
      '<div class="header-right">' +
      (S.user.gender === "gent"
        ? '<button class="token-pill" id="wallet-pill">🪙 <span id="pill-balance">' + S.user.tokenBalance + "</span></button>"
        : '<div class="token-pill free">💬 Free forever</div>') +
      '<button class="logout-btn" id="logout-btn" title="Log out">Log out</button>' +
      "</div>" +
      "</header>"
    );
    root.appendChild(header);
    var pill = document.getElementById("wallet-pill");
    if (pill) pill.addEventListener("click", function () { go("wallet"); });
    document.getElementById("logout-btn").addEventListener("click", function () {
      api("/auth/logout", { method: "POST" }).catch(function () {}).then(function () {
        S.user = null;
        go("welcome");
      });
    });

    var screen = el('<main class="screen" id="screen"></main>');
    root.appendChild(screen);

    if (S.route === "discover") vDiscover(screen);
    else if (S.route === "chats") vChats(screen);
    else if (S.route === "wallet") vWallet(screen);
    else if (S.route === "thread") vThread(screen);

    if (S.route !== "thread") {
      var nav = el(
        '<nav class="bottom-nav">' +
        navBtn("discover", "✨", "Discover") +
        navBtn("chats", "💬", "Chats", S._totalUnread > 0) +
        navBtn("wallet", "🪙", "Wallet") +
        "</nav>"
      );
      root.appendChild(nav);
      nav.querySelectorAll(".nav-btn").forEach(function (b) {
        b.addEventListener("click", function () { go(b.dataset.route); });
      });
      startUnreadPoller();
    }
  }

  function navBtn(route, emoji, label, dot) {
    return (
      '<button class="nav-btn' + (S.route === route ? " active" : "") + '" data-route="' + route + '">' +
      '<span class="n-emoji">' + emoji + "</span>" + esc(label) +
      (dot ? '<span class="nav-dot"></span>' : "") +
      "</button>"
    );
  }

  function go(route, arg) {
    S.route = route;
    if (route === "thread") {
      S.threadConv = arg.convId;
      S.threadPeer = arg.peer;
    }
    render();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (unreadTimer) { clearInterval(unreadTimer); unreadTimer = null; }
  }

  function startUnreadPoller() {
    refreshUnreadDot();
    unreadTimer = setInterval(refreshUnreadDot, 15000);
  }

  function refreshUnreadDot() {
    if (!S.user || S.route === "thread") return;
    api("/conversations").then(function (d) {
      var total = 0;
      d.conversations.forEach(function (c) { total += c.unread || 0; });
      var changed = total !== (S._totalUnread || 0);
      S._totalUnread = total;
      if (changed) {
        var nav = document.querySelector(".bottom-nav");
        if (nav) {
          var chatsBtn = nav.querySelector('[data-route="chats"]');
          var dot = chatsBtn.querySelector(".nav-dot");
          if (total > 0 && !dot) chatsBtn.insertAdjacentHTML("beforeend", '<span class="nav-dot"></span>');
          if (total === 0 && dot) dot.remove();
        }
      }
    }).catch(function () {});
  }

  /* ---------------- Views ---------------- */

  function vWelcome() {
    var s = el('<main class="screen no-nav"><div class="welcome"></div></main>');
    var w = s.firstChild;
    w.innerHTML =
      '<div class="big-logo">Suitor</div>' +
      '<div class="tagline">Ladies chat free. Gentlemen, bring tokens.</div>' +
      '<div class="how-it-works">' +
      howStep("💃", "<strong>Ladies</strong> chat completely free. Always.") +
      howStep("🪙", "<strong>Gentlemen</strong> spend " + S.cfg.costPerMessage + " tokens per message to a lady.") +
      howStep("🔞", "<strong>18+</strong> only. Real people, real conversations.") +
      "</div>" +
      '<button class="btn-primary" id="w-start">Get started</button>' +
      '<button class="btn-secondary" id="w-login" style="margin-top:10px">I already have an account</button>';
    root.appendChild(s);
    document.getElementById("w-start").addEventListener("click", function () { go("auth"); });
    document.getElementById("w-login").addEventListener("click", function () {
      S._authTab = "login";
      go("auth");
    });
  }

  function howStep(emoji, text) {
    return '<div class="how-step"><div class="emoji">' + emoji + '</div><div class="step-text">' + text + "</div></div>";
  }

  var ob = { tab: "signup", name: "", email: "", password: "", age: "", gender: null, color: AVATAR_COLORS[0], bio: "", inviteCode: "" };

  function vAuth() {
    var tab = S._authTab || "signup";
    ob.tab = tab;
    var s = el('<main class="screen no-nav"><div class="onboard"></div></main>');
    var o = s.firstChild;

    var tabsHtml =
      '<div style="display:flex;gap:10px;margin-bottom:24px">' +
      '<button class="chat-btn' + (tab === "signup" ? " has-unread" : "") + '" data-tab="signup" style="flex:1">Sign up</button>' +
      '<button class="chat-btn' + (tab === "login" ? " has-unread" : "") + '" data-tab="login" style="flex:1">Log in</button>' +
      "</div>";

    if (tab === "login") {
      o.innerHTML =
        "<h1>Welcome back</h1>" +
        '<div class="sub">Log in to keep chatting.</div>' +
        tabsHtml +
        '<div class="field"><label>Email</label>' +
        '<input class="text-input" id="ob-email" type="email" placeholder="you@example.com"></div>' +
        '<div class="field"><label>Password</label>' +
        '<input class="text-input" id="ob-password" type="password" placeholder="••••••••"></div>' +
        '<button class="btn-primary" id="ob-go">Log in</button>';
    } else {
      o.innerHTML =
        "<h1>Join Suitor</h1>" +
        '<div class="sub">18+ only. Thirty seconds, then you\'re in.</div>' +
        tabsHtml +
        '<div class="field"><label>Your name</label>' +
        '<input class="text-input" id="ob-name" maxlength="24" placeholder="What should we call you?"></div>' +
        '<div class="field"><label>Email</label>' +
        '<input class="text-input" id="ob-email" type="email" placeholder="you@example.com"></div>' +
        '<div class="field"><label>Password (8+ characters)</label>' +
        '<input class="text-input" id="ob-password" type="password" placeholder="••••••••"></div>' +
        '<div class="field"><label>Age (must be 18+)</label>' +
        '<input class="text-input" id="ob-age" type="number" min="18" max="120" placeholder="25"></div>' +
        '<div class="field"><label>I am a...</label><div class="gender-cards">' +
        '<button class="gender-card" data-g="lady">' +
        '<div class="g-emoji">💃</div><div class="g-name">Lady</div><div class="g-note">Chat free · invite only</div></button>' +
        '<button class="gender-card" data-g="gent">' +
        '<div class="g-emoji">🤵</div><div class="g-name">Gentleman</div><div class="g-note">' + S.cfg.costPerMessage + " tokens per message</div></button>" +
        "</div></div>" +
        '<div class="field" id="ob-invite-wrap" style="display:none"><label>Invite code <span style="opacity:.65">(ladies only)</span></label>' +
        '<input class="text-input" id="ob-invite" placeholder="LADY-XXXX-XX" autocomplete="off" autocapitalize="characters"></div>' +
        '<div class="field"><label>Pick your color</label><div class="color-row" id="ob-colors"></div></div>' +
        '<div class="field"><label>Bio (optional)</label>' +
        '<input class="text-input" id="ob-bio" maxlength="160" placeholder="A line about you..."></div>' +
        '<button class="btn-primary" id="ob-go">Start chatting</button>';
    }
    root.appendChild(s);

    o.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { S._authTab = b.dataset.tab; render(); });
    });

    if (tab === "signup") {
      var colors = document.getElementById("ob-colors");
      AVATAR_COLORS.forEach(function (c) {
        var d = el('<button class="color-dot' + (ob.color === c ? " selected" : "") + '" style="background:' + c + '"></button>');
        d.addEventListener("click", function () {
          ob.color = c;
          colors.querySelectorAll(".color-dot").forEach(function (x) { x.classList.remove("selected"); });
          d.classList.add("selected");
        });
        colors.appendChild(d);
      });
      o.querySelectorAll(".gender-card").forEach(function (card) {
        card.addEventListener("click", function () {
          ob.gender = card.dataset.g;
          o.querySelectorAll(".gender-card").forEach(function (x) { x.classList.remove("selected"); });
          card.classList.add("selected");
          var wrap = document.getElementById("ob-invite-wrap");
          if (wrap) wrap.style.display = ob.gender === "lady" ? "" : "none";
        });
      });
    }

    document.getElementById("ob-go").addEventListener("click", function () {
      var btn = document.getElementById("ob-go");
      btn.disabled = true;
      var done = function () { btn.disabled = false; };

      if (tab === "login") {
        api("/auth/login", {
          method: "POST",
          body: {
            email: document.getElementById("ob-email").value,
            password: document.getElementById("ob-password").value,
          },
        }).then(function (d) {
          S.user = d.user;
          S._authTab = null;
          go("discover");
        }).catch(function (e) {
          done();
          toast(e.data && e.data.error === "invalid_credentials" ? "Wrong email or password" : "Login failed");
        });
        return;
      }

      // signup
      var age = parseInt(document.getElementById("ob-age").value, 10);
      var inviteCode = document.getElementById("ob-invite").value;
      var payload = {
        name: document.getElementById("ob-name").value,
        email: document.getElementById("ob-email").value,
        password: document.getElementById("ob-password").value,
        age: age,
        gender: ob.gender,
        avatarColor: ob.color,
        bio: document.getElementById("ob-bio").value,
        inviteCode: inviteCode,
      };
      if (!payload.name.trim()) { done(); toast("Tell us your name first"); return; }
      if (!ob.gender) { done(); toast("Pick Lady or Gentleman"); return; }
      if (ob.gender === "lady" && !inviteCode.trim()) { done(); toast("Ladies join with an invite code — ask whoever invited you"); return; }
      if (!age || age < 18) { done(); toast("You must be 18 or older"); return; }
      api("/auth/signup", { method: "POST", body: payload }).then(function (d) {
        S.user = d.user;
        S._authTab = null;
        if (d.user.gender === "gent") toast("+" + S.cfg.welcomeTokens + " tokens on the house 🪙");
        go("discover");
      }).catch(function (e) {
        done();
        var msg = "Signup failed";
        if (e.data) {
          if (e.data.error === "email_taken") msg = "That email is already registered";
          else if (e.data.error === "must_be_18") msg = "You must be 18 or older";
          else if (e.data.error === "password_too_short") msg = "Password needs 8+ characters";
          else if (e.data.error === "invalid_email") msg = "That email doesn't look right";
          else if (e.data.error === "invite_required") msg = "Ladies join with an invite code — ask whoever invited you";
          else if (e.data.error === "invite_invalid") msg = "That invite code doesn't look right — check it and try again";
          else if (e.data.error === "invite_revoked") msg = "That invite code was revoked — ask for a fresh one";
          else if (e.data.error === "invite_exhausted") msg = "That invite code has already been used up";
        }
        toast(msg);
      });
    });
  }

  function vDiscover(screen) {
    var head = el(
      '<div class="discover-head"><h2>Discover</h2>' +
      "<p>" + (S.user.gender === "gent"
        ? "Real people. Say hello — " + S.cfg.costPerMessage + " tokens per message."
        : "Real people. Everyone's free for you. Go say hi.") + "</p></div>"
    );
    screen.appendChild(head);
    var grid = el('<div class="profile-grid"></div>');
    grid.appendChild(el('<div class="empty-state"><div class="e-emoji">🔍</div><p>Loading people…</p></div>'));
    screen.appendChild(grid);

    api("/discover").then(function (d) {
      grid.innerHTML = "";
      if (!d.users.length) {
        grid.appendChild(el(
          '<div class="empty-state" style="grid-column:1/-1"><div class="e-emoji">🌱</div>' +
          "<h3>You're early</h3><p>No one else here yet — check back soon.</p></div>"
        ));
        return;
      }
      d.users.forEach(function (p) {
        var card = el(
          '<div class="profile-card">' +
          '<div class="profile-photo" style="background:' + esc(p.avatarColor) + '">' + esc(p.name.charAt(0).toUpperCase()) + "</div>" +
          '<div class="profile-info"><div class="p-name">' + esc(p.name) + ", " + p.age + "</div>" +
          '<div class="p-bio">' + esc(p.bio || "—") + "</div>" +
          '<button class="chat-btn' + (p.unread ? " has-unread" : "") + '">' +
          (p.unread ? "Reply (" + p.unread + ")" : "Chat") + "</button></div></div>"
        );
        card.querySelector(".chat-btn").addEventListener("click", function () { openThread(p); });
        grid.appendChild(card);
      });
    }).catch(function () {
      grid.innerHTML = "";
      grid.appendChild(el('<div class="empty-state" style="grid-column:1/-1"><p>Couldn\'t load people. Try again.</p></div>'));
    });
  }

  function openThread(peer) {
    api("/conversations", { method: "POST", body: { peerId: peer.id } }).then(function (d) {
      go("thread", { convId: d.conversation.id, peer: peer });
    }).catch(function (e) {
      toast(e.data && e.data.error === "blocked" ? "You can't chat with this person" : "Couldn't open chat");
    });
  }

  function vChats(screen) {
    var head = el('<div class="discover-head"><h2>Chats</h2><p>Your conversations live here.</p></div>');
    screen.appendChild(head);
    var list = el('<div class="chat-list"></div>');
    screen.appendChild(list);

    api("/conversations").then(function (d) {
      list.innerHTML = "";
      if (!d.conversations.length) {
        list.appendChild(el(
          '<div class="empty-state"><div class="e-emoji">💌</div>' +
          "<h3>No chats yet</h3><p>Head to Discover and start something.</p></div>"
        ));
        return;
      }
      var total = 0;
      d.conversations.forEach(function (c) {
        total += c.unread || 0;
        if (!c.peer) return;
        var row = el(
          '<button class="chat-row">' +
          '<div class="avatar" style="background:' + esc(c.peer.avatarColor) + '">' + esc(c.peer.name.charAt(0).toUpperCase()) + "</div>" +
          '<div class="c-info"><div class="c-name">' + esc(c.peer.name) + "</div>" +
          '<div class="c-preview">' + esc(c.lastBody || "") + "</div></div>" +
          (c.unread ? '<div class="unread-badge">' + c.unread + "</div>" : "") +
          "</button>"
        );
        row.addEventListener("click", function () { go("thread", { convId: c.id, peer: c.peer }); });
        list.appendChild(row);
      });
      S._totalUnread = total;
    }).catch(function () {
      list.innerHTML = "";
      list.appendChild(el('<div class="empty-state"><p>Couldn\'t load chats.</p></div>'));
    });
  }

  function vWallet(screen) {
    var head = el('<div class="wallet-head"><div class="w-label">Token balance</div><div class="w-balance">🪙 …</div></div>');
    screen.appendChild(head);
    var list = el('<div class="pack-list"></div>');
    screen.appendChild(list);

    api("/wallet").then(function (w) {
      S.wallet = w;
      head.querySelector(".w-balance").textContent = "🪙 " + w.balance;
      head.insertAdjacentHTML("beforeend",
        '<div class="w-sub">' + (S.user.gender === "gent"
          ? S.cfg.costPerMessage + " tokens per message to a lady"
          : "You're a lady — chatting is free, but tokens make great gifts.") + "</div>");

      if (!w.packs.length) return;
      w.packs.forEach(function (pack) {
        var card = el(
          '<div class="pack-col">' +
          (pack.tag ? '<div class="p-tag">' + esc(pack.tag) + "</div>" : "") +
          '<div class="pack-row"><div><div class="p-tokens">🪙 ' + pack.tokens + "</div>" +
          '<div class="pack-sub">tokens</div></div>' +
          '<div class="p-price">' + esc(pack.price) + "</div></div>" +
          '<div class="pp-slot"></div>' +
          "</div>"
        );
        list.appendChild(card);
        var slot = card.querySelector(".pp-slot");
        if (w.paypalConfigured && S.cfg.paypalClientId) {
          mountPayPalButton(slot, pack);
        } else {
          slot.innerHTML = '<div class="wallet-note" style="padding:0">Payments aren\'t connected yet.</div>';
        }
      });
      list.insertAdjacentHTML("afterend",
        '<div class="wallet-note">' +
        (w.paypalConfigured
          ? "Secured by PayPal (" + esc(w.paypalMode) + " mode). Tokens land after verified payment."
          : "Demo state — connect PayPal to accept real payments.") +
        "</div>");
    }).catch(function () {
      head.querySelector(".w-balance").textContent = "🪙 —";
    });
  }

  function loadPayPalSdk(cb) {
    if (window.paypal) { cb(); return; }
    var s = document.createElement("script");
    s.src = "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(S.cfg.paypalClientId) +
            "&currency=USD&intent=capture";
    s.onload = cb;
    s.onerror = function () { toast("Couldn't load PayPal"); };
    document.head.appendChild(s);
  }

  function mountPayPalButton(slot, pack) {
    loadPayPalSdk(function () {
      if (!window.paypal) return;
      window.paypal.Buttons({
        style: { layout: "horizontal", color: "gold", shape: "pill", label: "pay", height: 44 },
        createOrder: function () {
          return api("/wallet/create-order", { method: "POST", body: { packId: pack.id } })
            .then(function (d) { return d.orderId; });
        },
        onApprove: function (data) {
          return api("/wallet/capture", { method: "POST", body: { orderId: data.orderID } })
            .then(function (d) {
              S.user.tokenBalance = d.balance;
              toast("+" + d.tokens + " tokens added 🪙");
              render();
            });
        },
        onError: function () { toast("Payment didn't go through — try again"); },
        onCancel: function () { toast("Payment cancelled"); },
      }).render(slot);
    });
  }

  /* ---------------- Thread ---------------- */

  var threadEls = {};
  var lastMsgTs = 0;

  function messageCost(peer) {
    if (!S.user || !peer) return 0;
    return (S.user.gender === "gent" && peer.gender === "lady") ? S.cfg.costPerMessage : 0;
  }

  function vThread(screen) {
    var peer = S.threadPeer;
    var convId = S.threadConv;
    if (!peer || !convId) { go("chats"); return; }

    root.innerHTML = "";
    var t = el('<div class="thread"></div>');

    var cost = messageCost(peer);
    var head = el(
      '<div class="thread-header">' +
      '<button class="back-btn" id="t-back">‹</button>' +
      '<div class="avatar" style="background:' + esc(peer.avatarColor) + ';width:44px;height:44px;font-size:19px">' +
        esc(peer.name.charAt(0).toUpperCase()) + "</div>" +
      '<div class="t-info"><div class="t-name">' + esc(peer.name) + ", " + peer.age + "</div>" +
      '<div class="t-sub">' + (cost > 0
        ? '<span class="gold">🪙 ' + cost + " tokens</span> per message"
        : "Free chat") + "</div></div>" +
      '<button class="back-btn" id="t-more" style="font-size:20px">⋯</button>' +
      "</div>"
    );
    t.appendChild(head);

    if (cost > 0) {
      t.appendChild(el('<div class="cost-hint">Gentlemen spend ' + cost + " tokens per message to ladies</div>"));
    }

    var msgs = el('<div class="thread-messages" id="t-msgs"></div>');
    t.appendChild(msgs);

    var bar = el(
      '<div class="thread-input-bar">' +
      '<button class="concierge-btn" id="t-concierge" type="button" title="Concierge — draft help">✨</button>' +
      '<textarea class="thread-input" id="t-input" rows="1" placeholder="Message ' + esc(peer.name) + '…"></textarea>' +
      '<button class="send-btn" id="t-send">➤</button></div>'
    );
    t.appendChild(bar);
    root.appendChild(t);

    threadEls = { msgs: msgs };
    lastMsgTs = 0;

    document.getElementById("t-back").addEventListener("click", function () { go("chats"); });
    document.getElementById("t-more").addEventListener("click", function () { openPeerMenu(peer); });
    document.getElementById("t-concierge").addEventListener("click", function () { openConcierge(convId, peer); });

    var input = document.getElementById("t-input");
    var sendBtn = document.getElementById("t-send");
    var doSend = function () { sendThreadMessage(convId, peer); };
    sendBtn.addEventListener("click", doSend);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 110) + "px";
    });

    fetchMessages(convId, false);
    pollTimer = setInterval(function () { fetchMessages(convId, true); }, 3000);
  }

  function fetchMessages(convId, incremental) {
    var url = "/conversations/" + convId + "/messages";
    if (incremental && lastMsgTs) url += "?after=" + new Date(lastMsgTs).toISOString();
    api(url).then(function (d) {
      if (S.route !== "thread" || S.threadConv !== convId) return;
      var box = threadEls.msgs;
      if (!box) return;
      if (!incremental) {
        box.innerHTML = "";
        if (!d.messages.length) {
          box.appendChild(renderOpeners());
        }
      } else {
        var empty = box.querySelector(".empty-state");
        if (empty && d.messages.length) empty.remove();
      }
      d.messages.forEach(function (m) { appendMessage(box, m); });
      if (d.messages.length) {
        lastMsgTs = d.messages[d.messages.length - 1].ts;
        box.scrollTop = box.scrollHeight;
      }
    }).catch(function () {});
  }

  function appendMessage(box, m) {
    var w = el(
      '<div class="message ' + (m.from === "me" ? "me" : "them") + '">' +
      '<div class="bubble">' + esc(m.text).replace(/\n/g, "<br>") + "</div>" +
      '<div class="msg-time">' + fmtTime(m.ts) + "</div></div>"
    );
    box.appendChild(w);
  }

  function sendThreadMessage(convId, peer) {
    var input = document.getElementById("t-input");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";

    api("/conversations/" + convId + "/messages", {
      method: "POST",
      body: { body: text },
    }).then(function (d) {
      S.user.tokenBalance = d.balance;
      fetchMessages(convId, true);
    }).catch(function (e) {
      if (e.status === 402) {
        openTopup(e.data && e.data.cost ? e.data.cost : S.cfg.costPerMessage);
      } else if (e.status === 403) {
        toast("You can't message this person");
      } else {
        toast("Couldn't send — try again");
      }
    });
  }

  /* ---------------- Concierge ----------------
     Draft help only: the concierge returns text, tapping a draft fills
     the composer, and the user still taps Send (tokens charge then). */

  function openConcierge(convId, peer) {
    var goals = [
      { id: "hello", label: "Say hello" },
      { id: "keep_going", label: "Keep it going" },
      { id: "ask_out", label: "Ask " + (peer.gender === "lady" ? "her" : "him") + " out" },
      { id: "revive", label: "Revive a quiet thread" },
    ];
    var selected = lastMsgTs ? "keep_going" : "hello";
    modal(
      '<div class="m-emoji">✨</div>' +
      "<h3>Concierge</h3>" +
      "<p>Pick a goal — I'll draft it for " + esc(peer.name) + ". You review it, you tap Send.</p>" +
      '<div class="goal-chips" id="cg-goals">' +
      goals.map(function (g) {
        return '<button type="button" class="goal-chip' + (g.id === selected ? " selected" : "") + '" data-goal="' + g.id + '">' + esc(g.label) + "</button>";
      }).join("") +
      "</div>" +
      '<input class="text-input" id="cg-hint" maxlength="200" placeholder="Anything you want to say? (optional)">' +
      '<div id="cg-results"></div>' +
      '<div class="m-actions">' +
      '<button class="btn-primary" id="cg-go">Get drafts</button>' +
      '<button class="btn-secondary" id="cg-close">Close</button>' +
      "</div>"
    );
    var m = document.querySelector(".modal");
    if (m) m.classList.add("tall");
    document.getElementById("cg-close").addEventListener("click", closeModal);
    document.getElementById("cg-goals").querySelectorAll(".goal-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        selected = chip.dataset.goal;
        document.getElementById("cg-goals").querySelectorAll(".goal-chip").forEach(function (c) { c.classList.remove("selected"); });
        chip.classList.add("selected");
      });
    });
    document.getElementById("cg-go").addEventListener("click", function () {
      var btn = document.getElementById("cg-go");
      btn.disabled = true;
      btn.textContent = "Thinking…";
      api("/conversations/" + convId + "/concierge", {
        method: "POST",
        body: { goal: selected, hint: document.getElementById("cg-hint").value },
      }).then(function (d) {
        renderConciergeResults(d);
        btn.disabled = false;
        btn.textContent = "Get drafts";
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = "Get drafts";
        toast("Concierge drew a blank — try again");
      });
    });
  }

  function renderConciergeResults(d) {
    var box = document.getElementById("cg-results");
    if (!box) return;
    var html = "";
    d.drafts.forEach(function (dr, i) {
      html += '<button type="button" class="draft-card" data-i="' + i + '"><span class="draft-tone">' + esc(dr.tone) + "</span>" + esc(dr.text) + "</button>";
    });
    if (d.dateIdea) {
      html += '<div class="date-idea"><span class="draft-tone">Date idea</span>' + esc(d.dateIdea) + "</div>";
    }
    if (d.canAfford === false) {
      html += '<div class="cg-note">You\'re out of tokens for this chat. <button type="button" class="link-btn" id="cg-topup">Top up</button></div>';
    } else if (d.cost > 0) {
      html += '<div class="cg-note">Sending costs 🪙 ' + d.cost + " tokens — charged only when you tap Send.</div>";
    }
    html += '<div class="cg-note">' + (d.source === "ai" ? "Drafted by the AI concierge." : "Concierge picks.") + " Nothing sends itself.</div>";
    box.innerHTML = html;
    box.querySelectorAll(".draft-card").forEach(function (card) {
      card.addEventListener("click", function () {
        var dr = d.drafts[Number(card.dataset.i)];
        var input = document.getElementById("t-input");
        closeModal();
        if (input && dr) {
          input.value = dr.text;
          input.focus();
          input.style.height = "auto";
          input.style.height = Math.min(input.scrollHeight, 110) + "px";
        }
      });
    });
    var top = document.getElementById("cg-topup");
    if (top) top.addEventListener("click", function () { closeModal(); go("wallet"); });
  }

  function openPeerMenu(peer) {
    modal(
      '<div class="m-emoji">🛡️</div>' +
      "<h3>" + esc(peer.name) + "</h3>" +
      '<div class="m-actions">' +
      '<button class="btn-secondary" id="pm-report">Report</button>' +
      '<button class="btn-secondary" id="pm-block">Block</button>' +
      '<button class="btn-secondary" id="pm-close">Cancel</button>' +
      "</div>"
    );
    document.getElementById("pm-close").addEventListener("click", closeModal);
    document.getElementById("pm-report").addEventListener("click", function () {
      modal(
        "<h3>Report " + esc(peer.name) + "</h3>" +
        '<p>What\'s wrong? Reports are reviewed by the Suitor team.</p>' +
        '<div class="m-actions">' +
        '<input class="text-input" id="rep-reason" maxlength="500" placeholder="Reason…" style="margin-bottom:6px">' +
        '<button class="btn-primary" id="rep-send">Send report</button>' +
        '<button class="btn-secondary" id="rep-cancel">Cancel</button>' +
        "</div>"
      );
      document.getElementById("rep-cancel").addEventListener("click", closeModal);
      document.getElementById("rep-send").addEventListener("click", function () {
        var reason = document.getElementById("rep-reason").value.trim();
        if (!reason) { toast("Add a reason"); return; }
        api("/users/" + peer.id + "/report", { method: "POST", body: { reason: reason } })
          .then(function () { closeModal(); toast("Reported. Thanks."); })
          .catch(function () { toast("Couldn't send report"); });
      });
    });
    document.getElementById("pm-block").addEventListener("click", function () {
      api("/users/" + peer.id + "/block", { method: "POST" })
        .then(function () { closeModal(); toast("Blocked"); go("chats"); })
        .catch(function () { toast("Couldn't block"); });
    });
  }

  /* ---------------- Init ---------------- */
  function init() {
    root = document.getElementById("root");
    api("/config").then(function (c) {
      S.cfg.costPerMessage = c.costPerMessage;
      S.cfg.welcomeTokens = c.welcomeTokens;
      S.cfg.paypalConfigured = c.paypalConfigured;
      S.cfg.paypalClientId = c.paypalClientId;
    }).catch(function () {}).then(function () {
      return api("/me").then(function (d) {
        S.user = d.user;
        S.route = "discover";
      }).catch(function () {
        S.user = null;
        S.route = "welcome";
      });
    }).then(render);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
