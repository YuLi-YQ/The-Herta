/** One warning for a direct permission change or a plan exit restoring full access. */
export function FullAccessConfirmation({
  onConfirm,
  onCancel,
  disabled = false,
}: {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <section className="herta-permission-confirm" aria-label="完全访问确认">
      <p>
        完全访问允许当前系统用户权限下的项目内外文件、命令与网络操作，取消逐项工具审批。不自动提权；不是操作系统沙箱。应用自身的凭据、记录和权限控制仍受保护。升级不会自动执行待审操作。
      </p>
      <div className="herta-actions">
        <button type="button" disabled={disabled} onClick={onConfirm}>
          确认完全访问
        </button>
        <button type="button" disabled={disabled} onClick={onCancel}>
          取消切换
        </button>
      </div>
    </section>
  );
}
