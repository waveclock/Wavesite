// Shared sign-in gate for every /admin/ page (and design/beach-buddy-admin.html).
// Blocks the page behind a full-screen Google sign-in overlay until an
// authorized account is signed in. The same allowlist is enforced
// server-side in storage.rules -- this client-side check just gives an
// unauthorized Google account a clear message instead of a page full of
// failed requests.
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const ADMIN_EMAILS = ["kurt.woehr@gmail.com"];

const STYLE = `
  .admin-gate { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center;
    background: #F1E6CF; font-family: 'Work Sans', -apple-system, sans-serif; padding: 20px; }
  .admin-gate-box { background: #fff; border: 2px solid #1F3347; border-radius: 10px; box-shadow: 4px 4px 0 rgba(20,48,45,0.10);
    padding: 32px 28px; max-width: 320px; width: 100%; text-align: center; box-sizing: border-box; }
  .admin-gate-box h2 { font-family: 'Fraunces', Georgia, serif; margin: 0 0 10px; font-size: 20px; color: #1F3347; }
  .admin-gate-box p { color: #4C6478; font-size: 13.5px; margin: 0 0 18px; }
  .admin-gate-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 999px;
    border: 2px solid #1F3347; background: #fff; font-family: inherit; font-weight: 700; font-size: 13.5px;
    color: #1F3347; cursor: pointer; }
  .admin-gate-btn:hover { background: #F8F2E4; }
  .admin-gate-btn:disabled { opacity: 0.6; cursor: default; }
  .admin-gate-error { color: #A85C42; font-size: 12.5px; margin-top: 14px; }
`;

function ensureStyle() {
  if (document.getElementById("admin-gate-style")) return;
  const style = document.createElement("style");
  style.id = "admin-gate-style";
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function buildOverlay(onSignIn) {
  ensureStyle();
  const overlay = document.createElement("div");
  overlay.className = "admin-gate";
  overlay.innerHTML = `
    <div class="admin-gate-box">
      <h2>Admin sign-in required</h2>
      <p>This page is restricted. Sign in with an authorized Google account to continue.</p>
      <button type="button" class="admin-gate-btn" id="admin-gate-btn">Sign in with Google</button>
      <div class="admin-gate-error" id="admin-gate-error"></div>
    </div>
  `;
  const btn = overlay.querySelector("#admin-gate-btn");
  btn.addEventListener("click", () => {
    btn.disabled = true;
    overlay.querySelector("#admin-gate-error").textContent = "";
    onSignIn().catch((err) => {
      overlay.querySelector("#admin-gate-error").textContent = "Sign-in failed: " + err.message;
      btn.disabled = false;
    });
  });
  return overlay;
}

// Resolves with the Firebase User once an authorized account is signed
// in. Never resolves for an unauthorized or signed-out visitor -- the
// caller should do nothing (no Storage/Function calls) until this
// resolves, since the overlay it shows is a UI convenience, not the
// actual access control (storage.rules is).
export function requireAdmin(app) {
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();

  return new Promise((resolve) => {
    let overlay = null;
    let resolved = false;

    function showGate(errorMessage) {
      if (!overlay) {
        overlay = buildOverlay(() => signInWithPopup(auth, provider));
        document.body.appendChild(overlay);
      }
      if (errorMessage) {
        overlay.querySelector("#admin-gate-error").textContent = errorMessage;
      }
    }

    onAuthStateChanged(auth, (user) => {
      if (user && ADMIN_EMAILS.includes(user.email)) {
        if (overlay) { overlay.remove(); overlay = null; }
        if (!resolved) { resolved = true; resolve(user); }
        return;
      }
      if (user) {
        const email = user.email;
        signOut(auth);
        showGate("Signed in as " + email + ", which isn't an authorized admin account.");
        return;
      }
      showGate();
    });
  });
}
