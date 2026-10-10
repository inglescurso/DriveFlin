// Configuração persistente no Cloudflare KV (binding DRIVEFLIN_KV).
//
// Mesmo modelo do veroroute-edge: o deploy pede o mínimo possível e as credenciais
// (Google Drive, TMDB, rclone) são digitadas em /setup e ficam no KV, sobrevivendo a
// redeploys e a "Sync fork". Variáveis/secrets do Worker continuam funcionando como
// fallback para quem já as usa, mas o KV tem prioridade.
//
//   Prioridade de cada campo:  KV (/setup)  →  variável do Worker (env)  →  vazio
//
// O restante do código não precisa saber disso: o entrypoint (fetch/scheduled) chama
// `withConfig(env)` e passa adiante um env "efetivo" já com os valores do KV por cima.

export const KV_CONFIG_KEY = "config";
const CACHE_TTL_MS = 5000;

/** campo da config  →  nome da variável de ambiente equivalente */
export const CONFIG_FIELDS = {
  gdriveClientId: "GDRIVE_CLIENT_ID",
  gdriveClientSecret: "GDRIVE_CLIENT_SECRET",
  gdriveRefreshToken: "GDRIVE_REFRESH_TOKEN",
  gdriveTeamDriveId: "GDRIVE_TEAM_DRIVE_ID",
  tmdbApiKey: "TMDB_API_KEY",
  rclonePass: "RCLONE_PASS",
  rcloneSalt: "RCLONE_SALT",
} as const;

export type ConfigField = keyof typeof CONFIG_FIELDS;
export type StoredConfig = Partial<Record<ConfigField, string>> & { _seq?: number; updatedAt?: string };
export type ConfigSource = "kv" | "env" | "none";

/** Campos que nunca podem voltar inteiros em nenhuma resposta. */
const SECRET_FIELDS: ConfigField[] = ["gdriveClientSecret", "gdriveRefreshToken", "tmdbApiKey", "rclonePass", "rcloneSalt"];

let cache: { value: StoredConfig; exp: number } | null = null;

export function hasKV(env: any): boolean {
  return !!env?.DRIVEFLIN_KV && typeof env.DRIVEFLIN_KV.get === "function";
}

export async function readStoredConfig(env: any): Promise<StoredConfig> {
  if (!hasKV(env)) return {};
  if (cache && Date.now() < cache.exp) return cache.value;
  let value: StoredConfig = {};
  try {
    const raw = await env.DRIVEFLIN_KV.get(KV_CONFIG_KEY);
    if (raw) value = JSON.parse(raw) as StoredConfig;
  } catch (e) {
    console.error("[config] falha ao ler o KV:", (e as any)?.message || e);
    // Em erro transitório do KV mantém o último valor bom, se houver.
    if (cache) return cache.value;
  }
  cache = { value, exp: Date.now() + CACHE_TTL_MS };
  return value;
}

/**
 * Atualiza a configuração. Para cada campo: string não vazia = grava; `null` = apaga;
 * `undefined`/"" = mantém o valor atual. Lança erro se o KV não estiver vinculado.
 */
export async function saveStoredConfig(env: any, patch: Partial<Record<ConfigField, string | null | undefined>>): Promise<StoredConfig> {
  if (!hasKV(env)) {
    throw new Error("KV não vinculado: o binding DRIVEFLIN_KV não existe neste Worker.");
  }
  // Lê direto do KV (sem cache) para não sobrescrever uma alteração recente.
  let current: StoredConfig = {};
  try {
    const raw = await env.DRIVEFLIN_KV.get(KV_CONFIG_KEY);
    if (raw) current = JSON.parse(raw) as StoredConfig;
  } catch {
    current = {};
  }
  const next: StoredConfig = { ...current };
  for (const field of Object.keys(CONFIG_FIELDS) as ConfigField[]) {
    const v = patch[field];
    if (v === null) delete next[field];
    else if (typeof v === "string" && v.trim() !== "") next[field] = v.trim();
  }
  next._seq = (current._seq || 0) + 1;
  next.updatedAt = new Date().toISOString();
  await env.DRIVEFLIN_KV.put(KV_CONFIG_KEY, JSON.stringify(next));
  cache = { value: next, exp: Date.now() + CACHE_TTL_MS };
  return next;
}

/** Descarta o cache em memória (usado nos testes). */
export function resetConfigCache() {
  cache = null;
}

/**
 * Devolve um env efetivo: os campos configurados no KV substituem os do Worker.
 * `CONFIG_SOURCES` diz de onde veio cada valor (para a tela /setup).
 */
export async function withConfig<T extends Record<string, any>>(env: T): Promise<T & { CONFIG_SOURCES: Record<ConfigField, ConfigSource> }> {
  const stored = await readStoredConfig(env);
  const eff: any = { ...env };
  const sources = {} as Record<ConfigField, ConfigSource>;
  for (const [field, envName] of Object.entries(CONFIG_FIELDS) as [ConfigField, string][]) {
    const fromKv = String(stored[field] || "").trim();
    const fromEnv = String((env as any)?.[envName] || "").trim();
    if (fromKv) {
      eff[envName] = fromKv;
      sources[field] = "kv";
    } else if (fromEnv) {
      eff[envName] = fromEnv;
      sources[field] = "env";
    } else {
      eff[envName] = "";
      sources[field] = "none";
    }
  }
  eff.CONFIG_SOURCES = sources;
  return eff;
}

/** Máscara para exibição: nunca devolve o valor completo. */
export function maskValue(field: ConfigField, value: string | undefined): string {
  const v = String(value || "");
  if (!v) return "";
  if (SECRET_FIELDS.includes(field)) return v.length > 8 ? "••••" + v.slice(-4) : "••••";
  // Não-secretos (Client ID, Team Drive): mostra início e fim.
  return v.length > 12 ? v.slice(0, 6) + "…" + v.slice(-6) : v;
}

/** Visão segura da config efetiva, para a tela /setup e para JSON. */
export function describeConfig(effEnv: any): Record<ConfigField, { configured: boolean; source: ConfigSource; masked: string }> {
  const out = {} as Record<ConfigField, { configured: boolean; source: ConfigSource; masked: string }>;
  const sources: Record<ConfigField, ConfigSource> = effEnv?.CONFIG_SOURCES || ({} as any);
  for (const [field, envName] of Object.entries(CONFIG_FIELDS) as [ConfigField, string][]) {
    const v = String(effEnv?.[envName] || "");
    out[field] = { configured: !!v, source: sources[field] || (v ? "env" : "none"), masked: maskValue(field, v) };
  }
  return out;
}
