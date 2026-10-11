import { PRODUCT_PROFILE } from "../../../shared/product-profile.js";
import { useT } from "../../i18n/LocaleProvider.js";

/** R1 capability disclosure; it does not stand in for Provider management. */
export function BaselineSettings(): JSX.Element {
  const t = useT();
  return (
    <div className="atelier-baseline-details" data-testid="baseline-settings">
      <p className="settings-intro">
        {PRODUCT_PROFILE.name} · {t("baseline.round")}
      </p>
      <p>{t("baseline.offline")}</p>
      <p>{t("baseline.providerPending")}</p>
      <p>{t("baseline.legacy")}</p>
      <p>{t("baseline.optionalDisabled")}</p>
      <p>{t("baseline.artPending")}</p>
    </div>
  );
}
