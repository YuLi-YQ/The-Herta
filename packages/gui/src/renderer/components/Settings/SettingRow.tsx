import type { ReactNode } from "react";

export interface SettingRowProps {
  readonly title: string;
  /** Plain text, or text with an emphasized span (a host name, say). */
  readonly description: ReactNode;
  /** The control (e.g. a Toggle) shown at the row's trailing edge. */
  readonly control: ReactNode;
}

/** One setting: a title + description on the left, a control on the right.
 *  Shared layout for every Settings section. */
export function SettingRow({
  title,
  description,
  control,
}: SettingRowProps): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <p className="settings-row-title">{title}</p>
        <p className="settings-row-desc">{description}</p>
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}
