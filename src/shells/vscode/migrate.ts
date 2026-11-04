import * as vscode from 'vscode';
import * as path from 'node:path';
import { PersistedSettings } from '../../core/config';
import { normalizeProviders } from '../../core/model/providers';
import { FileConfigStore, FileSecretStore } from '../../core/stores';

const SETTING_KEYS = [
  'providers', 'models', 'model', 'tierModels', 'taskTiers',
  'contextWindow', 'maxOutputTokens', 'temperature',
  'chaptersDir', 'draftsDir',
  'summaryBatchSize', 'requestTimeoutMs', 'concurrency', 'fallbackAttempts',
];

/** 0.1.x 的单服务商键，供 config.ts 的 seedFromLegacyRaw 消费。 */
const LEGACY_KEYS = [
  'provider', 'openai.baseUrl', 'openai.model',
  'anthropic.baseUrl', 'anthropic.model', 'vscodeLm.family',
];

/**
 * settings.json 的读取器，在 ~/.novelwarden/config.json 尚不可用时兜底
 *（未迁移、被删、或内容损坏——FileConfigStore.read 对坏 JSON 返回 undefined）。
 *
 * 必须连**新结构**的键一起读，不能只读 0.1.x 的单服务商键：
 * 用户在 settings.json 里配好的 novel.providers 否则会被整份丢掉，
 * readConfig 只剩 0.1.x 默认值可兜底（novel.openai.model 声明了默认值
 * "gpt-4o"，cfg.get 永远拿得到值），于是界面报「服务商下没有模型」，
 * 而那个模型明明就在设置里躺着。
 */
export const legacySettingsReader = {
  read(): PersistedSettings {
    const cfg = vscode.workspace.getConfiguration('novel');
    const out: Record<string, unknown> = {};
    for (const key of [...SETTING_KEYS, ...LEGACY_KEYS]) {
      const value = cfg.get(key);
      if (value !== undefined) {
        out[key] = value;
      }
    }
    return out as PersistedSettings;
  },
};

/**
 * 一次性迁移：settings.json 的 novel.* + SecretStorage → ~/.novelwarden/。
 * 已迁移过（config.json 存在）则跳过。迁移成功后不删旧配置，
 * 只在 VS Code 里提示「可清理」，避免用户回滚时丢东西。
 * 返回是否真的执行了迁移。
 */
export async function migrateVscodeSettings(secrets: vscode.SecretStorage): Promise<boolean> {
  const store = new FileConfigStore();
  if (store.read()) {
    return false;
  }

  const cfg = vscode.workspace.getConfiguration('novel');
  const settings: PersistedSettings = {};
  for (const k of SETTING_KEYS) {
    const v = cfg.get(k);
    if (v !== undefined) {
      (settings as Record<string, unknown>)[k] = v;
    }
  }
  // 没配过新结构：把遗留单服务商键一并搬过去（seedFromLegacyRaw 会消费带点键）。
  if ((settings.providers ?? []).length === 0 && !settings.model) {
    const legacy = legacySettingsReader.read();
    Object.assign(settings, legacy as Record<string, unknown>);
  }
  if (Object.keys(settings).length === 0) {
    return false;
  }
  await store.write(settings);

  // SecretStorage → ~/.novelwarden/secrets.json。这里沿用旧的 `novel-forge.apiKey.*` 键名，
  // 因为老用户的 Key 都存在这个前缀下；前缀若换新，registry 必须同时保留旧键的 fallback。
  const secretStore = new FileSecretStore();
  const ids = new Set<string>(normalizeProviders(settings.providers ?? []).map((p) => p.id));
  ids.add('openai');
  ids.add('anthropic');
  for (const id of ids) {
    const key = `novel-forge.apiKey.provider.${id}`;
    if (!(await secretStore.get(key))) {
      const v = await secrets.get(key);
      if (v) {
        await secretStore.set(key, v);
      }
    }
  }
  for (const legacyKey of ['novel-forge.apiKey.openai', 'novel-forge.apiKey.anthropic']) {
    if (!(await secretStore.get(legacyKey))) {
      const v = await secrets.get(legacyKey);
      if (v) {
        await secretStore.set(legacyKey, v);
      }
    }
  }

  // 提示里的目录以实际落点为准：旧 ~/.novelforge/ 还活着时 FileConfigStore 就落在那里，
  // 写死 ~/.novelwarden/ 会指错地方。
  const configDir = path.dirname(store.filePath);
  void vscode.window.showInformationMessage(
    `Novelwarden：配置与密钥已迁移到 ${configDir}，VS Code 内的旧配置可手动清理。`
  );
  return true;
}
