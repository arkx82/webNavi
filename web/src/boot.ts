import { pull, type Me } from "./userdata";

/**
 * Before the app: is someone logged in? If not, the login form (users are
 * made on /admin); if so, their places and settings are brought in, and
 * then the app itself is loaded. A session that ends while driving (the
 * password changed on /admin) brings the form back on the next call.
 */
async function start() {
  let answer: Response;
  try {
    answer = await fetch("/api/me");
  } catch {
    showLogin("서버에 연결할 수 없습니다");
    return;
  }
  if (answer.status === 401) {
    const j = (await answer.json().catch(() => ({}))) as { users?: boolean };
    showLogin(j.users === false ? "아직 사용자가 없습니다 — /admin 에서 만드세요" : "");
    return;
  }
  let user: Me | undefined;
  try {
    if (!answer.ok) throw new Error(`${answer.status}`);
    user = ((await answer.json()) as { user?: Me }).user;
  } catch { /* a 500, or the tunnel's own 502 page (HTML, not JSON) */ }
  if (!user) {
    showLogin(`서버 오류 (${answer.status}) — 잠시 후 다시 시도하세요`, true);
    return;
  }
  await pull(user).catch(() => { /* the app still starts on what storage has */ });
  watchForLogout();
  await import("./main");
}

function showLogin(note: string, retry = false) {
  const box = document.createElement("div");
  box.id = "login";
  box.innerHTML = `
    <form autocomplete="on">
      <div class="login-title">WebNavi</div>
      <label>아이디<input name="name" autocomplete="username" autocapitalize="off" required /></label>
      <label>비밀번호<input name="password" type="password" autocomplete="current-password" required /></label>
      <button class="primary" type="submit">로그인</button>
      <div class="login-note"></div>
      <button class="login-retry" type="button" hidden>다시 시도</button>
    </form>`;
  document.body.append(box);
  const form = box.querySelector("form")!;
  const say = (t: string) => { box.querySelector(".login-note")!.textContent = t; };
  say(note);
  // The server answered wrongly (not "who are you"): asked again from the top, without a reload the car may not manage.
  const again = box.querySelector<HTMLButtonElement>(".login-retry")!;
  again.hidden = !retry;
  again.addEventListener("click", () => { box.remove(); void start(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    say("…");
    try {
      const a = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.get("name"), password: data.get("password") }),
      });
      const j = (await a.json().catch(() => ({}))) as { error?: string };
      if (!a.ok) return say(j.error ?? `로그인 실패 (${a.status})`);
      try { localStorage.setItem("nav-last-user-name", String(data.get("name") ?? "")); } catch { /* private window */ }
      // Again from the top: the map loaders in the head need the session too.
      location.reload();
    } catch {
      say("서버에 연결할 수 없습니다");
    }
  });
  // The name last logged in with, so only the password is typed (the session itself lasts a year).
  let lastName = "";
  try { lastName = localStorage.getItem("nav-last-user-name") ?? ""; } catch { /* private window */ }
  const nameInput = box.querySelector<HTMLInputElement>('input[name="name"]')!;
  nameInput.value = lastName;
  (lastName ? box.querySelector<HTMLInputElement>('input[name="password"]')! : nameInput).focus();
}

/** Any call answered "login" means the session is gone: back to the form. */
function watchForLogout() {
  const plain = window.fetch.bind(window);
  let gone = false;
  window.fetch = async (input, init) => {
    const answer = await plain(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (answer.status === 401 && !gone && /\/api\//.test(url) && !/\/api\/(me|login)\b/.test(url)) {
      const j = await answer.clone().json().catch(() => ({})) as { error?: string };
      if (j.error === "login") { gone = true; location.reload(); }
    }
    return answer;
  };
}

void start();
