import {
  initializeApp,
  getApps,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  reload,
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
export const API =
  "https://us-central1-liber-apps-cca20.cloudfunctions.net/jerichoApi";
export const VERSION = "2026-11-05";
export const $ = (selector) => document.querySelector(selector);
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else if (value !== false && value != null)
      node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat())
    if (child != null)
      node.append(
        child.nodeType ? child : document.createTextNode(String(child)),
      );
  return node;
}
export const state = { auth: null, user: null, ready: false };
export function notice(node, message, error = false) {
  if (node) {
    node.textContent = message;
    node.classList.toggle("error", error);
    node.setAttribute("role", error ? "alert" : "status");
  }
}
export async function busy(button, fn, statusNode) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    notice(statusNode || $("#global-status"), friendly(error), true);
  } finally {
    button.disabled = false;
  }
}
function friendly(error) {
  const messages = {
    "auth/invalid-credential": "Check your email and password.",
    "auth/email-already-in-use":
      "This account already exists. Sign in instead.",
    "auth/weak-password": "Use a password with at least 12 characters.",
    "auth/popup-closed-by-user": "Sign-in was canceled. You can try again.",
    "auth/popup-blocked":
      "Your browser blocked sign-in. Allow the popup or use email.",
    "auth/too-many-requests": "Please wait before trying again.",
    "auth/network-request-failed":
      "Connection interrupted. Check your connection and try again.",
  };
  return messages[error.code] || error.message || "Please try again.";
}
export async function api(action, data = {}, publicRequest = false) {
  await ready;
  const headers = { "Content-Type": "application/json" };
  if (!publicRequest) {
    if (!state.user) throw new Error("Sign in to continue.");
    headers.Authorization = `Bearer ${await state.user.getIdToken()}`;
  }
  const response = await fetch(API, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, data }),
    credentials: "omit",
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok) {
    const e = new Error(body.error || "The request could not be completed.");
    e.status = response.status;
    throw e;
  }
  return body;
}
export function date(value) {
  return value
    ? new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
}
export function download(name, text, type = "application/json") {
  const blob = new Blob([text], { type }),
    url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export async function copy(text, status) {
  try {
    await navigator.clipboard.writeText(text);
    notice(status, "Copied.");
  } catch (_) {
    notice(status, "Select the link and copy it from the field.");
  }
}
export function avatar(index = 0, label = "Pixel-art avatar", seed = "") {
  const n = Math.max(0, Math.min(5, Number(index) || 0));
  const node = el("span", {
    class: "portrait",
    role: "img",
    "aria-label": label,
    style: `background-position:${(n % 3) * 50}% ${Math.floor(n / 3) * 100}%`,
  });
  if (seed) {
    const strip = el("span", {
      style:
        "position:absolute;bottom:0;left:0;right:0;height:4px;display:flex",
      "aria-hidden": true,
    });
    for (const bit of seed.slice(0, 32))
      strip.append(
        el("span", {
          style: `flex:1;background:${parseInt(bit, 16) % 2 ? "#716083" : "#e3dac7"}`,
        }),
      );
    node.append(strip);
  }
  return node;
}
export function memberCard(profile = {}, demo = false) {
  const name =
    profile.displayName || (demo ? "Your chosen name" : "Private member");
  const status = demo
    ? "DESIGN PREVIEW"
    : profile.status === "verified"
      ? "IDENTITY CHECK COMPLETED"
      : profile.status === "revoked"
        ? "REVOKED"
        : "SELF-DECLARED";
  const center = el(
    "div",
    { class: "card-center" },
    avatar(profile.avatar || 0, "Chosen artwork avatar", profile.avatarSeed),
    el(
      "div",
      {},
      el("div", { class: "card-name", text: name }),
      el("div", {
        class: "card-community",
        text: profile.community || "Jericho Alliance",
      }),
      profile.japId
        ? el("div", { class: "jap-number", text: profile.japId })
        : null,
    ),
  );
  return el(
    "div",
    { class: "member-card" },
    el("div", { class: "card-top", text: "JERICHO ALLIANCE" }),
    center,
    el(
      "div",
      { class: "card-bottom" },
      "PRIVATE COMMUNITY PROFILE",
      el("div", { class: "card-status", text: status }),
    ),
  );
}
export function shell(active) {
  const root = $("#site-header");
  if (root)
    root.replaceChildren(
      el(
        "a",
        { href: "/jericho-alliance/id", class: "brand" },
        el("span", { class: "monogram", "aria-hidden": true, text: "J" }),
        "Jericho Alliance",
      ),
      el(
        "nav",
        { "aria-label": "Alliance" },
        ...[
          ["Profile", "/jericho-alliance/id"],
          ["Declaration", "/declaration-of-presence"],
          ["Negotiations", "/negotiations"],
        ].map(([label, href]) =>
          el(
            "a",
            { href, ...(active === label ? { "aria-current": "page" } : {}) },
            label,
          ),
        ),
        el(
          "button",
          {
            class: "quiet account",
            id: "account-button",
            onclick: () => openAuth(),
          },
          "Sign in",
        ),
      ),
    );
  const footer = $("#site-footer");
  if (footer)
    footer.replaceChildren(
      el(
        "a",
        { href: "/", style: "text-decoration:none" },
        el("strong", {}, "LIBER"),
      ),
      el(
        "div",
        {},
        el("a", { href: "/jericho-alliance/sip" }, "Self-Identification"),
        el("a", { href: "/jericho-alliance/privacy" }, "Privacy"),
        el("a", { href: "/jericho-alliance/legal" }, "Legal"),
      ),
    );
}
export function authForm() {
  const status = el("p", {
    class: "status",
    role: "status",
    "aria-live": "polite",
  });
  const form = el("form");
  const email = el("input", {
    type: "email",
    name: "email",
    autocomplete: "email",
    required: true,
  });
  const password = el("input", {
    type: "password",
    name: "password",
    autocomplete: "current-password",
    required: true,
  });
  const login = el("button", { type: "submit" }, "Sign in");
  const create = el(
    "button",
    {
      type: "button",
      class: "quiet",
      onclick: () =>
        busy(
          create,
          async () => {
            if (!form.reportValidity()) return;
            if (password.value.length < 12)
              throw new Error("Use at least 12 characters for a new password.");
            const credential = await createUserWithEmailAndPassword(
              state.auth,
              email.value.trim(),
              password.value,
            );
            await sendEmailVerification(credential.user);
            notice(
              status,
              "Account created. Check your email, then choose “I verified my email”.",
            );
          },
          status,
        ),
    },
    "Create account",
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(
      login,
      async () => {
        await signInWithEmailAndPassword(
          state.auth,
          email.value.trim(),
          password.value,
        );
        notice(status, "Signed in.");
      },
      status,
    );
  });
  const google = el(
    "button",
    {
      class: "quiet full",
      type: "button",
      onclick: () =>
        busy(
          google,
          async () => {
            await signInWithPopup(state.auth, new GoogleAuthProvider());
          },
          status,
        ),
    },
    "Continue with Google",
  );
  const reset = el(
    "button",
    {
      class: "text-button",
      type: "button",
      onclick: () =>
        busy(
          reset,
          async () => {
            if (!email.reportValidity()) return;
            await sendPasswordResetEmail(state.auth, email.value.trim());
            notice(status, "If an account matches, a reset email will arrive.");
          },
          status,
        ),
    },
    "Reset password",
  );
  form.append(
    el("label", {}, "Email", email),
    el("label", {}, "Password", password),
    el("div", { class: "actions" }, login, create),
    el("div", { class: "actions" }, reset),
  );
  return el(
    "div",
    { class: "auth-content" },
    google,
    el("div", { class: "or" }, "or use email"),
    form,
    status,
    el(
      "p",
      { class: "small", style: "margin-top:20px" },
      "Use your existing LIBER account. New accounts require email verification. Sign out when using a shared device.",
    ),
  );
}
let dialog;
export function openAuth() {
  if (!state.ready)
    return notice($("#global-status"), "Connecting to LIBER sign-in…");
  if (!dialog) {
    dialog = el("dialog", { "aria-label": "LIBER account" });
    document.body.append(dialog);
  }
  const close = el(
    "button",
    {
      class: "quiet",
      type: "button",
      "aria-label": "Close account dialog",
      onclick: () => dialog.close(),
    },
    "Close",
  );
  dialog.replaceChildren(
    el(
      "div",
      { class: "dialog-head" },
      el("h2", {}, state.user ? "Your account" : "Welcome to Jericho."),
      close,
    ),
  );
  if (!state.user) dialog.append(authForm());
  else {
    dialog.append(
      el("p", { class: "break", text: state.user.email }),
      el("p", {
        class: "small",
        text: state.user.emailVerified
          ? "Email confirmed through LIBER sign-in."
          : "Email verification is required.",
      }),
    );
    if (!state.user.emailVerified) dialog.append(verificationControls());
    dialog.append(
      el(
        "div",
        { class: "actions" },
        el(
          "a",
          { class: "button", href: "/jericho-alliance/sip" },
          "My profile",
        ),
        el(
          "button",
          {
            class: "quiet",
            onclick: async () => {
              await signOut(state.auth);
              dialog.close();
            },
          },
          "Sign out",
        ),
      ),
    );
  }
  if (!dialog.open) dialog.showModal();
}
export function verificationControls() {
  const status = el("p", { class: "status", role: "status" });
  const refresh = el(
    "button",
    {
      onclick: () =>
        busy(
          refresh,
          async () => {
            await reload(state.user);
            await state.user.getIdToken(true);
            state.user = state.auth.currentUser;
            if (!state.user.emailVerified)
              throw new Error(
                "Your email is not confirmed yet. Open the link in your verification email.",
              );
            window.dispatchEvent(
              new CustomEvent("jericho-auth", { detail: state.user }),
            );
            if (dialog?.open) openAuth();
          },
          status,
        ),
    },
    "I verified my email",
  );
  const resend = el(
    "button",
    {
      class: "quiet",
      onclick: () =>
        busy(
          resend,
          async () => {
            await sendEmailVerification(state.user);
            notice(status, "Verification email sent.");
          },
          status,
        ),
    },
    "Resend email",
  );
  return el(
    "div",
    {},
    el("div", { class: "actions" }, refresh, resend),
    status,
  );
}
export const ready = (async () => {
  try {
    const response = await fetch("/__/firebase/init.json", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error("LIBER sign-in configuration could not be loaded.");
    const config = await response.json();
    if (config.projectId !== "liber-apps-cca20")
      throw new Error("Unexpected sign-in configuration.");
    state.auth = getAuth(getApps()[0] || initializeApp(config));
    await state.auth.authStateReady();
    state.user = state.auth.currentUser;
    state.ready = true;
    onAuthStateChanged(state.auth, (user) => {
      state.user = user;
      const button = $("#account-button");
      if (button) button.textContent = user ? "My account" : "Sign in";
      if (user?.emailVerified && dialog?.open) dialog.close();
      else if (user && dialog?.open) openAuth();
      window.dispatchEvent(new CustomEvent("jericho-auth", { detail: user }));
    });
  } catch (error) {
    notice($("#global-status"), error.message, true);
    throw error;
  }
})();
