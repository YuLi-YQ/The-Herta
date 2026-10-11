import referenceHtml from "./reference/UX_v5.html?url";

export function ReferenceView(): JSX.Element {
  return (
    <iframe
      title="Reference UX preview"
      src={referenceHtml}
      style={{ width: "100vw", height: "100vh", border: 0 }}
    />
  );
}
