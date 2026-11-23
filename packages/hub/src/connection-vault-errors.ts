export type ConnectionVaultErrorCode =
  | "connection_vault_unavailable"
  | "connection_vault_locked"
  | "connection_vault_key_missing"
  | "connection_vault_corrupt"
  | "connection_vault_io"
  | "connection_vault_invalid_input"
  | "connection_vault_busy";

export interface ConnectionVaultKeyStore {
  /** `create=false` must never replace a missing master key for an existing vault. */
  getOrCreateKey(namespace: string, create?: boolean): Promise<Buffer>;
  checkAvailability?(): Promise<void>;
  /** Optional mutex wrapper for multi-step key initialization (e.g., cluster sync keypair creation). */
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>;
}

const ERROR_MESSAGES: Record<ConnectionVaultErrorCode, string> = {
  connection_vault_unavailable: "本机安全凭证存储不可用。",
  connection_vault_locked: "系统密钥库已锁定或未授权，请解锁后重试。",
  connection_vault_key_missing: "本地凭证主密钥不可用，请恢复系统密钥库。",
  connection_vault_corrupt: "本地凭证库校验失败，未读取或覆盖凭据。",
  connection_vault_io: "无法访问本地凭证库，请检查目录权限和磁盘状态。",
  connection_vault_invalid_input: "凭证内容无效。",
  connection_vault_busy: "本地凭证库正被其他进程使用，请稍后重试。",
};

export class ConnectionVaultError extends Error {
  constructor(readonly code: ConnectionVaultErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ConnectionVaultError";
  }
}
