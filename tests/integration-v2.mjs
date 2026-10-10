// Testes de integração da v2 (autenticação, isolamento, mídia) contra `wrangler dev` local.
// Não usa Google Drive nem TMDB. Rode num banco D1 local NOVO (o teste cria usuários).
//
// 1) Crie uma pasta de teste (ex.: .kvtest/) com um wrangler.toml igual ao da raiz, mas com
//    main = "../src/index.ts", directory = "../public", database_id fictício e
//    ADMIN_PASSWORD = "teste-v2". Usar uma pasta separada evita que um .dev.vars local
//    injete credenciais reais (os testes de /setup/config esperam "nada configurado").
// 2) (na pasta de teste) npx wrangler dev --local --port 8787 --persist-to ./state
// 3) curl http://127.0.0.1:8787/System/Info/Public   (cria as tabelas)
// 4) npx wrangler d1 execute DB --local --persist-to ./state --file ../tests/seed-v2.sql
// 5) node tests/integration-v2.mjs http://127.0.0.1:8787 teste-v2
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const ADMIN_PW = process.argv[3] || "teste-v2";
let pass = 0, fail = 0;
const results = [];

function check(name, cond, extra = "") {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (extra ? "  -> " + extra : "")); }
}

const mb = (token, dev = "dev-test-1") =>
  `MediaBrowser Client="v2test", Device="node", DeviceId="${dev}", Version="1.0.0"` + (token ? `, Token="${token}"` : "");

async function req(method, path, { token, headers = {}, body, raw = false, dev } = {}) {
  const h = { ...headers };
  if (token !== undefined) h["Authorization"] = mb(token, dev);
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
    redirect: "manual",
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data, text, headers: res.headers };
}

async function login(user, pw, dev) {
  return req("POST", "/Users/AuthenticateByName", { token: "", body: { Username: user, Pw: pw }, dev });
}

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

(async () => {
  // ── Rotas públicas
  let r = await req("GET", "/System/Info/Public");
  check("System/Info/Public é público", r.status === 200 && /^[0-9a-f]{32}$/.test(r.data.Id), r.text.slice(0, 120));
  const serverId = r.data.Id;

  r = await req("GET", "/Users/Public");
  check("Users/Public é público", r.status === 200 && Array.isArray(r.data));

  // ── Sem token = 401
  for (const p of ["/Users", "/Users/Me", "/Items", "/Videos/abc/stream", "/Backup", "/Environment/Drives", "/sync", "/Library/VirtualFolders", "/System/Configuration"]) {
    r = await req("GET", p);
    check(`sem token 401: ${p}`, r.status === 401, String(r.status));
  }
  r = await req("GET", "/Users/Me", { token: "fake_jwt_token_12345" });
  check("token fixo da v1 é recusado", r.status === 401, String(r.status));
  r = await req("POST", "/Users/New", { body: { Name: "invasor" } });
  check("criar usuário sem token = 401", r.status === 401);
  r = await req("POST", "/debug_log", { body: "x" });
  check("debug_log não aceita escrita anônima", r.status === 401 || r.status === 404, String(r.status));

  // ── Login
  r = await login("admin", "");
  check("senha vazia não entra (bug v1)", r.status === 401, String(r.status));
  r = await login("admin", "errada");
  check("senha errada = 401", r.status === 401);
  r = await login("naoexiste", "x");
  check("usuário inexistente não cai no admin", r.status === 401);
  r = await login("admin", ADMIN_PW);
  check("login admin ok", r.status === 200 && /^[0-9a-f]{32}$/.test(r.data.AccessToken || ""), r.text.slice(0, 200));
  const adminTok = r.data.AccessToken;
  const adminId = r.data.User?.Id;
  check("login devolve ServerId da instalação", r.data.ServerId === serverId);
  check("admin é administrador", r.data.User?.Policy?.IsAdministrator === true);

  // ── Formas de enviar o token
  r = await req("GET", "/Users/Me", { token: adminTok });
  check("Authorization: MediaBrowser Token", r.status === 200 && r.data.Name === "admin", r.text.slice(0, 120));
  r = await req("GET", "/Users/Me", { headers: { "X-Emby-Token": adminTok } });
  check("X-Emby-Token", r.status === 200);
  r = await req("GET", "/Users/Me", { headers: { "X-Emby-Authorization": mb(adminTok) } });
  check("X-Emby-Authorization", r.status === 200);
  r = await req("GET", `/Users/Me?api_key=${adminTok}`);
  check("?api_key=", r.status === 200);
  r = await req("GET", `/Users/Me?ApiKey=${adminTok}`);
  check("?ApiKey=", r.status === 200);

  // ── Rotas de debug removidas
  r = await req("GET", "/debug_logs", { token: adminTok });
  check("debug_logs removida", r.status === 404, String(r.status));
  r = await req("GET", "/DebugDrive", { token: adminTok });
  check("DebugDrive removida", r.status === 404, String(r.status));
  r = await req("GET", "/Debug/ListFolder/root", { token: adminTok });
  check("Debug/ListFolder removida", r.status === 404, String(r.status));
  r = await req("POST", "/internal/syncLibrary", { token: adminTok, body: {} });
  check("internal/syncLibrary removida", r.status === 404, String(r.status));

  // ── Usuário comum
  r = await req("POST", "/Users/New", { token: adminTok, body: { Name: "filho", Password: "senha-filho" } });
  check("admin cria usuário", r.status === 200 && r.data.Policy?.IsAdministrator === false, r.text.slice(0, 150));
  const kidId = r.data.Id;
  r = await req("POST", "/Users/New", { token: adminTok, body: { Name: "Filho", Password: "x" } });
  check("nome duplicado é recusado", r.status === 400);

  r = await login("filho", "senha-filho", "dev-kid");
  check("login usuário comum", r.status === 200);
  const kidTok = r.data.AccessToken;
  r = await req("GET", "/Users/Me", { token: kidTok, dev: "dev-kid" });
  check("Users/Me devolve o usuário certo (não o admin)", r.status === 200 && r.data.Name === "filho", r.text.slice(0, 100));
  r = await req("GET", `/Users/${adminId}`, { token: kidTok });
  check("comum não lê outro usuário", r.status === 403, String(r.status));
  r = await req("POST", `/Users/${kidId}/Policy`, { token: kidTok, body: { IsAdministrator: true } });
  check("comum não se promove a admin", r.status === 403, String(r.status));
  r = await req("GET", "/Backup", { token: kidTok });
  check("comum sem acesso a backup", r.status === 403);
  r = await req("GET", "/Environment/Drives", { token: kidTok });
  check("comum sem acesso ao Drive", r.status === 403);
  r = await req("POST", "/Library/VirtualFolders", { token: kidTok, body: {} });
  check("comum não cria biblioteca", r.status === 403);
  r = await req("DELETE", `/Users/${adminId}`, { token: kidTok });
  check("comum não apaga usuários", r.status === 403);
  r = await req("GET", `/Items?userId=${adminId}`, { token: kidTok });
  check("comum não consulta como outro usuário", r.status === 403);
  r = await req("POST", "/Branding/Configuration", { token: kidTok, body: { LoginDisclaimer: "<img src=x onerror=alert(1)>" } });
  check("comum não altera branding", r.status === 403);
  r = await req("POST", "/Branding/Configuration", { body: { LoginDisclaimer: "x" } });
  check("anônimo não altera branding", r.status === 401);
  r = await req("GET", "/Users/Me", { token: kidTok });
  check("usuário comum continua logado", r.status === 200);
  r = await req("POST", "/Users/Me/Configuration", { token: kidTok, body: { MarcaTeste: "filho" } });
  check("/Users/Me/... do comum aceita", r.status === 204, String(r.status));
  r = await req("GET", `/Users/${adminId}`, { token: adminTok });
  check("/Users/Me do comum não altera o admin", r.status === 200 && r.data.Configuration?.MarcaTeste === undefined, JSON.stringify(r.data.Configuration || {}).slice(0, 80));
  r = await req("GET", `/Users/${kidId}`, { token: kidTok });
  check("/Users/Me grava no próprio usuário", r.data.Configuration?.MarcaTeste === "filho");
  r = await req("GET", "/Users", { token: kidTok });
  check("GET /Users do comum mostra só ele", Array.isArray(r.data) && r.data.length === 1 && r.data[0].Name === "filho", r.text.slice(0, 100));

  // ── Troca de senha
  r = await req("POST", `/Users/${kidId}/Password`, { token: kidTok, body: { CurrentPw: "errada", NewPw: "nova" } });
  check("troca de senha exige a atual", r.status === 403, String(r.status));
  r = await req("POST", `/Users/${kidId}/Password`, { token: kidTok, body: { CurrentPw: "senha-filho", NewPw: "nova-senha" } });
  check("troca de senha com a atual", r.status === 204, String(r.status));
  r = await login("filho", "senha-filho", "dev-kid2");
  check("senha antiga deixa de valer", r.status === 401);
  r = await login("filho", "nova-senha", "dev-kid2");
  check("senha nova vale", r.status === 200);
  const kidTok2 = r.data.AccessToken;

  // ── Admin redefine e desativa
  r = await req("POST", `/Users/${kidId}/Policy`, { token: adminTok, body: { IsAdministrator: false, IsDisabled: true } });
  check("admin desativa usuário", r.status === 204);
  r = await req("GET", "/Users/Me", { token: kidTok2 });
  check("usuário desativado perde a sessão", r.status === 401, String(r.status));
  r = await login("filho", "nova-senha", "dev-kid3");
  check("usuário desativado não entra", r.status === 401);
  r = await req("POST", `/Users/${adminId}/Policy`, { token: adminTok, body: { IsAdministrator: false } });
  r = await req("GET", "/Backup/Manifest", { token: adminTok });
  check("admin não consegue se rebaixar", r.status !== 403, String(r.status));

  // ── /setup com Basic + CSRF + XSS
  r = await req("GET", "/setup");
  check("/setup pede login", r.status === 401 && /Basic/.test(r.headers.get("www-authenticate") || ""));
  r = await req("GET", "/setup", { headers: { Authorization: basic("admin", ADMIN_PW) } });
  check("/setup com Basic de admin", r.status === 200 && /DriveFlin Setup/.test(r.text));
  r = await req("GET", "/setup", { headers: { Authorization: basic("admin", "errada") } });
  check("/setup com senha errada", r.status === 401);
  const form = "id=lib_xss&name=%3Cscript%3Ealert(1)%3C%2Fscript%3E&folderId=abc";
  r = await req("POST", "/setup/add", { headers: { Authorization: basic("admin", ADMIN_PW), "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }, body: form });
  check("/setup/add de outro site é bloqueado (CSRF)", r.status === 403, String(r.status));
  r = await req("POST", "/setup/add", { headers: { Authorization: basic("admin", ADMIN_PW), "Content-Type": "application/x-www-form-urlencoded", Origin: BASE }, body: form });
  check("/setup/add do próprio site", r.status === 302, String(r.status));
  r = await req("GET", "/setup", { headers: { Authorization: basic("admin", ADMIN_PW) } });
  check("/setup escapa HTML (sem XSS)", !r.text.includes("<script>alert(1)</script>") && r.text.includes("&lt;script&gt;"));
  r = await req("POST", "/setup/delete", { headers: { Authorization: basic("admin", ADMIN_PW), "Content-Type": "application/x-www-form-urlencoded", Origin: BASE }, body: "id=lib_xss" });

  // ── Mídia: PlaybackInfo e stream
  r = await req("GET", "/Items/test_movie_uuid_0000000000000001/PlaybackInfo".replace("test_movie_uuid_0000000000000001", "0123456789abcdef0123456789abcdef"), { token: adminTok });
  check("PlaybackInfo do item de teste", r.status === 200, r.text.slice(0, 200));
  const ms = r.data?.MediaSources?.[0] || {};
  check("container detectado (.avi)", ms.Container === "avi", ms.Container);
  check("SupportsTranscoding=false (sem transcodificação)", ms.SupportsTranscoding === false);
  check("DirectStreamUrl leva api_key", (ms.DirectStreamUrl || "").includes("api_key=" + adminTok), ms.DirectStreamUrl);
  check("sem TranscodingUrl falso", !ms.TranscodingUrl);
  r = await req("GET", "/Videos/0123456789abcdef0123456789abcdef/stream.avi?Static=true");
  check("stream sem token = 401", r.status === 401);
  r = await req("GET", "/Videos/0123456789abcdef0123456789abcdef/Subtitles");
  check("atalho por /Subtitles não libera o vídeo", r.status === 401, String(r.status));
  r = await req("GET", "/Videos/0123456789abcdef0123456789abcdef/0123456789abcdef0123456789abcdef/Subtitles/0/Stream.vtt");
  check("legenda pública devolve VTT, não o vídeo", r.status === 200 && (r.headers.get("content-type") || "").includes("text/vtt"), r.status + " " + r.headers.get("content-type"));
  r = await req("GET", `/Videos/0123456789abcdef0123456789abcdef/stream.avi?Static=true&api_key=${adminTok}`);
  check("stream com api_key passa da auth (Drive não configurado no teste)", r.status !== 401 && r.status !== 403, String(r.status));
  check("erro do stream não vaza detalhes", !/googleapis|refresh|client_secret|Failed to fetch from gdrive/i.test(r.text), r.text.slice(0, 120));

  // ── Imagens: públicas, mas sem proxy aberto
  r = await req("GET", "/Items/naoexiste/Images/Primary?tag=https://example.com/a.png");
  check("imagem não vira proxy aberto", r.status === 404, String(r.status));
  r = await req("GET", "/Items/branding_logo/Images/Primary");
  check("logo sem ID de Drive fixo", r.status === 302 && (r.headers.get("location") || "").includes("/assets/img/"), String(r.status));

  // ── CORS
  const pre = await fetch(BASE + "/Users/Me", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-emby-token" } });
  const allow = (pre.headers.get("access-control-allow-headers") || "").toLowerCase();
  check("CORS libera X-Emby-Token (Chromecast/apps)", (pre.status === 204 || pre.status === 200) && allow.includes("x-emby-token"), allow);

  // ── Config no KV (/setup/config): salvar, mascarar, limpar, CSRF
  const AB = { Authorization: basic("admin", ADMIN_PW) };
  const FORM = { ...AB, "Content-Type": "application/x-www-form-urlencoded", Origin: BASE };
  r = await req("GET", "/setup/config");
  check("/setup/config exige login", r.status === 401, String(r.status));
  r = await req("GET", "/setup/config", { headers: AB });
  check("/setup/config lista o estado (KV vinculado, nada configurado)", r.status === 200 && r.data.kv === true && r.data.fields.gdriveClientId.configured === false, r.text.slice(0, 200));
  const SECRET = "SEGREDO-DO-TESTE-1234567890";
  r = await req("POST", "/setup/config", { headers: { ...FORM, Origin: "https://evil.example" }, body: "tmdbApiKey=" + SECRET });
  check("/setup/config de outro site é bloqueado (CSRF)", r.status === 403, String(r.status));
  r = await req("POST", "/setup/config", { headers: FORM, body: "gdriveClientId=cid-teste-1234567890.apps.googleusercontent.com&gdriveClientSecret=csecret-teste-9999&gdriveRefreshToken=1%2F%2Frefresh-teste-abcdef&tmdbApiKey=" + SECRET });
  check("/setup/config grava no KV", r.status === 303, String(r.status));
  r = await req("GET", "/setup/config", { headers: AB });
  check("config salva aparece como origem KV", r.data.fields.tmdbApiKey.configured && r.data.fields.tmdbApiKey.source === "kv" && r.data.fields.gdriveRefreshToken.source === "kv", r.text.slice(0, 300));
  check("/setup/config nunca devolve segredo inteiro", !r.text.includes(SECRET) && !r.text.includes("csecret-teste-9999") && !r.text.includes("refresh-teste-abcdef"));
  r = await req("GET", "/setup", { headers: AB });
  check("/setup (HTML) nunca mostra segredo inteiro", r.status === 200 && !r.text.includes(SECRET) && !r.text.includes("csecret-teste-9999") && !r.text.includes("refresh-teste-abcdef"));
  r = await req("POST", "/setup/config", { headers: FORM, body: "gdriveClientId=&tmdbApiKey=" });
  r = await req("GET", "/setup/config", { headers: AB });
  check("campo em branco mantém o valor salvo", r.data.fields.gdriveClientId.configured === true && r.data.fields.tmdbApiKey.configured === true);
  r = await req("POST", "/setup/test", { headers: FORM, body: "" });
  check("Testar conexão usa as credenciais do KV (não diz 'preencha')", r.status === 200 && !/preencha Client ID/.test(r.text) && /Drive: /.test(r.text), r.text.slice(0, 200));
  r = await req("POST", "/setup/config", { headers: FORM, body: "clear_tmdbApiKey=1&clear_gdriveClientSecret=1" });
  r = await req("GET", "/setup/config", { headers: AB });
  check("remover limpa o campo do KV", r.data.fields.tmdbApiKey.configured === false && r.data.fields.gdriveClientSecret.configured === false && r.data.fields.gdriveClientId.configured === true);
  r = await req("POST", "/setup/test", { headers: FORM, body: "" });
  check("Testar conexão sem credenciais completas avisa", /preencha Client ID/.test(r.text), r.text.slice(0, 200));
  r = await req("POST", "/setup/config", { headers: FORM, body: "tmdbApiKey=abc%0Adef" });
  check("valor com quebra de linha é recusado", r.status === 400, String(r.status));
  for (const f of ["gdriveClientId", "gdriveRefreshToken"]) await req("POST", "/setup/config", { headers: FORM, body: "clear_" + f + "=1" });

  // ── Logout
  r = await req("POST", "/Sessions/Logout", { token: adminTok });
  check("logout", r.status === 204);
  r = await req("GET", "/Users/Me", { token: adminTok });
  check("token inválido após logout", r.status === 401, String(r.status));

  // ── Força bruta (por usuário; login válido de outra conta não zera o contador)
  r = await login("admin", ADMIN_PW, "dev-bf0");
  const adminTok2 = r.data.AccessToken;
  await req("POST", "/Users/New", { token: adminTok2, body: { Name: "neto", Password: "senha-neto" } });
  let hit = 0;
  for (let i = 1; i <= 15; i++) {
    const st = (await login("admin", "chute" + i, "dev-bf")).status;
    if (st === 429) { hit = i; break; }
    if (i % 3 === 0) await login("neto", "senha-neto", "dev-neto");
  }
  check("bloqueio por usuário mesmo com logins válidos de outra conta", hit > 0 && hit <= 11, "tentativa " + hit);
  r = await login("neto", "senha-neto", "dev-neto2");
  check("bloqueio do admin não tranca os outros usuários", r.status === 200, String(r.status));

  console.log(results.join("\n"));
  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
