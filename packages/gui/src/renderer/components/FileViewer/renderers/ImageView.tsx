import { useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import { imageMimeFor, useBlobUrl } from "./blob-url.js";

/**
 * A picture in the panel (ADR 0054 §4): drawn through <img> from a blob:
 * URL — SVG included, where an image element runs no script. Fit to the
 * panel by default; a click toggles 1:1 (the lightbox keeps its richer
 * zoom pill; the panel is the quick look).
 */
export function ImageView({
  bytes,
  path,
}: {
  readonly bytes: Uint8Array;
  readonly path: string;
}): JSX.Element {
  const t = useT();
  const url = useBlobUrl(bytes, imageMimeFor(path));
  const [actual, setActual] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="file-viewer__body">
      <div
        className={`file-viewer__scroll file-viewer__image-wrap${actual ? " is-actual" : ""}`}
      >
        {url !== null && (
          <button
            type="button"
            className="file-viewer__image-btn"
            aria-label={actual ? t("viewer.imageFit") : t("viewer.imageActual")}
            onClick={() => setActual((a) => !a)}
          >
            <img
              className="file-viewer__image"
              src={url}
              alt={name}
              onLoad={(e) => {
                const img = e.currentTarget;
                setDims({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />
          </button>
        )}
      </div>
      {dims !== null && (
        <p className="file-viewer__notice file-viewer__image-meta">
          {dims.w} × {dims.h}
        </p>
      )}
    </div>
  );
}
