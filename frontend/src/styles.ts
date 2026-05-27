// Shared style constants. Tap targets are sized for ≥44pt touch areas.

export const textareaStyle = {
  font: "inherit",
  padding: "0.6rem 0.7rem",
  borderRadius: 8,
  border: "1px solid color-mix(in srgb, CanvasText 20%, Canvas)",
  background: "Canvas",
  color: "CanvasText",
  resize: "vertical" as const,
  width: "100%",
  boxSizing: "border-box" as const,
  minHeight: 44,
};

export const buttonStyle = {
  font: "inherit",
  padding: "0.7rem 1.1rem",
  borderRadius: 8,
  border: "none",
  background: "dodgerblue",
  color: "white",
  cursor: "pointer",
  minHeight: 44,
  minWidth: 44,
} as const;

export const ghostButtonStyle = {
  ...buttonStyle,
  background: "transparent",
  color: "CanvasText",
} as const;

export const sectionTitle = {
  margin: 0,
  fontSize: "0.8rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "color-mix(in srgb, CanvasText 60%, Canvas)",
};

export const muted = {
  color: "color-mix(in srgb, CanvasText 50%, Canvas)",
  fontSize: "0.85rem",
} as const;

export const errBox = {
  background: "color-mix(in srgb, crimson 12%, Canvas)",
  color: "crimson",
  padding: "0.5rem 0.75rem",
  borderRadius: 6,
  fontSize: "0.85rem",
} as const;
