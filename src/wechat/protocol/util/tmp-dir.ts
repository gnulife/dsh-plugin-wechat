/* Vendor'd from @tencent-weixin/openclaw-weixin (C) 2026 Tencent, MIT. */
/* NEW local helper: dropped-in replacement for openclaw/plugin-sdk/infra-runtime's
 * resolvePreferredOpenClawTmpDir(). Keeps the log writing in a stable tmp location
 * without importing the openclaw runtime. */
import os from "node:os";
import path from "node:path";

/**
 * Resolve a stable temp directory for DSH plugin logs.
 * Honors OPENCLAW_TMP_DIR when set (backward compat), else falls back to
 * `<os.tmpdir()>/dsh-plugin-wechat`.
 */
export function resolvePreferredOpenClawTmpDir(): string {
  const envTmp = process.env.OPENCLAW_TMP_DIR?.trim();
  if (envTmp) return envTmp;
  return path.join(os.tmpdir(), "dsh-plugin-wechat");
}
